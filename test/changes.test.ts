// Change summary without --isolate: working-tree snapshots through a
// throwaway index, the diff between them, and the whole path through
// `vantage run` and `vantage review`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { snapshotWorkingTree, treeDiff } from "../src/git.ts";

const sh = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-changes-"));
  sh(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "app.js"), "one\n");
  fs.writeFileSync(path.join(dir, "old.txt"), "bye\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("the diff between two snapshots is exactly what changed; index and history untouched", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "staged.txt"), "the user's staged work\n");
  sh(dir, "add", "staged.txt");
  const statusBefore = sh(dir, "status", "--porcelain");
  const headBefore = sh(dir, "rev-parse", "HEAD");

  const start = snapshotWorkingTree(dir);
  assert.ok(start.ok);

  fs.writeFileSync(path.join(dir, "app.js"), "one\ntwo\n"); // modified
  fs.writeFileSync(path.join(dir, "new.js"), "x\n"); // untracked
  fs.rmSync(path.join(dir, "old.txt")); // deleted
  fs.mkdirSync(path.join(dir, "build"));
  fs.writeFileSync(path.join(dir, "build", "out.js"), "ignored\n"); // gitignored
  fs.mkdirSync(path.join(dir, ".vantage", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".vantage", "sessions", "log"), "vantage's own\n");

  const end = snapshotWorkingTree(dir);
  assert.ok(end.ok);
  const diff = treeDiff(dir, start.tree, end.tree);
  assert.deepEqual(diff.files.map((f) => f.path).sort(), ["app.js", "new.js", "old.txt"]);
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 1);
  assert.match(diff.patch, /\+two/);

  // The user's staging and history are exactly as they were.
  assert.equal(sh(dir, "rev-parse", "HEAD"), headBefore);
  assert.match(sh(dir, "status", "--porcelain"), /^A  staged\.txt/m);
  assert.ok(statusBefore.includes("A  staged.txt"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a project in a subdirectory: its .vantage folder is excluded too", () => {
  const dir = repo();
  const sub = path.join(dir, "packages", "web");
  fs.mkdirSync(sub, { recursive: true });
  const start = snapshotWorkingTree(sub);
  assert.ok(start.ok);
  fs.mkdirSync(path.join(sub, ".vantage"));
  fs.writeFileSync(path.join(sub, ".vantage", "x"), "log\n");
  fs.writeFileSync(path.join(sub, "index.ts"), "code\n");
  const end = snapshotWorkingTree(sub);
  assert.ok(end.ok);
  assert.deepEqual(treeDiff(sub, start.tree, end.tree).files.map((f) => f.path), ["packages/web/index.ts"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("too many untracked files: no snapshot, with a reason", () => {
  const dir = repo();
  const many = path.join(dir, "node_modules");
  fs.mkdirSync(many);
  for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(many, `f${i}.js`), "");
  const snap = snapshotWorkingTree(dir);
  assert.equal(snap.ok, false);
  assert.match(snap.ok ? "" : snap.reason, /2001 untracked files .* \.gitignore/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("`vantage run` reports the session's changes, and `vantage review` shows them", () => {
  const dir = repo();
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-home-"));
  const env = { ...process.env, VANTAGE_AGENT_PATH: process.execPath, VANTAGE_HOME: home };
  // node stands in for the agent and edits a file.
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", cli, "run", "--no-memory", "claude", "--", "-e", "require('fs').writeFileSync('app.js', 'one\\nchanged\\n')"],
    { cwd: dir, env, encoding: "utf8", timeout: 60_000 }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /changed during this session: 1 file\(s\), \+1\/-0/);
  assert.match(run.stderr, /app\.js \(\+1 -0\)/);

  const id = fs.readdirSync(path.join(dir, ".vantage", "sessions"))[0]!;
  const review = spawnSync(process.execPath, ["--experimental-strip-types", cli, "review", id], { cwd: dir, env, encoding: "utf8" });
  assert.equal(review.status, 0, review.stderr);
  assert.match(review.stdout, /app\.js \(\+1 -0\)/);
  const patch = spawnSync(process.execPath, ["--experimental-strip-types", cli, "review", id, "--patch"], { cwd: dir, env, encoding: "utf8" });
  assert.match(patch.stdout, /\+changed/);

  const end = fs.readFileSync(path.join(dir, ".vantage", "sessions", id, "events.jsonl"), "utf8").trim().split("\n").at(-1)!;
  assert.deepEqual(JSON.parse(end).changes, { files: ["app.js"], added: 1, removed: 0 });
  for (const d of [dir, home]) fs.rmSync(d, { recursive: true, force: true });
});
