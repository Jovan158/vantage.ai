// The API formats other agents speak: each one read into the same turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatForPath } from "../src/formats/index.ts";
import { createResponsesExtractor, createChatExtractor, responsesRequestInfo, responsesParts, chatParts } from "../src/formats/openai.ts";
import { createGeminiExtractor, geminiTurnFromJson, geminiRequestInfo, geminiParts } from "../src/formats/gemini.ts";
import { scanParts } from "../src/secrets.ts";

const sse = (events: object[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";

// Feeds a stream in awkward pieces, as the network would.
function feedInPieces(ex: { feed(c: string): void }, text: string, size = 7): void {
  for (let i = 0; i < text.length; i += size) ex.feed(text.slice(i, i + size));
}

test("the request path tells the format; everything else is not a turn", () => {
  assert.equal(formatForPath("/v1/messages?beta=true")?.name, "anthropic");
  assert.equal(formatForPath("/v1/messages/count_tokens"), null);
  assert.equal(formatForPath("/backend-api/codex/responses")?.name, "openai-responses");
  assert.equal(formatForPath("/api/v1/chat/completions")?.name, "openai-chat");
  assert.equal(formatForPath("/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse")?.name, "gemini");
  assert.equal(formatForPath("/v1internal:streamGenerateContent?alt=sse")?.name, "gemini");
  assert.equal(formatForPath("/v1internal:generateContent")?.name, "gemini");
  assert.equal(formatForPath("/v1/models"), null);
});

test("Responses stream: text, tool calls with their targets, cached input kept apart", () => {
  const ex = createResponsesExtractor();
  feedInPieces(
    ex,
    sse([
      { type: "response.created", response: { model: "gpt-5.5" } },
      { type: "response.output_text.delta", delta: "Looking" },
      { type: "response.output_text.delta", delta: " at it." },
      { type: "response.output_item.done", item: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) } },
      { type: "response.output_item.done", item: { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch" } },
      { type: "response.output_item.done", item: { type: "local_shell_call", action: { type: "exec", command: ["bash", "-lc", "ls -la"] } } },
      {
        type: "response.completed",
        response: { model: "gpt-5.5", status: "completed", usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 } } },
      },
    ])
  );
  const t = ex.end();
  assert.equal(t.model, "gpt-5.5");
  assert.equal(t.text, "Looking at it.");
  assert.deepEqual(
    t.tools.map((c) => [c.name, c.target]),
    [
      ["exec_command", "npm test"],
      ["apply_patch", "src/a.ts"],
      ["shell", "ls -la"],
    ]
  );
  assert.deepEqual([t.usage.input_tokens, t.usage.cache_read_input_tokens, t.usage.output_tokens], [200, 800, 50]);
});

test("Responses request: the prompt, and whether it is a chat turn", () => {
  const body = {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "fix the tests" }] },
    ],
    tools: [{ type: "function", name: "exec_command" }],
  };
  assert.deepEqual(responsesRequestInfo(body), { prompt: "fix the tests", background: false });
  // Codex lists its tools as an input item; a continuation lists none.
  assert.equal(responsesRequestInfo({ input: [{ type: "additional_tools", tools: [{ name: "exec" }] }] }).background, false);
  assert.equal(responsesRequestInfo({ previous_response_id: "resp_1", input: [] }).background, false);
  assert.equal(responsesRequestInfo({ input: "title this" }).background, true);
});

test("secrets in a Responses conversation are traced to the call that read them", () => {
  const secret = "ghp_" + "a".repeat(36);
  const body = {
    input: [
      { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "cat .env" }) },
      { type: "function_call_output", call_id: "c1", output: `TOKEN=${secret}` },
    ],
  };
  const found = scanParts(responsesParts(body, "Codex"));
  assert.deepEqual(found.map((f) => `${f.kind} <- ${f.source}`), ["GitHub token <- the output of exec_command cat .env"]);
});

test("Chat Completions stream: tool call arguments arrive in pieces", () => {
  const ex = createChatExtractor();
  feedInPieces(
    ex,
    sse([
      { model: "deepseek-chat", choices: [{ delta: { content: "Sure" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: '{"comm' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"git status"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 300, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 100 } } },
    ])
  );
  const t = ex.end();
  assert.equal(t.text, "Sure");
  assert.equal(t.stopReason, "tool_calls");
  assert.deepEqual(t.tools.map((c) => [c.name, c.target]), [["bash", "git status"]]);
  assert.deepEqual([t.usage.input_tokens, t.usage.cache_read_input_tokens, t.usage.output_tokens], [200, 100, 12]);
});

test("Chat Completions conversation: tool output is named after its call", () => {
  const key = "sk-proj-" + "B".repeat(40);
  const parts = chatParts(
    {
      messages: [
        { role: "user", content: "check the config" },
        { role: "assistant", tool_calls: [{ id: "t1", function: { name: "read", arguments: JSON.stringify({ filePath: "config/.env" }) } }] },
        { role: "tool", tool_call_id: "t1", content: `OPENAI=${key}` },
      ],
    },
    "OpenCode"
  );
  assert.deepEqual(scanParts(parts).map((f) => f.source), ["the output of read config/.env"]);
});

test("Gemini stream: cumulative usage, thoughts billed as output, function calls", () => {
  const ex = createGeminiExtractor("/v1beta/models/gemini-3-pro:streamGenerateContent");
  feedInPieces(
    ex,
    sse([
      { candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: "Let me " }] } }], usageMetadata: { promptTokenCount: 900 } },
      { candidates: [{ content: { parts: [{ text: "look." }, { functionCall: { name: "read_file", args: { path: "/p/src/a.ts" } } }] }, finishReason: "STOP" }] },
      { usageMetadata: { promptTokenCount: 900, cachedContentTokenCount: 600, candidatesTokenCount: 40, thoughtsTokenCount: 10 } },
    ])
  );
  const t = ex.end();
  assert.equal(t.model, "gemini-3-pro", "from the path when the stream names none");
  assert.equal(t.text, "Let me look.");
  assert.deepEqual(t.tools.map((c) => [c.name, c.target]), [["read_file", "/p/src/a.ts"]]);
  assert.deepEqual([t.usage.input_tokens, t.usage.cache_read_input_tokens, t.usage.output_tokens], [300, 600, 50]);
});

test("Code Assist wraps the same request and responses", () => {
  const t = geminiTurnFromJson(JSON.stringify([{ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 }, modelVersion: "gemini-3-flash" } }]));
  assert.equal(t?.model, "gemini-3-flash");
  assert.equal(t?.text, "ok");
  const body = { model: "gemini-3-flash", request: { contents: [{ role: "user", parts: [{ text: "<session_context>setup</session_context>" }, { text: "add a test" }] }], tools: [{ functionDeclarations: [] }] } };
  assert.deepEqual(geminiRequestInfo(body), { prompt: "add a test", background: false });
  assert.equal(geminiParts(body, "Gemini").some((p) => p.text === "add a test"), true);
});
