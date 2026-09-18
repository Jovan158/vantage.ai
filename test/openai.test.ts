// Proves the multi-provider thesis: an OpenAI-format response parses into the
// SAME TurnContent shape the Anthropic path produces, so meter/replay/policy
// work unchanged for Codex CLI, Aider, and other OpenAI-compatible agents.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAITurnExtractor, extractOpenAITurnFromJson } from "../src/providers/openai.ts";
import { getProvider } from "../src/providers/index.ts";
import { summarizeActions } from "../src/policy.ts";
import { startProxy } from "../src/proxy.ts";
import type { UsageEvent } from "../src/events.ts";

function frame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

test("OpenAI SSE extractor collects text, tool calls, finish reason, usage", () => {
  const ex = createOpenAITurnExtractor();
  ex.feed(frame({ model: "gpt-4o", choices: [{ delta: { content: "Creating " } }] }));
  ex.feed(frame({ model: "gpt-4o", choices: [{ delta: { content: "the file." } }] }));
  // tool call streamed as partial JSON arguments across chunks
  ex.feed(frame({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "write_file", arguments: '{"path":"gree' } }] } }],
  }));
  ex.feed(frame({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ting.txt"}' } }] } }],
  }));
  ex.feed(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
  ex.feed(frame({ usage: { prompt_tokens: 120, completion_tokens: 34, prompt_tokens_details: { cached_tokens: 100 } } }));
  ex.feed("data: [DONE]\n\n");

  const t = ex.end();
  assert.equal(t.model, "gpt-4o");
  assert.equal(t.text, "Creating the file.");
  assert.equal(t.stopReason, "tool_calls");
  assert.equal(t.usage.input_tokens, 120);
  assert.equal(t.usage.output_tokens, 34);
  assert.equal(t.usage.cache_read_input_tokens, 100);
  assert.equal(t.tools.length, 1);
  assert.equal(t.tools[0]!.name, "write_file");
  assert.match(t.tools[0]!.inputPreview, /greeting\.txt/);
});

test("OpenAI JSON extractor reads message content, tool calls and usage", () => {
  const t = extractOpenAITurnFromJson(JSON.stringify({
    model: "gpt-4.1",
    usage: { prompt_tokens: 7, completion_tokens: 3 },
    choices: [{
      finish_reason: "stop",
      message: { content: "Done.", tool_calls: [{ function: { name: "bash", arguments: '{"cmd":"ls"}' } }] },
    }],
  }));
  assert.ok(t);
  assert.equal(t!.model, "gpt-4.1");
  assert.equal(t!.text, "Done.");
  assert.equal(t!.stopReason, "stop");
  assert.equal(t!.usage.input_tokens, 7);
  assert.equal(t!.tools[0]!.name, "bash");
});

test("OpenAI previews are redacted like the Anthropic path", () => {
  const t = extractOpenAITurnFromJson(JSON.stringify({
    model: "gpt-4o",
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    choices: [{ message: { content: "ping me at dev@example.org" } }],
  }));
  assert.match(t!.text, /\[email\]/);
  assert.doesNotMatch(t!.text, /dev@example\.org/);
});

test("provider registry routes paths per provider", () => {
  const anthropic = getProvider("anthropic");
  const openai = getProvider("openai");
  assert.equal(anthropic.isObservablePath("/v1/messages?beta=true"), true);
  assert.equal(anthropic.isObservablePath("/v1/chat/completions"), false);
  assert.equal(openai.isObservablePath("/v1/chat/completions"), true);
  assert.equal(openai.isObservablePath("/v1/messages"), false);
});

// Full chain: client -> vantage proxy (provider: openai) -> mock OpenAI SSE.
// Same transparency + metering guarantees as the Anthropic path.
test("full proxy chain works against an OpenAI-format upstream", async () => {
  const frames = [
    frame({ model: "gpt-4o", choices: [{ delta: { content: "Hallo" } }] }),
    frame({ model: "gpt-4o", choices: [{ delta: { content: ", Welt!" } }] }),
    frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    frame({ usage: { prompt_tokens: 200, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 150 } } }),
    "data: [DONE]\n\n",
  ];
  const fullBody = Buffer.from(frames.join(""), "utf8");

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
    let i = 0;
    const tick = (): void => {
      if (i >= frames.length) return void res.end();
      res.write(frames[i++]);
      setTimeout(tick, 2);
    };
    tick();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  let usage: UsageEvent | null = null;
  const proxy = await startProxy({
    upstream: `http://127.0.0.1:${upstreamPort}`,
    provider: "openai",
    onUsage: (e) => {
      usage = e;
    },
  });

  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const req = http.request(
      proxy.url + "/v1/chat/completions",
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "say hi" }] }));
  });

  // 1. byte-for-byte transparency holds for the second provider too
  assert.ok(body.equals(fullBody), "client bytes must equal upstream bytes");

  // 2. usage is metered from the OpenAI format
  const u = usage as unknown as UsageEvent;
  assert.ok(u, "a usage event must be emitted");
  assert.equal(u.model, "gpt-4o");
  assert.equal(u.in, 200);
  assert.equal(u.out, 12);
  assert.equal(u.cache_read, 150);
  assert.ok(u.cost_usd > 0, "cost estimated from the OpenAI price table");

  // 3. content capture works: prompt from the request, reply from the stream
  assert.equal(u.prompt, "say hi");
  assert.equal(u.text, "Hallo, Welt!");
  assert.equal(u.stopReason, "stop");

  await proxy.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

test("downstream layers work unchanged on OpenAI tool names", () => {
  // Policy classification is provider-agnostic — it operates on tool names.
  const counts = summarizeActions(["write_file", "bash", "web_fetch"]);
  assert.equal(counts.write, 1);
  assert.equal(counts.shell, 1);
  assert.equal(counts.network, 1);
});
