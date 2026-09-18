// Tests for turn content extraction (streaming SSE, JSON, and request prompt).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnExtractor, extractTurnFromJson, extractUserPrompt } from "../src/turn.ts";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

test("SSE turn extractor collects text, tools, stop reason, usage", () => {
  const ex = createTurnExtractor();
  ex.feed(frame("message_start", {
    type: "message_start",
    message: { model: "claude-sonnet-5", usage: { input_tokens: 12, output_tokens: 1 } },
  }));
  ex.feed(frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  ex.feed(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Creating " } }));
  ex.feed(frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the file." } }));
  ex.feed(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
  // tool call streamed as partial JSON
  ex.feed(frame("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "write_file" } }));
  ex.feed(frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"green' } }));
  ex.feed(frame("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'ing.txt"}' } }));
  ex.feed(frame("content_block_stop", { type: "content_block_stop", index: 1 }));
  ex.feed(frame("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 25 } }));

  const t = ex.end();
  assert.equal(t.model, "claude-sonnet-5");
  assert.equal(t.text, "Creating the file.");
  assert.equal(t.stopReason, "tool_use");
  assert.equal(t.usage.input_tokens, 12);
  assert.equal(t.usage.output_tokens, 25);
  assert.equal(t.tools.length, 1);
  assert.equal(t.tools[0]!.name, "write_file");
  assert.match(t.tools[0]!.inputPreview, /greening\.txt/);
});

test("JSON turn extractor reads content + usage", () => {
  const t = extractTurnFromJson(JSON.stringify({
    model: "claude-opus-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 9 },
    content: [
      { type: "text", text: "Done." },
      { type: "tool_use", name: "bash", input: { command: "ls" } },
    ],
  }));
  assert.ok(t);
  assert.equal(t!.text, "Done.");
  assert.equal(t!.tools[0]!.name, "bash");
  assert.equal(t!.usage.output_tokens, 9);
});

test("previews redact emails, api keys, and bearer tokens", () => {
  const t = extractTurnFromJson(JSON.stringify({
    model: "claude-sonnet-5",
    usage: { input_tokens: 1, output_tokens: 1 },
    content: [{ type: "text", text: "mail me at jane.doe@example.com or use sk-ant-abcdef0123456789ABCDEF" }],
  }));
  assert.ok(t);
  assert.doesNotMatch(t!.text, /jane\.doe@example\.com/);
  assert.doesNotMatch(t!.text, /sk-ant-abcdef/);
  assert.match(t!.text, /\[email\]/);
  assert.match(t!.text, /\[key\]/);

  const prompt = extractUserPrompt(JSON.stringify({
    messages: [{ role: "user", content: "contact: someone@test.io" }],
  }));
  assert.equal(prompt, "contact: [email]");
});

test("extractUserPrompt returns the last user message (string or blocks)", () => {
  assert.equal(
    extractUserPrompt(JSON.stringify({ messages: [{ role: "user", content: "hello there" }] })),
    "hello there"
  );
  assert.equal(
    extractUserPrompt(JSON.stringify({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "hi" },
        { role: "user", content: [{ type: "text", text: "second" }] },
      ],
    })),
    "second"
  );
  assert.equal(extractUserPrompt("not json"), null);
});
