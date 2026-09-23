// Append-only session event log (JSONL). The shared data store that feeds the
// meter now and, later, replay and the approval gate (CONCEPT.md §2, §4).

import fs from "node:fs";
import path from "node:path";

export interface UsageEvent {
  ts: string;
  type: "usage";
  path: string;
  model: string | null;
  in: number;
  out: number;
  cache_read: number;
  cache_write: number;
  /** Estimated USD, or null when the model's price is unknown. */
  cost_usd: number | null;
  // Optional turn content (problem ③) — previews, not full transcripts.
  prompt?: string;
  text?: string;
  tools?: string[];
  /** The same calls with what each acts on (file, command, URL). */
  calls?: ToolCallRecord[];
  stopReason?: string | null;
  /** A call the agent made on its own, not a chat turn (see turn.ts). */
  background?: boolean;
}

export interface ToolCallRecord {
  tool: string;
  target?: string;
}

export interface SessionEvent {
  ts: string;
  type: "session_start" | "session_end";
  agent?: string;
  exitCode?: number | null;
  /** session_start: the project directory. */
  project?: string;
  /** session_start: the budget set for this run, if any. */
  budget?: { maxCostUsd: number | null; maxQuota: number | null };
  /** session_end: files changed during the session (see git.ts). */
  changes?: { files: string[]; added: number; removed: number };
}

/** A chat turn was sent; its usage event follows when the reply is done. */
export interface RequestEvent {
  ts: string;
  type: "request";
}

/** The PreToolUse hook stopped or questioned a tool call. */
export interface DecisionEvent {
  ts: string;
  type: "decision";
  tool: string;
  target?: string;
  decision: "ask" | "deny";
  reason: string;
}

export interface RateLimitEvent {
  ts: string;
  type: "ratelimit";
  path: string;
  raw: Record<string, string>;
}

export interface BudgetEvent {
  ts: string;
  type: "budget";
  state: "reached" | "cleared";
  reason: string;
}

export type VantageEvent = UsageEvent | SessionEvent | RateLimitEvent | BudgetEvent | RequestEvent | DecisionEvent;

export class EventLog {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(event: VantageEvent): void {
    fs.appendFileSync(this.filePath, JSON.stringify(event) + "\n");
  }

  readAll(): VantageEvent[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs
      .readFileSync(this.filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as VantageEvent);
  }
}

// Calls onEvent for every event appended to the log from now on — including
// lines other processes (the hook) append. Polls once a second; returns a
// stop function.
export function followEvents(filePath: string, onEvent: (e: VantageEvent) => void, intervalMs = 1000): () => void {
  let offset = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  let partial = "";
  const timer = setInterval(() => {
    let size: number;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const lines = (partial + buf.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onEvent(JSON.parse(line) as VantageEvent);
        } catch {
          /* not a complete event */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// Sessions live under .vantage/sessions/<id>/ in the target repo.
export function sessionDir(cwd: string, sessionId: string): string {
  return path.join(cwd, ".vantage", "sessions", sessionId);
}

export function sessionEventsPath(cwd: string, sessionId: string): string {
  return path.join(sessionDir(cwd, sessionId), "events.jsonl");
}

export function newSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}_${rand}`;
}
