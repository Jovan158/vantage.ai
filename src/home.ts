// Per-user state under ~/.vantage (not per project): the price list from
// `vantage pricing update`, a pointer to the most recently started session so
// `vantage watch` finds it from any directory, and an index of all sessions
// for `vantage stats` and `vantage search` (session logs live per project).
//
// VANTAGE_HOME relocates it — for tests, and for machines where the home
// directory is not writable.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionEventsPath } from "./events.ts";

export function vantageHome(): string {
  return process.env.VANTAGE_HOME || path.join(os.homedir(), ".vantage");
}

export interface SessionRef {
  /** Project directory the session was started in. */
  cwd: string;
  sessionId: string;
}

function lastSessionPath(): string {
  return path.join(vantageHome(), "last-session.json");
}

function sessionIndexPath(): string {
  return path.join(vantageHome(), "sessions.jsonl");
}

// Best effort: a home directory that cannot be written must not stop a run.
export function recordLastSession(ref: SessionRef): void {
  try {
    fs.mkdirSync(vantageHome(), { recursive: true });
    fs.writeFileSync(lastSessionPath(), JSON.stringify(ref) + "\n");
    fs.appendFileSync(sessionIndexPath(), JSON.stringify(ref) + "\n");
  } catch {
    /* watch, stats and search then only see sessions in their own directory */
  }
}

// Is the process still there? Signal 0 only checks; EPERM means it exists but
// belongs to someone else. Works on Windows too.
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Running = no session_end yet and its `vantage run` process is alive. Only
// the first and last lines of the log are read, so this stays cheap for long
// sessions. Logs from before the pid was recorded count as running while
// they were written to in the last 30 minutes.
export function sessionRunning(ref: SessionRef, nowMs = Date.now()): boolean {
  const file = sessionEventsPath(ref.cwd, ref.sessionId);
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    fd = fs.openSync(file, "r");
    const headBuf = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    const tailLen = Math.min(size, 4096);
    const tailBuf = Buffer.alloc(tailLen);
    fs.readSync(fd, tailBuf, 0, tailLen, size - tailLen);
    const last = tailBuf.toString("utf8").trim().split("\n").at(-1) ?? "";
    if (last.includes('"type":"session_end"')) return false;
    const first = headBuf.toString("utf8").split("\n")[0] ?? "";
    const pid = (JSON.parse(first) as { pid?: unknown }).pid;
    if (typeof pid === "number") return processAlive(pid);
    return nowMs - fs.statSync(file).mtimeMs < 30 * 60_000;
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// A session by id: in `cwd` first, then anywhere this machine recorded it.
export function findSession(sessionId: string, cwd: string): SessionRef | null {
  if (fs.existsSync(sessionEventsPath(cwd, sessionId))) return { cwd, sessionId };
  return knownSessions().find((r) => r.sessionId === sessionId) ?? null;
}

// Every session this machine has recorded, plus those found in `cwd` (older
// sessions predate the index). Sessions whose log is gone are skipped.
export function knownSessions(cwd?: string): SessionRef[] {
  const seen = new Map<string, SessionRef>();
  const add = (ref: SessionRef): void => {
    const key = `${path.resolve(ref.cwd)}|${ref.sessionId}`;
    if (!seen.has(key) && fs.existsSync(sessionEventsPath(ref.cwd, ref.sessionId))) seen.set(key, ref);
  };
  try {
    for (const line of fs.readFileSync(sessionIndexPath(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as Partial<SessionRef>;
        if (typeof r.cwd === "string" && typeof r.sessionId === "string") add({ cwd: r.cwd, sessionId: r.sessionId });
      } catch {
        /* skip a damaged line */
      }
    }
  } catch {
    /* no index yet */
  }
  if (cwd) {
    const base = path.join(cwd, ".vantage", "sessions");
    try {
      for (const id of fs.readdirSync(base)) add({ cwd, sessionId: id });
    } catch {
      /* no sessions here */
    }
  }
  return [...seen.values()];
}

function statSignature(p: string): string {
  try {
    const s = fs.statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
}

// knownSessions() for a loop that asks every half second: the list is built
// again only when the index or the project's session folder changed, and at
// least every `maxAgeMs` (a session folder can appear before its log).
export class SessionList {
  private signature = "";
  private builtAt = 0;
  private refs: SessionRef[] = [];
  private readonly cwd: string | undefined;
  private readonly maxAgeMs: number;

  constructor(cwd?: string, maxAgeMs = 5000) {
    this.cwd = cwd;
    this.maxAgeMs = maxAgeMs;
  }

  get(nowMs = Date.now()): SessionRef[] {
    const signature = [sessionIndexPath(), ...(this.cwd ? [path.join(this.cwd, ".vantage", "sessions")] : [])].map(statSignature).join("|");
    if (signature !== this.signature || nowMs - this.builtAt >= this.maxAgeMs) {
      this.refs = knownSessions(this.cwd);
      this.signature = signature;
      this.builtAt = nowMs;
    }
    return this.refs;
  }
}

export function readLastSession(): SessionRef | null {
  try {
    const ref = JSON.parse(fs.readFileSync(lastSessionPath(), "utf8")) as Partial<SessionRef>;
    if (typeof ref.cwd !== "string" || typeof ref.sessionId !== "string") return null;
    // The project may have been moved or its sessions deleted since.
    if (!fs.existsSync(sessionEventsPath(ref.cwd, ref.sessionId))) return null;
    return { cwd: ref.cwd, sessionId: ref.sessionId };
  } catch {
    return null;
  }
}
