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

test("live view: status, limits with reset, session numbers, latest exchange, activity", () => {
  const out = renderLive(running, { sessionId: "sess-1", nowMs: NOW, color: false });
  assert.match(out, /vantage · running · 30s · claude-sonnet-5/);
  assert.match(out, /sess-1/);
  assert.match(out, /Claude replied\. 27s ago/);
  assert.match(out, /5-hour\s+█{8}░{12}\s+42%\s+resets \d\d:\d\d \(in 2h\)/);
  assert.match(out, /1 message\(s\) from you\s+→\s+1 model call\(s\), 2 tool call\(s\)/);
  assert.match(out, /~\$0\.0310\s+API-equivalent/);
  assert.match(out, /context\s+52k tokens sent with the last message/);
  assert.doesNotMatch(out, /Latest|add a retry to the fetch helper/, "the conversation is in Claude Code, not here");
  assert.match(out, /Activity · read×1 · write×1/);
  assert.match(out, /Ctrl-C stops watching — Claude keeps running/);
  assert.doesNotMatch(out, /\x1b\[/, "no ANSI when color is off");
  assert.doesNotMatch(out, /[●◔▸⛔⚠✔✓]/u, "words, not symbols");
});

test("live view reports a finished session with its exit code", () => {
  const ended: VantageEvent[] = [...running, { ts: t(10), type: "session_end", exitCode: 0 }];
  const out = renderLive(ended, { sessionId: "sess-1", nowMs: NOW, color: false });
  assert.match(out, /ended \(exit 0\)/);
  assert.match(out, /vantage replay sess-1/);
  assert.doesNotMatch(out, /Ctrl-C/);
});

const turn = (secs: number, over: Partial<Extract<VantageEvent, { type: "usage" }>>): VantageEvent => ({
  ts: t(secs),
  type: "usage",
  path: "/v1/messages",
  model: "claude-opus-5-5",
  in: 2,
  out: 50,
  cache_read: 60_000,
  cache_write: 0,
  cost_usd: 0.02,
  ...over,
});

test("status says what Claude is doing: thinking, working, waiting for approval", () => {
  const base: VantageEvent[] = [{ ts: t(0), type: "session_start", agent: "claude-code", project: "/home/me/app" }];
  const thinking = [...base, { ts: t(20), type: "request" } as VantageEvent];
  assert.match(renderLive(thinking, { sessionId: "s", nowMs: NOW, color: false }), /Claude is thinking… 10s/);

  const working = [
    ...base,
    turn(21, { prompt: "fix it", stopReason: "tool_use", tools: ["Edit"], calls: [{ tool: "Edit", target: "/home/me/app/src/a.ts" }] }),
  ];
  const w = renderLive(working, { sessionId: "s", nowMs: NOW, color: false });
  assert.match(w, /Claude is working: Edit src\/a\.ts/, "paths inside the project are relative");
  assert.match(w, /Activity · write×1 · 1 file\(s\) edited/);

  const asking = [...working, { ts: t(22), type: "decision", tool: "Edit", target: "/home/me/app/src/a.ts", decision: "ask", reason: "r" } as VantageEvent];
  const a = renderLive(asking, { sessionId: "s", nowMs: NOW, color: false });
  assert.match(a, /Approval requested \d+s ago: Edit src\/a\.ts/);
  assert.match(a, /asked\s+Edit\s+src\/a\.ts/, "the decision marks the call, not a second entry");
  assert.equal(a.match(/src\/a\.ts/g)?.length, 2, "status line + one activity entry");
});

test("a decision logged before its turn (the hook runs mid-stream) is one entry, and the question stays open", () => {
  const events: VantageEvent[] = [
    { ts: t(0), type: "session_start", agent: "claude-code", project: "/p" },
    { ts: t(1), type: "request" },
    { ts: t(3), type: "decision", tool: "Bash", target: "node app.js", decision: "ask", reason: "r" },
    turn(4, { prompt: "run it", stopReason: "tool_use", tools: ["Bash"], calls: [{ tool: "Bash", target: "node app.js" }] }),
  ];
  const out = renderLive(events, { sessionId: "s", nowMs: NOW, color: false });
  assert.match(out, /Approval requested \d+s ago: Bash node app\.js/);
  assert.equal(out.match(/node app\.js/g)?.length, 2, "status line + a single activity entry");
  // Answered: Claude continues with its next request.
  const answered = [...events, { ts: t(8), type: "request" } as VantageEvent];
  assert.match(renderLive(answered, { sessionId: "s", nowMs: NOW, color: false }), /Claude is thinking…/);
});

test("a message is counted once across Claude's tool loop", () => {
  const loop: VantageEvent[] = [
    { ts: t(0), type: "session_start", agent: "claude-code" },
    turn(2, { prompt: "add tests", stopReason: "tool_use", tools: ["Read"] }),
    turn(4, { prompt: "add tests", stopReason: "tool_use", tools: ["Write"] }),
    turn(6, { prompt: "add tests", stopReason: "end_turn" }),
    turn(9, { prompt: "now run them", stopReason: "end_turn" }),
  ];
  assert.match(renderLive(loop, { sessionId: "s", nowMs: NOW, color: false }), /2 message\(s\) from you\s+→\s+4 model call\(s\), 2 tool call\(s\)/);
});

test("limits: share of this session, and a warning when the pace runs out before the reset", () => {
  const reset = String(Math.floor(Date.parse(T0) / 1000) + 7200); // 2 hours after start
  const rl = (secs: number, u: number): VantageEvent => ({
    ts: t(secs),
    type: "ratelimit",
    path: "/",
    raw: { "anthropic-ratelimit-unified-5h-utilization": String(u), "anthropic-ratelimit-unified-5h-reset": reset },
  });
  // +20% in 25 minutes: the 30% left runs out in ~38 minutes, the reset is ~95 minutes away.
  const fast: VantageEvent[] = [{ ts: t(0), type: "session_start", agent: "claude-code" }, rl(0, 0.5), rl(1500, 0.7)];
  const out = renderLive(fast, { sessionId: "s", nowMs: Date.parse(T0) + 1500_000, color: false });
  assert.match(out, /this session so far: \+20% of the 5-hour limit/);
  assert.match(out, /At this pace the 5-hour limit runs out around \d\d:\d\d, before it resets\./);

  const slow: VantageEvent[] = [{ ts: t(0), type: "session_start", agent: "claude-code" }, rl(0, 0.5), rl(1500, 0.51)];
  assert.match(renderLive(slow, { sessionId: "s", nowMs: Date.parse(T0) + 1500_000, color: false }), /at this pace it lasts until the reset/);
});

test("budget progress is shown, and a reached budget stands out", () => {
  const withBudget: VantageEvent[] = [
    { ts: t(0), type: "session_start", agent: "claude-code", budget: { maxCostUsd: 1, maxQuota: null } },
    turn(2, { prompt: "go", cost_usd: 0.25 }),
  ];
  assert.match(renderLive(withBudget, { sessionId: "s", nowMs: NOW, color: false }), /budget\s+███░{7} 25% of \$1/);
  const reached = [...withBudget, { ts: t(3), type: "budget", state: "reached", reason: "r" } as VantageEvent];
  assert.match(renderLive(reached, { sessionId: "s", nowMs: NOW, color: false }), /Budget reached — every action now needs your approval\./);
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

test("a half-written last line never throws, and the complete lines stay readable", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-watch-"));
  const dir = path.join(cwd, ".vantage", "sessions", "s1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), '{"ts":"x","type":"session_start"}\n{"ts":"y","ty');
  assert.deepEqual(readSessionEvents(cwd, "s1"), [{ ts: "x", type: "session_start" }]);
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
  assert.doesNotMatch(frame, /Current state/);
  assert.match(frame, /1 model call\(s\)/); // one chat turn…
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

test("a damaged line in a log is skipped; the rest of the session stays readable", async () => {
  const { parseEventLines } = await import("../src/events.ts");
  const text = [JSON.stringify({ ts: T0, type: "session_start" }), '{"ts":"x","type":"usa', JSON.stringify({ ts: T0, type: "session_end", exitCode: 0 }), "[1,2]"].join("\n");
  assert.deepEqual(parseEventLines(text).map((e) => e.type), ["session_start", "session_end"]);
});

