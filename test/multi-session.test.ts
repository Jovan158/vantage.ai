// Several sessions at once: which are running, the overview, and
// `vantage watch` choosing between overview and detail.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sessionRunning } from "../src/home.ts";
import { renderOverview } from "../src/watch.ts";
import type { VantageEvent } from "../src/events.ts";

const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));
const T = (s: number): string => new Date(Date.UTC(2026, 8, 23, 12, 0, s)).toISOString();
const NOW = Date.UTC(2026, 8, 23, 12, 1, 0);

function writeSession(cwd: string, id: string, events: VantageEvent[]): void {
  const dir = path.join(cwd, ".vantage", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const start = (project: string, pid?: number): VantageEvent => ({ ts: T(0), type: "session_start", agent: "claude-code", project, ...(pid ? { pid } : {}) });

test("running means: no session_end and the vantage process is alive", () => {
  const cwd = tmp("vantage-run-");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!; // exited already
  writeSession(cwd, "alive", [start(cwd, process.pid)]);
  writeSession(cwd, "ended", [start(cwd, process.pid), { ts: T(9), type: "session_end", exitCode: 0 }]);
  writeSession(cwd, "crashed", [start(cwd, dead)]);
  writeSession(cwd, "old-recent", [start(cwd)]);
  writeSession(cwd, "old-stale", [start(cwd)]);
  const staleFile = path.join(cwd, ".vantage", "sessions", "old-stale", "events.jsonl");
  const hourAgo = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(staleFile, hourAgo, hourAgo);

  const running = (id: string) => sessionRunning({ cwd, sessionId: id });
  assert.equal(running("alive"), true);
  assert.equal(running("ended"), false);
  assert.equal(running("crashed"), false, "a vantage process that died without session_end");
  assert.equal(running("old-recent"), true, "no pid recorded: written to recently");
  assert.equal(running("old-stale"), false);
  assert.equal(running("missing"), false);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("the overview shows the shared limits once and one block per session", () => {
  const rl = (s: number, u: number): VantageEvent => ({
    ts: T(s),
    type: "ratelimit",
    path: "/",
    raw: { "anthropic-ratelimit-unified-5h-utilization": String(u), "anthropic-ratelimit-unified-5h-reset": String(Math.floor(NOW / 1000) + 3600) },
  });
  const web: VantageEvent[] = [
    start("/work/web"),
    rl(5, 0.4),
    { ts: T(6), type: "usage", path: "/", model: "m", in: 1, out: 1, cache_read: 0, cache_write: 0, cost_usd: 0.25, prompt: "fix css", stopReason: "tool_use", tools: ["Edit"], calls: [{ tool: "Edit", target: "/work/web/app.css" }] },
  ];
  const api: VantageEvent[] = [
    start("C:\\work\\api"),
    rl(20, 0.47), // newer reading: this one is shown
    { ts: T(21), type: "usage", path: "/", model: "m", in: 1, out: 1, cache_read: 0, cache_write: 0, cost_usd: 0.05, prompt: "run tests", stopReason: "tool_use", tools: ["Bash"] },
    { ts: T(22), type: "decision", tool: "Bash", target: "npm test", decision: "ask", reason: "r" },
    { ts: T(23), type: "budget", state: "reached", reason: "r" },
  ];
  const out = renderOverview(
    [
      { ref: { cwd: "/work/web", sessionId: "2026-09-23T12-00-00-000Z_web1" }, events: web },
      { ref: { cwd: "C:\\work\\api", sessionId: "2026-09-23T12-00-10-000Z_api1" }, events: api },
    ],
    { nowMs: NOW, color: false, width: 100 }
  );
  assert.match(out, /^vantage · 2 sessions running/);
  assert.match(out, /Limits · shared by all sessions\n\s+5-hour\s+█{9}░{11}\s+47%/);
  assert.equal(out.match(/5-hour/g)?.length, 1, "limits once, not per session");
  assert.match(out, /web\s+1m\s+Claude is working: Edit app\.css/);
  assert.match(out, /~\$0\.2500 · 1 message\(s\)/);
  assert.match(out, /api\s+1m\s+Waiting for your approval in Claude Code: Bash npm test/);
  assert.match(out, /~\$0\.0500 · 1 message\(s\) · budget reached/);
  assert.match(out, /vantage watch 2026-09-23T12-00-10-000Z_api1\s+api/);
});

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

// Runs `vantage watch` for a moment and returns what it drew.
function watchFor(args: string[], cwd: string, home: string, ms: number): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, "watch", ...args], { cwd, env: { ...process.env, VANTAGE_HOME: home } });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    const timer = setTimeout(() => child.kill(), ms);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ out, code });
    });
  });
}

test("`vantage watch` from another directory: overview for two running sessions, detail by id", async () => {
  const home = tmp("vantage-home-");
  const a = tmp("vantage-a-");
  const b = tmp("vantage-b-");
  const elsewhere = tmp("vantage-else-");
  writeSession(a, "2026-09-23T12-00-00-000Z_aaaa", [start(a, process.pid)]);
  writeSession(b, "2026-09-23T12-00-05-000Z_bbbb", [start(b, process.pid)]);
  writeSession(b, "2026-09-23T11-00-00-000Z_done", [start(b, process.pid), { ts: T(1), type: "session_end", exitCode: 0 }]);
  fs.writeFileSync(
    path.join(home, "sessions.jsonl"),
    [
      { cwd: a, sessionId: "2026-09-23T12-00-00-000Z_aaaa" },
      { cwd: b, sessionId: "2026-09-23T12-00-05-000Z_bbbb" },
      { cwd: b, sessionId: "2026-09-23T11-00-00-000Z_done" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n"
  );

  const overview = await watchFor([], elsewhere, home, 2500);
  assert.match(overview.out, /2 sessions running/);
  assert.match(overview.out, /vantage watch 2026-09-23T12-00-00-000Z_aaaa/);
  assert.doesNotMatch(overview.out, /_done/, "ended sessions are not in the overview");

  // By id, from a directory that holds neither: found through the index;
  // an ended session is drawn once and watching stops.
  const pinned = await watchFor(["2026-09-23T11-00-00-000Z_done"], elsewhere, home, 10_000);
  assert.equal(pinned.code, 0);
  assert.match(pinned.out, /ended \(exit 0\)/);
  for (const d of [home, a, b, elsewhere]) fs.rmSync(d, { recursive: true, force: true });
});

test("`vantage watch <id>` stops for a session whose vantage crashed", async () => {
  const home = tmp("vantage-home-");
  const project = tmp("vantage-p-");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  writeSession(project, "crashed1", [start(project, dead)]);
  const r = await watchFor(["crashed1"], project, home, 10_000);
  assert.equal(r.code, 0, "exits on its own instead of watching forever");
  for (const d of [home, project]) fs.rmSync(d, { recursive: true, force: true });
});
