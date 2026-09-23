// What `vantage run` records about a session besides its event log: where it
// ran, whether it was isolated, and the working-tree snapshots for the change
// summary. Read by review, discard and harvest.

import fs from "node:fs";
import path from "node:path";
import { sessionDir } from "./events.ts";

export interface SessionMeta {
  sessionId: string;
  agent: string;
  cwd: string;
  isolated: boolean;
  branch?: string;
  baseSha?: string;
  worktreePath?: string;
  createdAt: string;
  /** Working-tree snapshots (git tree ids) at start and end, when not isolated. */
  startTree?: string;
  endTree?: string;
}

export function writeMeta(cwd: string, meta: SessionMeta): void {
  const dir = sessionDir(cwd, meta.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

export function readMeta(cwd: string, sessionId: string): SessionMeta | null {
  const p = path.join(sessionDir(cwd, sessionId), "meta.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}
