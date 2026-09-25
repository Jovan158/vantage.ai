// `vantage sessions prune`: remove sessions nobody looked at for a while.
//
// A session's age is the time since its log was last written. Kept whatever
// their age: sessions still running, and isolated sessions whose worktree is
// still there (their branch holds work not merged or discarded yet — removing
// the session would leave it without `vantage discard`).

import fs from "node:fs";
import path from "node:path";
import { sessionDir, sessionEventsPath } from "./events.ts";
import { sessionRunning, type SessionRef } from "./home.ts";
import { readMeta } from "./session-meta.ts";

const UNIT_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

// "30d", "12h", "2w", or a plain number of days.
export function parseAge(raw: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)([hdw]?)$/i.exec((raw ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  return n * UNIT_MS[(m[2] || "d").toLowerCase()]!;
}

export interface PruneItem {
  ref: SessionRef;
  lastActivityMs: number;
  bytes: number;
}

export interface PrunePlan {
  remove: PruneItem[];
  /** Old enough, but kept, with the reason. */
  kept: Array<{ ref: SessionRef; reason: string }>;
}

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      total += entry.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
    }
  } catch {
    /* gone or unreadable: counts as nothing */
  }
  return total;
}

export function planPrune(refs: SessionRef[], olderThanMs: number, nowMs = Date.now()): PrunePlan {
  const plan: PrunePlan = { remove: [], kept: [] };
  for (const ref of refs) {
    let lastActivityMs: number;
    try {
      lastActivityMs = fs.statSync(sessionEventsPath(ref.cwd, ref.sessionId)).mtimeMs;
    } catch {
      continue;
    }
    if (nowMs - lastActivityMs < olderThanMs) continue;
    if (sessionRunning(ref, nowMs)) {
      plan.kept.push({ ref, reason: "still running" });
      continue;
    }
    const meta = readMeta(ref.cwd, ref.sessionId);
    if (meta?.isolated && meta.worktreePath && fs.existsSync(meta.worktreePath)) {
      const branch = meta.branch ? `${meta.branch} ` : "";
      plan.kept.push({ ref, reason: `isolation branch ${branch}still there — merge it or \`vantage discard ${ref.sessionId}\`` });
      continue;
    }
    plan.remove.push({ ref, lastActivityMs, bytes: dirBytes(sessionDir(ref.cwd, ref.sessionId)) });
  }
  plan.remove.sort((a, z) => a.lastActivityMs - z.lastActivityMs);
  return plan;
}

// Removes the planned sessions' folders; returns how many went.
export function applyPrune(plan: PrunePlan): number {
  let removed = 0;
  for (const item of plan.remove) {
    try {
      fs.rmSync(sessionDir(item.ref.cwd, item.ref.sessionId), { recursive: true, force: true });
      removed++;
    } catch {
      /* in use (Windows) or no permission: left for next time */
    }
  }
  return removed;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
