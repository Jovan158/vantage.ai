// `vantage review` and `vantage discard`: what a session changed, and
// dropping an isolated session's branch.

import fs from "node:fs";
import path from "node:path";
import { sessionDir } from "../events.ts";
import { gitSafe, removeSessionWorktree, treeDiff } from "../git.ts";
import { readMeta } from "../session-meta.ts";
import { log, fmtFileLine } from "./output.ts";

export async function cmdReview(argv: string[]): Promise<number> {
  const showPatch = argv.includes("--patch") || argv.includes("-p");
  const sessionId = argv.find((a) => !a.startsWith("-"));
  if (!sessionId) {
    log("usage: vantage review <sessionId> [--patch]");
    return 1;
  }
  const cwd = process.cwd();
  const meta = readMeta(cwd, sessionId);
  if (!meta) {
    log(`no session "${sessionId}" found under .vantage/sessions/`);
    return 1;
  }
  // Not isolated: the working-tree snapshots from start and end.
  if (!meta.isolated) {
    if (!meta.startTree || !meta.endTree) {
      log(`no change record for session ${sessionId} (not a git repository, still running, or started before change tracking)`);
      return 1;
    }
    const diff = treeDiff(cwd, meta.startTree, meta.endTree);
    if (diff.files.length === 0) {
      log(`no files changed during session ${sessionId}`);
      return 0;
    }
    if (showPatch) {
      process.stdout.write(diff.patch + "\n");
      return 0;
    }
    log(`changed during session ${sessionId}: ${diff.files.length} file(s), +${diff.added}/-${diff.removed} (edits made meanwhile included)`);
    for (const f of diff.files) process.stdout.write(fmtFileLine(f) + "\n");
    log(`full diff: vantage review ${sessionId} --patch`);
    log(`undo them: git diff ${meta.startTree.slice(0, 12)} ${meta.endTree.slice(0, 12)} | git apply -R`);
    return 0;
  }
  if (!meta.branch || !meta.baseSha) {
    log(`session ${sessionId} has no isolation branch recorded`);
    return 1;
  }

  const branchExists = gitSafe(cwd, ["rev-parse", "--verify", meta.branch]).ok;
  if (branchExists) {
    const stat = gitSafe(cwd, ["diff", "--stat", meta.baseSha, meta.branch]);
    log(`branch ${meta.branch} vs base ${meta.baseSha.slice(0, 8)}:`);
    process.stdout.write(stat.stdout + "\n");
    log(`full diff: git diff ${meta.baseSha.slice(0, 8)} ${meta.branch}`);
    log(`merge:     git merge --no-ff ${meta.branch}`);
    log(`discard:   vantage discard ${sessionId}`);
  } else {
    const patch = path.join(sessionDir(cwd, sessionId), "changes.patch");
    if (fs.existsSync(patch)) {
      log(`branch is gone; saved patch: ${patch}`);
    } else {
      log(`nothing to review for session ${sessionId}`);
    }
  }
  return 0;
}

export async function cmdDiscard(argv: string[]): Promise<number> {
  const sessionId = argv[0];
  if (!sessionId) {
    log("usage: vantage discard <sessionId>");
    return 1;
  }
  const cwd = process.cwd();
  const meta = readMeta(cwd, sessionId);
  if (!meta || !meta.isolated || !meta.branch || !meta.worktreePath) {
    log(`session ${sessionId} has no isolation worktree to discard`);
    return 1;
  }
  removeSessionWorktree(cwd, meta.worktreePath, meta.branch);
  log(`discarded worktree and branch ${meta.branch}`);
  return 0;
}
