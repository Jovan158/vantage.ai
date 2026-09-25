// `vantage sessions prune`: which sessions go, which stay, and the index.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAge, planPrune } from "../src/prune.ts";
import { compactSessionIndex } from "../src/home.ts";
import type { VantageEvent } from "../src/events.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const DAY = 86_400_000;
const NOW = Date.now();
const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));

function writeSession(cwd: string, id: string, ageDays: number, extra: Partial<VantageEvent> = {}): string {
  const dir = path.join(cwd, ".vantage", "sessions", id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.jsonl");
  const start = { ts: new Date(NOW - ageDays * DAY).toISOString(), type: "session_start", agent: "claude-code", project: cwd, ...extra };
  const end = { ts: new Date(NOW - ageDays * DAY).toISOString(), type: "session_end", exitCode: 0 };
  fs.writeFileSync(file, [start, ...("pid" in extra ? [] : [end])].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const t = new Date(NOW - ageDays * DAY);
  fs.utimesSync(file, t, t);
  return dir;
}

test("ages: days by default, or h / d / w", () => {
  assert.equal(parseAge("30d"), 30 * DAY);
  assert.equal(parseAge("30"), 30 * DAY);
  assert.equal(parseAge("12h"), 12 * 3_600_000);
  assert.equal(parseAge("2W"), 14 * DAY);
  for (const bad of ["", "0d", "-3d", "30 days", "d", undefined]) assert.equal(parseAge(bad), null, String(bad));
});

test("old sessions go; recent, running and unmerged isolated ones stay", () => {
  const cwd = tmp("vantage-prune-");
  writeSession(cwd, "old", 40);
  writeSession(cwd, "recent", 3);
  writeSession(cwd, "running", 40, { pid: process.pid } as Partial<VantageEvent>);
  const iso = writeSession(cwd, "isolated", 40);
  const worktree = path.join(cwd, ".vantage", "worktrees", "isolated");
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(iso, "meta.json"), JSON.stringify({ sessionId: "isolated", isolated: true, branch: "vantage/isolated", worktreePath: worktree }));

  const refs = ["old", "recent", "running", "isolated"].map((sessionId) => ({ cwd, sessionId }));
  const plan = planPrune(refs, 30 * DAY, NOW);
  assert.deepEqual(plan.remove.map((i) => i.ref.sessionId), ["old"]);
  assert.ok(plan.remove[0]!.bytes > 0);
  assert.deepEqual(
    plan.kept.map((k) => `${k.ref.sessionId}: ${k.reason}`),
    ["running: still running", "isolated: isolation branch vantage/isolated still there — merge it or `vantage discard isolated`"]
  );
});

test("the index loses entries whose log is gone and duplicates, and keeps the rest", () => {
  const home = tmp("vantage-home-");
  const cwd = tmp("vantage-prune-");
  writeSession(cwd, "a", 1);
  const prev = process.env.VANTAGE_HOME;
  process.env.VANTAGE_HOME = home;
  try {
    const entry = (sessionId: string): string => JSON.stringify({ cwd, sessionId }) + "\n";
    fs.writeFileSync(path.join(home, "sessions.jsonl"), entry("a") + entry("gone") + entry("a") + "not json\n");
    assert.equal(compactSessionIndex(), 3);
    assert.equal(fs.readFileSync(path.join(home, "sessions.jsonl"), "utf8"), entry("a"));
    assert.equal(compactSessionIndex(), 0, "nothing left to drop");
  } finally {
    if (prev === undefined) delete process.env.VANTAGE_HOME;
    else process.env.VANTAGE_HOME = prev;
  }
});

test("vantage sessions prune lists first and deletes only with --yes", () => {
  const home = tmp("vantage-home-");
  const cwd = tmp("vantage-prune-");
  const oldDir = writeSession(cwd, "old", 40);
  writeSession(cwd, "recent", 3);
  fs.writeFileSync(path.join(home, "sessions.jsonl"), ["old", "recent"].map((sessionId) => JSON.stringify({ cwd, sessionId }) + "\n").join(""));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "sessions", "prune", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, VANTAGE_HOME: home },
    });

  const dry = run();
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stderr, /1 session\(s\) in this project inactive for 30d/);
  assert.match(dry.stdout, /old {2}last active/);
  assert.doesNotMatch(dry.stdout, /recent/);
  assert.match(dry.stderr, /nothing deleted yet/);
  assert.ok(fs.existsSync(oldDir), "a dry run deletes nothing");

  const real = run("--yes");
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stderr, /deleted 1 session\(s\)/);
  assert.ok(!fs.existsSync(oldDir));
  assert.ok(fs.existsSync(path.join(cwd, ".vantage", "sessions", "recent")));
  assert.equal(fs.readFileSync(path.join(home, "sessions.jsonl"), "utf8"), JSON.stringify({ cwd, sessionId: "recent" }) + "\n");

  assert.equal(run("--older-than", "soon").status, 1);
});
