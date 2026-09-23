// `vantage search`: what matches, how it is labelled and scoped, and the
// command end to end across directories.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { searchSession, renderSearch } from "../src/search.ts";
import type { VantageEvent } from "../src/events.ts";

const T = (min: number): string => new Date(Date.UTC(2026, 8, 23, 12, min)).toISOString();

const events: VantageEvent[] = [
  { ts: T(0), type: "session_start", agent: "claude-code", project: "/work/api" },
  { ts: T(1), type: "usage", path: "/", model: "m", in: 1, out: 1, cache_read: 0, cache_write: 0, cost_usd: 0, prompt: "add retries to fetch.ts", text: "Reading fetch.ts first.", tools: ["Read"], calls: [{ tool: "Read", target: "/work/api/src/fetch.ts" }], stopReason: "tool_use" },
  { ts: T(2), type: "usage", path: "/", model: "m", in: 1, out: 1, cache_read: 0, cache_write: 0, cost_usd: 0, prompt: "add retries to fetch.ts", tools: ["Edit", "Bash"], calls: [{ tool: "Edit", target: "/work/api/src/fetch.ts" }, { tool: "Bash", target: "npm test -- fetch" }], stopReason: "tool_use" },
  { ts: T(3), type: "usage", path: "/", model: "m", in: 1, out: 1, cache_read: 0, cache_write: 0, cost_usd: 0, prompt: "Current state: fetch.ts", background: true },
  { ts: T(4), type: "decision", tool: "Bash", target: "git push --force", decision: "deny", reason: "r" },
  { ts: T(5), type: "session_end", exitCode: 0, changes: { files: ["src/fetch.ts"], added: 5, removed: 1 } },
];
const ref = { cwd: "/work/api", sessionId: "s1" };

test("messages, replies, files, commands, blocks and changes are found; background calls are not", () => {
  const r = searchSession(ref, events, "FETCH.ts")!;
  assert.deepEqual(
    r.hits.map((h) => `${h.label} ${h.text}`),
    ["you add retries to fetch.ts", "claude Reading fetch.ts first.", "read src/fetch.ts", "edited src/fetch.ts", "changed src/fetch.ts"],
    "case-insensitive, the repeated prompt of the tool loop once, paths relative to the project"
  );
  assert.deepEqual(searchSession(ref, events, "push")!.hits.map((h) => `${h.label} ${h.text}`), ["blocked Bash git push --force"]);
  assert.equal(searchSession(ref, events, "Current state"), null);
});

test("--files and --commands narrow the search, blocked calls included", () => {
  assert.deepEqual(searchSession(ref, events, "fetch", "files")!.hits.map((h) => h.label), ["read", "edited", "changed"]);
  assert.deepEqual(searchSession(ref, events, "fetch", "commands")!.hits.map((h) => h.text), ["npm test -- fetch"]);
  assert.deepEqual(searchSession(ref, events, "push", "commands")!.hits.map((h) => `${h.label} ${h.text}`), ["blocked Bash git push --force"]);
});

test("labels are not searched: 'claude' or 'ran' do not match every hit", () => {
  assert.equal(searchSession(ref, events, "claude"), null);
  assert.equal(searchSession(ref, events, "ran"), null);
});

test("results: newest session first, the match shown in context", () => {
  const older = { ...searchSession(ref, events, "npm")!, startedMs: 0 };
  const newer = { ...searchSession({ cwd: "/work/web", sessionId: "s2" }, events, "npm")!, startedMs: 1 };
  const out = renderSearch([older, newer], { query: "npm", color: false, width: 80 });
  assert.match(out, /^2 match\(es\) in 2 session\(s\) for "npm", newest first/);
  assert.ok(out.indexOf("vantage replay s2") < out.indexOf("vantage replay s1"));
  assert.match(out, /ran\s+npm test -- fetch/);
  assert.match(renderSearch([], { query: "nothing", color: false }), /No session mentions "nothing"/);
});

test("`vantage search` finds a session started in another directory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-home-"));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-proj-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-else-"));
  const dir = path.join(project, ".vantage", "sessions", "s1");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "sessions.jsonl"), JSON.stringify({ cwd: project, sessionId: "s1" }) + "\n");

  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--experimental-strip-types", cli, "search", ...args], { cwd: elsewhere, env: { ...process.env, VANTAGE_HOME: home }, encoding: "utf8" });
  const found = run("git", "push");
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /blocked\s+Bash git push --force/);
  assert.equal(run("zzz-nothing").status, 1);
  for (const d of [home, project, elsewhere]) fs.rmSync(d, { recursive: true, force: true });
});
