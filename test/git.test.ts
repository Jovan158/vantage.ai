// Exercises the isolation plumbing against a real throwaway git repo.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  isGitRepo,
  addSessionWorktree,
  commitSessionWork,
  sessionDiff,
  removeSessionWorktree,
  git,
} from "../src/git.ts";

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-git-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "test@vantage.ai"]);
  g(["config", "user.name", "Vantage Test"]);
  fs.writeFileSync(path.join(dir, "app.js"), "console.log('v1');\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "initial"]);
  return dir;
}

test("full isolation cycle: worktree, edit, commit, diff, cleanup", () => {
  const repo = mkRepo();
  assert.ok(isGitRepo(repo));

  const wt = addSessionWorktree(repo, "sess1");
  assert.ok(fs.existsSync(wt.path), "worktree dir created");
  assert.equal(wt.branch, "vantage/sess1");

  // Main working tree must be untouched by edits in the worktree.
  fs.writeFileSync(path.join(wt.path, "app.js"), "console.log('v2');\n");
  fs.writeFileSync(path.join(wt.path, "new.js"), "export const x = 1;\n");
  assert.equal(
    fs.readFileSync(path.join(repo, "app.js"), "utf8"),
    "console.log('v1');\n",
    "original repo file unchanged"
  );

  const committed = commitSessionWork(wt.path, "vantage: test session");
  assert.equal(committed, true);

  const diff = sessionDiff(wt.path, wt.baseSha);
  const paths = diff.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["app.js", "new.js"]);
  assert.ok(diff.added >= 2, "counts added lines");
  assert.match(diff.patch, /console\.log\('v2'\)/);

  // The base branch still points at v1 until an explicit merge.
  assert.match(git(repo, ["show", "main:app.js"]), /v1/);

  removeSessionWorktree(repo, wt.path, wt.branch);
  assert.ok(!fs.existsSync(wt.path), "worktree removed");
  const branches = git(repo, ["branch", "--list", "vantage/sess1"]);
  assert.equal(branches, "", "isolation branch deleted");

  fs.rmSync(repo, { recursive: true, force: true });
});

test("commitSessionWork returns false when nothing changed", () => {
  const repo = mkRepo();
  const wt = addSessionWorktree(repo, "sess2");
  assert.equal(commitSessionWork(wt.path, "noop"), false);
  removeSessionWorktree(repo, wt.path, wt.branch);
  fs.rmSync(repo, { recursive: true, force: true });
});
