// Tests for assisted memory harvest — material prepared for a human, never
// written automatically.

import { test } from "node:test";
import assert from "node:assert/strict";
import { collectHarvest, renderHarvest, worthHarvesting } from "../src/harvest.ts";
import type { VantageEvent } from "../src/events.ts";

const usage = (over: Partial<Extract<VantageEvent, { type: "usage" }>> = {}): VantageEvent => ({
  ts: "2026-09-18T09:00:01.000Z",
  type: "usage",
  path: "/v1/messages",
  model: "claude-sonnet-5",
  in: 10,
  out: 20,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 0.01,
  ...over,
});

const events: VantageEvent[] = [
  { ts: "2026-09-18T09:00:00.000Z", type: "session_start", agent: "claude-code" },
  usage({ tools: ["Read", "Edit"], text: "I'll add exponential backoff to the fetch helper." }),
  // The agent's internal JSON state blob must not be mistaken for a summary.
  usage({ ts: "2026-09-18T09:00:05.000Z", text: '{"state":"done","detail":"…"}' }),
  { ts: "2026-09-18T09:00:06.000Z", type: "session_end", exitCode: 0 },
];

test("collect picks the agent's prose closing reply, not its JSON state blob", () => {
  const h = collectHarvest("s1", events, ["src/fetch.ts"]);
  assert.equal(h.closingReply, "I'll add exponential backoff to the fetch helper.");
  assert.equal(h.turns, 2);
  assert.equal(h.actions, "read×1 · write×1");
  assert.deepEqual(h.files, ["src/fetch.ts"]);
});

test("render offers a ready-to-run command and writes nothing itself", () => {
  const out = renderHarvest(collectHarvest("s1", events, ["src/fetch.ts"]), false);
  assert.match(out, /what the agent said it did/);
  assert.match(out, /exponential backoff/);
  assert.match(out, /files changed/);
  assert.match(out, /src\/fetch\.ts/);
  assert.match(out, /Nothing is written automatically/);
  assert.match(out, /vantage memory add decisions "I'll add exponential backoff/);
  assert.doesNotMatch(out, /\x1b\[/);
});

test("quotes are escaped so the suggested command stays valid", () => {
  const withQuote: VantageEvent[] = [usage({ text: 'Renamed "old" to "new".' })];
  const out = renderHarvest(collectHarvest("s2", withQuote), false);
  // Rendered line is: vantage memory add decisions "Renamed \"old\" to \"new\"."
  assert.match(out, /vantage memory add decisions "Renamed \\"old\\" to \\"new\\"\./);
});

test("an empty session offers a placeholder instead of pretending", () => {
  const out = renderHarvest(collectHarvest("s3", []), false);
  assert.match(out, /nothing substantial recorded/);
  assert.match(out, /vantage memory add decisions "…"/);
});

test("worthHarvesting gates the end-of-session nudge", () => {
  assert.equal(worthHarvesting([]), false);
  assert.equal(worthHarvesting([usage()]), false, "a turn with no tools is not enough");
  assert.equal(worthHarvesting([usage({ tools: ["Write"] })]), true);
  assert.equal(worthHarvesting([], 3), true, "changed files alone are enough");
});
