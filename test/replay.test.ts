// Tests for the replay timeline renderer and session summary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTimeline, summarize } from "../src/replay.ts";
import type { VantageEvent } from "../src/events.ts";

const events: VantageEvent[] = [
  { ts: "2026-09-18T09:00:00.000Z", type: "session_start", agent: "claude-code" },
  {
    ts: "2026-09-18T09:00:02.000Z",
    type: "usage",
    path: "/v1/messages",
    model: "claude-sonnet-5",
    in: 10,
    out: 130,
    cache_read: 55000,
    cache_write: 0,
    cost_usd: 0.0383,
  },
  {
    ts: "2026-09-18T09:00:03.000Z",
    type: "ratelimit",
    path: "/",
    raw: {
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.64",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.parse("2026-09-18T09:00:03.000Z") / 1000) + 3600),
    },
  },
  {
    ts: "2026-09-18T09:00:05.000Z",
    type: "usage",
    path: "/v1/messages",
    model: "claude-sonnet-5",
    in: 100,
    out: 111,
    cache_read: 66000,
    cache_write: 0,
    cost_usd: 0.0228,
  },
  { ts: "2026-09-18T09:00:06.000Z", type: "session_end", exitCode: 0 },
];

test("summarize totals usage across turns", () => {
  const s = summarize("sess", events);
  assert.equal(s.agent, "claude-code");
  assert.equal(s.requests, 2);
  assert.equal(s.output, 241);
  assert.equal(s.cacheRead, 121000);
  assert.ok(Math.abs(s.costUsd - 0.0611) < 1e-6);
  assert.equal(s.exitCode, 0);
});

test("renderTimeline shows turns, quota, and end summary (no color)", () => {
  const out = renderTimeline(events, false);
  assert.match(out, /session start/);
  assert.match(out, /turn 1 claude-sonnet-5/);
  assert.match(out, /out 130/);
  assert.match(out, /quota 5h 64% used/);
  assert.match(out, /turn 2/);
  assert.match(out, /session end .* 2 turn\(s\)/);
  assert.match(out, /exit 0/);
  // No ANSI escapes when color is disabled.
  assert.doesNotMatch(out, /\x1b\[/);
});

test("renderTimeline dedups repeated quota lines", () => {
  const dup: VantageEvent[] = [
    events[0]!,
    events[2]!,
    events[2]!, // identical quota again
  ];
  const out = renderTimeline(dup, false);
  const count = (out.match(/quota 5h/g) ?? []).length;
  assert.equal(count, 1);
});
