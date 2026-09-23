// Tests for the live watch view (rendered in a second terminal, never over the
// agent's own TUI).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderLive, newestSessionId, readSessionEvents, findWatchTarget } from "../src/watch.ts";
import { recordLastSession } from "../src/home.ts";
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

test("latest turn skips the agent's background calls; totals still count them", () => {
  const withBackground: VantageEvent[] = [
    ...running,
    {
      ts: t(5),
      type: "usage",
      path: "/v1/messages",
      model: "claude-sonnet-5",
      in: 60,
      out: 40,
      cache_read: 0,
      cache_write: 0,
      cost_usd: 0.001,
      prompt: "Current state: working (for 0m)",
      text: '{"state":"done"}',
      background: true,
    },
  ];
  const frame = renderLive(withBackground, { sessionId: "s1", nowMs: NOW, color: false });
  assert.match(frame, /prompt add a retry to the fetch helper/);
  assert.doesNotMatch(frame, /Current state/);
  assert.match(frame, /turns\s+1/); // one chat turn…
  assert.match(frame, /~\$0\.0320/); // …but both requests are in the cost
});

test("watch finds the last started session from any directory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-home-"));
  process.env.VANTAGE_HOME = home;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-proj-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-else-"));
  const mk = (cwd: string, id: string): void => {
    const dir = path.join(cwd, ".vantage", "sessions", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify({ ts: T0, type: "session_start" }) + "\n");
  };

  assert.equal(findWatchTarget(elsewhere), null);
  mk(project, "2026-09-23T10-00-00-000Z_aaaa");
  recordLastSession({ cwd: project, sessionId: "2026-09-23T10-00-00-000Z_aaaa" });
  assert.deepEqual(findWatchTarget(elsewhere), { cwd: project, sessionId: "2026-09-23T10-00-00-000Z_aaaa" });

  // A newer session in watch's own directory wins over the pointer.
  mk(elsewhere, "2026-09-23T11-00-00-000Z_bbbb");
  assert.deepEqual(findWatchTarget(elsewhere), { cwd: elsewhere, sessionId: "2026-09-23T11-00-00-000Z_bbbb" });

  // A pinned id is found in the other project through the pointer.
  assert.deepEqual(findWatchTarget(elsewhere, "2026-09-23T10-00-00-000Z_aaaa")?.cwd, project);

  // A pointer to a deleted project is ignored.
  fs.rmSync(project, { recursive: true, force: true });
  assert.deepEqual(findWatchTarget(elsewhere)?.cwd, elsewhere);
  for (const d of [home, elsewhere]) fs.rmSync(d, { recursive: true, force: true });
});
