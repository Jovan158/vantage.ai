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
  cost_usd: number;
}

export interface SessionEvent {
  ts: string;
  type: "session_start" | "session_end";
  agent?: string;
  exitCode?: number | null;
}

export interface RateLimitEvent {
  ts: string;
  type: "ratelimit";
  path: string;
  raw: Record<string, string>;
}

export type VantageEvent = UsageEvent | SessionEvent | RateLimitEvent;

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
