// Unit tests for usage extraction, both streaming (SSE) and non-streaming JSON.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createUsageExtractor, extractUsageFromJson } from "../src/usage.ts";

test("SSE extractor reads usage from message_start + message_delta", () => {
  const ex = createUsageExtractor();
  ex.feed(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 10, cache_read_input_tokens: 200, output_tokens: 1 },
      },
    })}\n\n`
  );
  ex.feed(
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 42 },
    })}\n\n`
  );
  const u = ex.end();
  assert.equal(u.model, "claude-opus-5");
  assert.equal(u.input_tokens, 10);
  assert.equal(u.output_tokens, 42);
  assert.equal(u.cache_read_input_tokens, 200);
});

test("SSE extractor tolerates frames split across chunks", () => {
  const ex = createUsageExtractor();
  const frame = `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: { model: "claude-sonnet-5", usage: { input_tokens: 7, output_tokens: 1 } },
  })}\n\n`;
  const mid = Math.floor(frame.length / 2);
  ex.feed(frame.slice(0, mid));
  ex.feed(frame.slice(mid));
  assert.equal(ex.end().input_tokens, 7);
});

test("JSON extractor reads usage from a non-streaming Messages response", () => {
  const body = JSON.stringify({
    model: "claude-haiku-4-5",
    usage: {
      input_tokens: 5,
      output_tokens: 9,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    },
  });
  const u = extractUsageFromJson(body);
  assert.ok(u);
  assert.equal(u!.model, "claude-haiku-4-5");
  assert.equal(u!.input_tokens, 5);
  assert.equal(u!.output_tokens, 9);
  assert.equal(u!.cache_read_input_tokens, 100);
  assert.equal(u!.cache_creation_input_tokens, 20);
});

test("JSON extractor returns null when there is no usage block", () => {
  assert.equal(extractUsageFromJson(JSON.stringify({ type: "error" })), null);
  assert.equal(extractUsageFromJson("not json"), null);
});
