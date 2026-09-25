// Budget guard (problem ①, the step after showing the numbers: acting on them).
//
//   vantage run --max-cost 2 claude       ask before every action once the
//                                          session's estimated cost reaches $2
//   vantage run --max-quota 80 claude     ... once a subscription quota window
//                                          (5h or 7d) is 80% used
//
// Why "ask" and not "stop": killing the agent mid-task can leave half-applied
// edits. Switching every action to "needs your approval" hands control back
// to the user at the next tool call, without breaking anything. Actions the
// policy denies stay denied.
//
// How it reaches the agent: Claude Code starts the PreToolUse hook as a new
// process for every tool call, so the hook cannot share memory with the
// running `vantage run`. The guard writes a small state file into the session
// directory when the budget trips; the hook reads it on every call. Claude
// Code may start a tool while the reply that asked for it is still
// streaming, before its cost is known — so the hook first waits (bounded)
// until no reply is in flight (see InflightCounter).

import fs from "node:fs";
import path from "node:path";
import type { RateLimitSnapshot } from "./ratelimit.ts";

export interface Budget {
  /** Estimated session cost in USD at which the guard trips. */
  maxCostUsd: number | null;
  /** Fraction (0..1] of any quota window at which the guard trips. */
  maxQuota: number | null;
}

export function hasBudget(b: Budget): boolean {
  return b.maxCostUsd !== null || b.maxQuota !== null;
}

// "2", "2.50", "$2" -> 2. PowerShell and bash expand "$2" inside double
// quotes, so the plain number is the form to document.
export function parseCost(raw: string): number | null {
  const m = /^\$?\s*(\d+(?:\.\d+)?)\s*(?:usd)?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

// "80", "80%", "0.8" -> 0.8. Same reading as VANTAGE_QUOTA_WARN.
export function parseQuota(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(%?)$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const fraction = m[2] === "%" || n > 1 ? n / 100 : n;
  return fraction > 0 && fraction <= 1 ? fraction : null;
}

// Cents for normal budgets, more digits for tiny ones ($0.0030, not $0.00).
function usd(n: number): string {
  return `$${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
}

export function formatBudget(b: Budget): string {
  const parts: string[] = [];
  if (b.maxCostUsd !== null) parts.push(`cost ~${usd(b.maxCostUsd)}`);
  if (b.maxQuota !== null) parts.push(`${Math.round(b.maxQuota * 100)}% of a quota window`);
  return parts.join(" or ");
}

// ---------------------------------------------------------------------------
// Responses in flight, so the hook can wait for the one that may have crossed
// the budget. Claude Code can start a tool while the reply that asked for it
// is still streaming; its cost is only known at the end of the reply. With a
// budget set, `vantage run` keeps a count of observed requests in flight, and
// the hook waits (briefly, bounded) until it is zero before reading the
// budget state.

export function inflightPath(sessionDirPath: string): string {
  return path.join(sessionDirPath, "inflight");
}

export class InflightCounter {
  private count = 0;
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.write();
  }

  start(): void {
    this.count += 1;
    this.write();
  }

  end(): void {
    this.count = Math.max(0, this.count - 1);
    this.write();
  }

  private write(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, String(this.count));
    } catch {
      /* the hook then does not wait; the budget still applies from the next call */
    }
  }
}

// Waits until no observed response is in flight, or maxMs passed.
export async function waitForMetering(file: string | undefined, maxMs = 3000, stepMs = 25): Promise<void> {
  if (!file) return;
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    let n = 0;
    try {
      n = Number(fs.readFileSync(file, "utf8")) || 0;
    } catch {
      return;
    }
    if (n <= 0) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---------------------------------------------------------------------------
// State shared with the hook.

export interface BudgetState {
  reason: string;
  since: string;
}

export function budgetStatePath(sessionDirPath: string): string {
  return path.join(sessionDirPath, "budget.json");
}

export function readBudgetState(file: string | undefined): BudgetState | null {
  if (!file) return null;
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BudgetState>;
    return typeof s.reason === "string" ? { reason: s.reason, since: String(s.since ?? "") } : null;
  } catch {
    return null;
  }
}

export type BudgetChange = { kind: "reached"; reason: string } | { kind: "cleared"; reason: string };

// Tracks both limits and keeps the state file in sync. A cost trip is final
// for the session (cost only grows). A quota trip lifts again once every
// window is back under the limit — after a 5h window resets, work can go on.
export class BudgetGuard {
  private readonly budget: Budget;
  private readonly file: string;
  private costReason: string | null = null;
  private quotaReason: string | null = null;
  private warnedUnpriced = new Set<string>();
  private warnedNoWindows = false;

  constructor(budget: Budget, file: string) {
    this.budget = budget;
    this.file = file;
    // A leftover file must never block a fresh session.
    fs.rmSync(file, { force: true });
  }

  get tripped(): boolean {
    return this.costReason !== null || this.quotaReason !== null;
  }

  /** Called after each metered request with the session totals so far. */
  onCost(knownUsd: number): BudgetChange | null {
    const max = this.budget.maxCostUsd;
    if (max === null || this.costReason !== null || knownUsd < max) return null;
    return this.set(() => (this.costReason = `session cost ~${usd(knownUsd)} reached the ${usd(max)} budget`));
  }

  onQuota(s: RateLimitSnapshot): BudgetChange | null {
    const max = this.budget.maxQuota;
    const windows = s.unified?.windows ?? [];
    if (max === null || windows.length === 0) return null;
    const over = windows.filter((w) => w.utilization !== null && w.utilization >= max);
    if (over.length > 0 && this.quotaReason === null) {
      const which = over.map((w) => `${w.key} ${Math.round(w.utilization! * 100)}%`).join(", ");
      return this.set(() => (this.quotaReason = `quota ${which} reached the ${Math.round(max * 100)}% budget`));
    }
    if (over.length === 0 && this.quotaReason !== null) {
      return this.set(() => (this.quotaReason = null));
    }
    return null;
  }

  /**
   * One-time notes on what the guard cannot see, so a budget that never trips
   * is never mistaken for one that was never reached.
   */
  blindSpots(unpricedModels: string[], snapshot: RateLimitSnapshot | null): string[] {
    const notes: string[] = [];
    if (this.budget.maxCostUsd !== null) {
      for (const m of unpricedModels) {
        if (this.warnedUnpriced.has(m)) continue;
        this.warnedUnpriced.add(m);
        notes.push(`cost budget cannot count requests to ${m} (price unknown)`);
      }
    }
    if (this.budget.maxQuota !== null && snapshot && !snapshot.unified?.windows.length && !this.warnedNoWindows) {
      this.warnedNoWindows = true;
      notes.push("quota budget needs a subscription's 5h/7d windows; this account reports none — use --max-cost instead");
    }
    return notes;
  }

  // Applies a change, syncs the state file, and reports what the user should
  // hear: a new or wider reason while tripped, or the all-clear.
  private set(mutate: () => void): BudgetChange | null {
    const before = this.reasons();
    mutate();
    const reason = this.reasons();
    if (reason === before) return null;
    if (reason) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ reason, since: new Date().toISOString() }) + "\n");
      // Only a lifted quota trip narrows the reason while cost stays tripped;
      // nothing changes for the user then.
      if (before && before.includes(reason)) return null;
      return { kind: "reached", reason };
    }
    fs.rmSync(this.file, { force: true });
    return { kind: "cleared", reason: "quota is back under the budget" };
  }

  private reasons(): string | null {
    const r = [this.costReason, this.quotaReason].filter((x): x is string => x !== null);
    return r.length ? r.join("; ") : null;
  }
}
