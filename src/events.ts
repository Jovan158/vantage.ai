// Append-only session event log (JSONL). The shared data store that feeds the
// meter now and, later, replay and the approval gate (CONCEPT.md §2, §4).

import fs from "node:fs";
import path from "node:path";
import { plainDeep } from "./sanitize.ts";

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
  /** session_start: process id of `vantage run`, to tell running from crashed. */
  pid?: number;
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

/** Something that looks like a secret was sent to the API (never the value). */
export interface SecretEvent {
  ts: string;
  type: "secret";
  kind: string;
  masked: string;
  source: string;
}

export type VantageEvent = UsageEvent | SessionEvent | RateLimitEvent | BudgetEvent | RequestEvent | DecisionEvent | SecretEvent;

export class EventLog {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  append(event: VantageEvent): void {
    fs.appendFileSync(this.filePath, JSON.stringify(event) + "\n");
  }

  // A damaged line — a torn write when vantage was killed mid-append, or two
  // processes appending at once — is skipped, so the rest of the session
  // stays readable.
  readAll(): VantageEvent[] {
    if (!fs.existsSync(this.filePath)) return [];
    return parseEventLines(fs.readFileSync(this.filePath, "utf8"));
  }
}

// Follows a log that is still being written: each read() parses only what was
// appended since the last one, so watching a long session stays cheap. A
// line still being written is held back until it is complete; a log that
// shrank (replaced or truncated) is read again from the start.
export class EventTail {
  readonly filePath: string;
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);
  private events: VantageEvent[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  read(): VantageEvent[] {
    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return this.events;
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = Buffer.alloc(0);
      this.events = [];
    }
    if (size === this.offset) return this.events;
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.filePath, "r");
      const chunk = Buffer.alloc(size - this.offset);
      const n = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset += n;
      const data = Buffer.concat([this.partial, chunk.subarray(0, n)]);
      // Split on the byte, not the string: a read can end inside a multi-byte
      // character, but never inside a newline.
      const end = data.lastIndexOf(0x0a);
      this.partial = end === -1 ? data : data.subarray(end + 1);
      if (end !== -1) this.events = this.events.concat(parseEventLines(data.subarray(0, end).toString("utf8")));
    } catch {
      /* unreadable right now; the next read tries again */
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    return this.events;
  }
}

export function parseEventLines(text: string): VantageEvent[] {
  const out: VantageEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as VantageEvent;
      // Logs hold text from outside (file names, prompts, tool output); it is
      // shown in the terminal, so control sequences go here (src/sanitize.ts).
      if (e && typeof e === "object" && typeof e.type === "string") out.push(plainDeep(e));
    } catch {
      /* skip the damaged line */
    }
  }
  return out;
}

// Sessions live under .vantage/sessions/<id>/ in the target repo.
export function sessionDir(cwd: string, sessionId: string): string {
  return path.join(cwd, ".vantage", "sessions", sessionId);
}

const VANTAGE_GITIGNORE = `# Written by Vantage. Session logs hold excerpts of prompts and replies, and
# worktrees are separate checkouts: neither belongs in the repository.
# Rules (policy.json) and project memory (memory/) stay versioned.
sessions/
worktrees/
`;

// Keeps session logs out of git without touching the project's own
// .gitignore. An existing file is left alone, edited or not. Returns whether
// it was written.
export function ensureVantageGitignore(cwd: string): boolean {
  const file = path.join(cwd, ".vantage", ".gitignore");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, VANTAGE_GITIGNORE, { flag: "wx" });
    return true;
  } catch {
    return false; // already there, or not writable — the run goes on either way
  }
}

export function sessionEventsPath(cwd: string, sessionId: string): string {
  return path.join(sessionDir(cwd, sessionId), "events.jsonl");
}

export function newSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}_${rand}`;
}
