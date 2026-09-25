// Git plumbing for session isolation (CONCEPT.md problem ④).
//
// Isolation model: run the agent in a dedicated git worktree on a branch
// `vantage/<sessionId>` cut from HEAD, so the user's working tree is never
// touched. At the end we commit the agent's work to that branch, which gives a
// clean aggregated diff (base..HEAD) and a trivial merge-or-discard decision.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function gitSafe(cwd: string, args: string[]): GitResult {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? "").trim(),
    };
  }
}

export function isGitRepo(cwd: string): boolean {
  return gitSafe(cwd, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

export function headSha(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]);
}

export function isDirty(cwd: string): boolean {
  return git(cwd, ["status", "--porcelain"]).length > 0;
}

export interface Worktree {
  path: string;
  branch: string;
  baseSha: string;
}

// Create branch `vantage/<sessionId>` at HEAD and a worktree checked out on it.
export function addSessionWorktree(cwd: string, sessionId: string): Worktree {
  const baseSha = headSha(cwd);
  const branch = `vantage/${sessionId}`;
  const wtPath = path.join(cwd, ".vantage", "worktrees", sessionId);
  git(cwd, ["worktree", "add", "-b", branch, wtPath, baseSha]);
  return { path: wtPath, branch, baseSha };
}

// Commit whatever the agent changed in the worktree onto the isolation branch.
// Returns true if a commit was made, false if the tree was unchanged.
export function commitSessionWork(worktreeCwd: string, message: string): boolean {
  if (!isDirty(worktreeCwd)) return false;
  git(worktreeCwd, ["add", "-A"]);
  git(worktreeCwd, ["commit", "--no-verify", "-m", message]);
  return true;
}

export interface FileChange {
  path: string;
  added: number; // -1 for binary
  removed: number;
}

export interface SessionDiff {
  files: FileChange[];
  added: number;
  removed: number;
  patch: string;
}

// Aggregated diff of the isolation branch against its base.
export function sessionDiff(worktreeCwd: string, baseSha: string): SessionDiff {
  const numstat = git(worktreeCwd, ["diff", "--numstat", baseSha, "HEAD"]);
  const files: FileChange[] = [];
  let added = 0;
  let removed = 0;
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, r, ...rest] = line.split("\t");
    const filePath = rest.join("\t");
    const ai = a === "-" ? -1 : Number(a);
    const ri = r === "-" ? -1 : Number(r);
    files.push({ path: filePath, added: ai, removed: ri });
    if (ai > 0) added += ai;
    if (ri > 0) removed += ri;
  }
  const patch = git(worktreeCwd, ["diff", baseSha, "HEAD"]);
  return { files, added, removed, patch };
}

// Remove the worktree and (optionally) delete the isolation branch.
export function removeSessionWorktree(
  cwd: string,
  worktreePath: string,
  branch: string,
  deleteBranch = true
): void {
  gitSafe(cwd, ["worktree", "remove", "--force", worktreePath]);
  if (deleteBranch) gitSafe(cwd, ["branch", "-D", branch]);
}

// ---------------------------------------------------------------------------
// Change tracking without isolation: what changed in the working tree while
// a session ran.
//
// A snapshot is the whole working tree — tracked and untracked files, minus
// .gitignore'd ones — written as a git tree object through a throwaway index.
// The user's index, branches and history are never touched; the tree objects
// are unreferenced and git's garbage collection removes them eventually.

// Hashing thousands of untracked files (an unignored node_modules, say)
// would stall the start and bloat the object store; past this, skip.
const MAX_UNTRACKED = 2000;

export type Snapshot = { ok: true; tree: string } | { ok: false; reason: string };

export function snapshotWorkingTree(cwd: string, timeoutMs = 30_000): Snapshot {
  const run = (args: string[], env: NodeJS.ProcessEnv = process.env): string =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  let tmpIndex: string | null = null;
  try {
    // Vantage's own files (session logs, in <project>/.vantage) are not the
    // session's changes. The project may be a subdirectory of the repo.
    const notOurs = `:(exclude,top)${run(["rev-parse", "--show-prefix"])}.vantage`;
    const untracked = run(["ls-files", "--others", "--exclude-standard", "-z", "--", ":/", notOurs]).split("\0").filter(Boolean).length;
    if (untracked > MAX_UNTRACKED) {
      return { ok: false, reason: `${untracked} untracked files (more than ${MAX_UNTRACKED}) — add them to .gitignore to get a change summary` };
    }
    // Start from a copy of the real index: git then only re-hashes files
    // whose stat data changed, which keeps this fast in large repos.
    tmpIndex = path.join(os.tmpdir(), `vantage-index-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const realIndex = path.resolve(cwd, run(["rev-parse", "--git-path", "index"]));
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    run(["add", "--all", "--", ":/", notOurs], env);
    return { ok: true, tree: run(["write-tree"], env) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message.split("\n")[0] ?? "git failed" };
  } finally {
    if (tmpIndex) fs.rmSync(tmpIndex, { force: true });
  }
}

export function treeDiff(cwd: string, fromTree: string, toTree: string): SessionDiff {
  const files: FileChange[] = [];
  let added = 0;
  let removed = 0;
  const numstat = git(cwd, ["diff", "--numstat", fromTree, toTree]);
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, r, ...rest] = line.split("\t");
    const ai = a === "-" ? -1 : Number(a);
    const ri = r === "-" ? -1 : Number(r);
    files.push({ path: rest.join("\t"), added: ai, removed: ri });
    if (ai > 0) added += ai;
    if (ri > 0) removed += ri;
  }
  return { files, added, removed, patch: files.length ? git(cwd, ["diff", fromTree, toTree]) : "" };
}
