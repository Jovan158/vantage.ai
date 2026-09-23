// Per-user state under ~/.vantage (not per project): the price list from
// `vantage pricing update`, and a pointer to the most recently started
// session so `vantage watch` finds it from any directory.
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

// Best effort: a home directory that cannot be written must not stop a run.
export function recordLastSession(ref: SessionRef): void {
  try {
    fs.mkdirSync(vantageHome(), { recursive: true });
    fs.writeFileSync(lastSessionPath(), JSON.stringify(ref) + "\n");
  } catch {
    /* watch then only finds sessions in its own directory */
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
