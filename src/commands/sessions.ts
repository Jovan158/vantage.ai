// `vantage sessions`, `vantage replay` and `vantage harvest`: looking back at
// recorded sessions.

import path from "node:path";
import { EventLog, sessionEventsPath } from "../events.ts";
import { renderTimeline, listSessions } from "../replay.ts";
import { newestSessionId, readSessionEvents } from "../watch.ts";
import { findSession } from "../home.ts";
import { collectHarvest, renderHarvest } from "../harvest.ts";
import { formatCost } from "../pricing.ts";
import { gitSafe } from "../git.ts";
import { readMeta } from "../session-meta.ts";
import { log } from "./output.ts";

export async function cmdSessions(): Promise<number> {
  const cwd = process.cwd();
  const sessions = listSessions(cwd);
  if (sessions.length === 0) {
    log("no sessions recorded yet — run `vantage run <agent>` first");
    return 0;
  }
  for (const s of sessions) {
    const flags = s.isolated ? " [isolated]" : "";
    const when = s.startedAt ? s.startedAt.replace("T", " ").slice(0, 19) : "?";
    process.stdout.write(
      `${s.sessionId}${flags}\n` +
        `  ${when} · ${s.agent ?? "?"} · ${s.turns} turn(s) · ` +
        `out ${s.output} · ${formatCost(s.costUsd, s.unpriced, s.requests)}\n`
    );
  }
  log(`replay one with: vantage replay <sessionId>`);
  return 0;
}

export async function cmdReplay(argv: string[]): Promise<number> {
  const sessionId = argv[0];
  const cwd = process.cwd();
  if (!sessionId) {
    log("usage: vantage replay <sessionId>  (see: vantage sessions)");
    return 1;
  }
  const ref = findSession(sessionId, cwd);
  if (!ref) {
    log(`no session "${sessionId}" found here or among the sessions this machine recorded`);
    return 1;
  }
  if (path.resolve(ref.cwd) !== path.resolve(cwd)) log(`session from ${ref.cwd}`);
  const events = new EventLog(sessionEventsPath(ref.cwd, ref.sessionId)).readAll();
  process.stdout.write(renderTimeline(events, process.stdout.isTTY ?? false) + "\n");
  return 0;
}

export async function cmdHarvest(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const sessionId = argv[0] ?? newestSessionId(cwd);
  if (!sessionId) {
    log("usage: vantage harvest [sessionId]  (see: vantage sessions)");
    return 1;
  }
  const events = readSessionEvents(cwd, sessionId);
  if (events.length === 0) {
    log(`no session "${sessionId}" found under .vantage/sessions/`);
    return 1;
  }

  // Changed files come from the isolation branch when the session had one.
  let files: string[] = [];
  const meta = readMeta(cwd, sessionId);
  if (meta?.isolated && meta.branch && meta.baseSha) {
    const res = gitSafe(cwd, ["diff", "--name-only", meta.baseSha, meta.branch]);
    if (res.ok) files = res.stdout.split("\n").filter(Boolean);
  }

  const harvest = collectHarvest(sessionId, events, files);
  process.stdout.write(renderHarvest(harvest, process.stdout.isTTY ?? false) + "\n");
  return 0;
}
