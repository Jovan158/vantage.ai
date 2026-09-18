// Git plumbing for session isolation (CONCEPT.md problem ④).
//
// Isolation model: run the agent in a dedicated git worktree on a branch
// `vantage/<sessionId>` cut from HEAD, so the user's working tree is never
// touched. At the end we commit the agent's work to that branch, which gives a
// clean aggregated diff (base..HEAD) and a trivial merge-or-discard decision.

import { execFileSync } from "node:child_process";
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

export function currentBranch(cwd: string): string {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
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
