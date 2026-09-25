// `vantage stats` and the machine-wide session index behind it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionStat, renderStats } from "../src/stats.ts";
import { recordLastSession, knownSessions, findSession } from "../src/home.ts";
import type { VantageEvent } from "../src/events.ts";

const at = (d: Date, min = 0): string => new Date(d.getTime() + min * 60_000).toISOString();
const rl = (ts: string, u7: number): VantageEvent => ({
  ts,
  type: "ratelimit",
  path: "/",
  raw: { "anthropic-ratelimit-unified-7d-utilization": String(u7) },
});
const usage = (ts: string, prompt: string, cost: number): VantageEvent => ({
  ts, type: "usage", path: "/v1/messages", model: "claude-opus-5-5", in: 10, out: 100, cache_read: 1000, cache_write: 0, cost_usd: cost, prompt,
});

function session(project: string, start: Date, cost: number, u7: [number, number], prompt = "do things"): VantageEvent[] {
  return [
    { ts: at(start), type: "session_start", agent: "claude-code", project },
    rl(at(start, 1), u7[0]),
    usage(at(start, 1), prompt, cost / 2),
    rl(at(start, 5), u7[1]),
    usage(at(start, 5), prompt, cost / 2),
    { ts: at(start, 6), type: "session_end", exitCode: 0, changes: { files: ["a.ts", "b.ts"], added: 3, removed: 1 } },
  ];
}

// "Today" in the tests is Wed 23 Sep 2026, local time.
const day = (offset: number, hour: number): Date => new Date(2026, 8, 23 + offset, hour);
const NOW = day(0, 18).getTime();

test("sessions are summed by day and by project, largest first", () => {
  const stats = [
    sessionStat({ cwd: "/work/api", sessionId: "s1" }, session("/work/api", day(0, 9), 1.2, [0.3, 0.36], "fix the login bug")),
    sessionStat({ cwd: "/work/api", sessionId: "s2" }, session("/work/api", day(-1, 14), 0.4, [0.25, 0.27])),
    sessionStat({ cwd: "C:\\Users\\me\\web", sessionId: "s3" }, session("C:\\Users\\me\\web", day(-1, 10), 0.2, [0.2, 0.21])),
    sessionStat({ cwd: "/work/old", sessionId: "s4" }, session("/work/old", day(-10, 10), 9, [0.1, 0.5])), // outside 7 days
  ].filter((s) => s !== null);
  const out = renderStats(stats, { days: 7, nowMs: NOW, color: false, cwd: "/work/api" });

  assert.match(out, /last 7 day\(s\) · 3 session\(s\) in 2 project\(s\)/);
  assert.match(out, /3 message\(s\) · ~\$1\.8000 API-equivalent · weekly limit ≈ \+9% · 6 file change\(s\)/);
  assert.match(out, /Wed 23\.09\.\s+█{12} ~\$1\.2000\s+1 session\(s\) · 1 message\(s\) · weekly \+6%/);
  assert.match(out, /Tue 22\.09\.\s+█{6}░{6} ~\$0\.6000\s+2 session\(s\)/);
  assert.match(out, /Thu 17\.09\.\s+–/, "every day of the period is listed");
  assert.doesNotMatch(out, /old/, "sessions outside the period are left out");
  // Project names from Windows and POSIX paths; most expensive first.
  assert.ok(out.indexOf("  api ") < out.indexOf("  web "));
  assert.match(out, /~\$1\.2000 .*fix the login bug/);
  assert.match(out, /vantage replay s1\n/, "no directory note for sessions in this directory");
  assert.match(out, /vantage replay s3 {3}\(in C:\\Users\\me\\web\)/);
});

test("two projects with the same folder name stay apart", () => {
  const a = sessionStat({ cwd: "/work/api", sessionId: "a" }, session("/work/api", day(0, 9), 1, [0.1, 0.1]))!;
  const b = sessionStat({ cwd: "/oss/api", sessionId: "b" }, session("/oss/api", day(0, 10), 2, [0.1, 0.1]))!;
  const out = renderStats([a, b], { days: 1, nowMs: NOW, color: false });
  assert.match(out, /2 session\(s\) in 2 project\(s\)/);
  assert.match(out, /oss\/api\s+~\$2\.0000/);
  assert.match(out, /work\/api\s+~\$1\.0000/);
});

test("a quota reset inside a session is not counted as negative use", () => {
  const events: VantageEvent[] = [
    { ts: at(day(0, 9)), type: "session_start", agent: "claude-code", project: "/p" },
    rl(at(day(0, 9), 1), 0.9),
    rl(at(day(0, 9), 2), 0.95), // +5%
    rl(at(day(0, 9), 3), 0.02), // reset
    rl(at(day(0, 9), 4), 0.05), // +3%
  ];
  assert.equal(Math.round(sessionStat({ cwd: "/p", sessionId: "x" }, events)!.quota7d * 100), 8);
});

test("no sessions in the period: a plain note", () => {
  assert.match(renderStats([], { days: 7, nowMs: NOW, color: false }), /No sessions in this period/);
});

test("the session index finds sessions from any directory, once each", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-home-"));
  process.env.VANTAGE_HOME = home;
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-proj-"));
  const mk = (id: string): void => {
    const dir = path.join(project, ".vantage", "sessions", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "events.jsonl"), "{}\n");
  };
  mk("a");
  mk("b");
  recordLastSession({ cwd: project, sessionId: "a" });
  recordLastSession({ cwd: project, sessionId: "a" }); // recorded twice
  recordLastSession({ cwd: "/gone", sessionId: "c" }); // log no longer there
  assert.deepEqual(knownSessions().map((r) => r.sessionId), ["a"]);
  assert.deepEqual(knownSessions(project).map((r) => r.sessionId).sort(), ["a", "b"], "plus the ones in cwd");
  assert.equal(findSession("a", os.tmpdir())?.cwd, project);
  assert.equal(findSession("zzz", os.tmpdir()), null);
  for (const d of [home, project]) fs.rmSync(d, { recursive: true, force: true });
});
