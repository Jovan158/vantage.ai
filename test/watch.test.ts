// Tests for the live watch view (rendered in a second terminal, never over the
// agent's own TUI).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderLive, newestSessionId, readSessionEvents } from "../src/watch.ts";
import type { VantageEvent } from "../src/events.ts";

const T0 = "2026-09-18T09:00:00.000Z";
const t = (secs: number): string => new Date(Date.parse(T0) + secs * 1000).toISOString();
const NOW = Date.parse(T0) + 30_000;

const running: VantageEvent[] = [
  { ts: t(0), type: "session_start", agent: "claude-code" },
  {
    ts: t(2),
    type: "ratelimit",
    path: "/",
    raw: {
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": String(Math.floor(NOW / 1000) + 7200),
    },
  },
  {
    ts: t(3),
    type: "usage",
    path: "/v1/messages",
    model: "claude-sonnet-5",
    in: 10,
    out: 120,
    cache_read: 50_000,
    cache_write: 2_000,
    cost_usd: 0.031,
    prompt: "add a retry to the fetch helper",
    text: "I'll add exponential backoff.",
    tools: ["Read", "Edit"],
  },
];

test("live view shows state, totals, quota, actions and the latest turn", () => {
  const out = renderLive(running, { sessionId: "sess-1", nowMs: NOW, color: false });
  assert.match(out, /vantage · claude-code · running/);
  assert.match(out, /sess-1/);
  assert.match(out, /turns\s+1/);
  assert.match(out, /out 120/);
  assert.match(out, /cache 50kr\/2\.0kw/);
  assert.match(out, /~\$0\.0310/);
  assert.match(out, /quota 5h 42% used/);
  assert.match(out, /actions read×1 · write×1/);
  assert.match(out, /latest turn claude-sonnet-5/);
  assert.match(out, /add a retry to the fetch helper/);
  assert.match(out, /exponential backoff/);
  assert.match(out, /tools\s+Read, Edit/);
  assert.match(out, /watching…/);
  assert.doesNotMatch(out, /\x1b\[/, "no ANSI when color is off");
});

test("live view reports a finished session with its exit code", () => {
  const ended: VantageEvent[] = [...running, { ts: t(10), type: "session_end", exitCode: 0 }];
  const out = renderLive(ended, { sessionId: "sess-1", nowMs: NOW, color: false });
  assert.match(out, /ended \(exit 0\)/);
  assert.match(out, /session finished/);
  assert.doesNotMatch(out, /watching…/);
});

test("newestSessionId picks the latest and readSessionEvents parses the log", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-watch-"));
  const mk = (id: string, events: VantageEvent[]): void => {
    const dir = path.join(cwd, ".vantage", "sessions", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  };
  assert.equal(newestSessionId(cwd), null, "no sessions yet");

  // Ids are timestamp-prefixed, so lexicographic order is chronological.
  mk("2026-09-18T09-00-00-000Z_aaaa", [running[0]!]);
  mk("2026-09-18T11-00-00-000Z_bbbb", [running[0]!, running[2]!]);
  assert.equal(newestSessionId(cwd), "2026-09-18T11-00-00-000Z_bbbb");

  const events = readSessionEvents(cwd, "2026-09-18T11-00-00-000Z_bbbb");
  assert.equal(events.length, 2);
  assert.equal(events[1]!.type, "usage");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a half-written log line never throws (the writer may be mid-append)", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-watch-"));
  const dir = path.join(cwd, ".vantage", "sessions", "s1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), '{"ts":"x","type":"session_start"}\n{"ts":"y","ty');
  assert.deepEqual(readSessionEvents(cwd, "s1"), []);
  fs.rmSync(cwd, { recursive: true, force: true });
});
