// `vantage sessions`, `vantage replay` and `vantage harvest`: looking back at
// recorded sessions.

import path from "node:path";
import { EventLog, sessionEventsPath } from "../events.ts";
import { renderTimeline, listSessions } from "../replay.ts";
import { newestSessionId, readSessionEvents } from "../watch.ts";
import { findSession, knownSessions, compactSessionIndex } from "../home.ts";
import { parseAge, planPrune, applyPrune, formatBytes } from "../prune.ts";
import { collectHarvest, renderHarvest } from "../harvest.ts";
import { formatCost } from "../pricing.ts";
import { gitSafe } from "../git.ts";
import { readMeta } from "../session-meta.ts";
import { log } from "./output.ts";
import { plain } from "../sanitize.ts";

export async function cmdSessions(argv: string[]): Promise<number> {
  if (argv[0] === "prune") return cmdPrune(argv.slice(1));
  if (argv[0]) {
    log(`unknown sessions command "${argv[0]}" (prune)`);
    return 1;
  }
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

// Lists what would go; deletes only with --yes.
async function cmdPrune(argv: string[]): Promise<number> {
  let ageRaw = "30d";
  let everywhere = false;
  let yes = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--all") everywhere = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--older-than") ageRaw = argv[++i] ?? "";
    else if (a.startsWith("--older-than=")) ageRaw = a.slice("--older-than=".length);
    else {
      log(`unknown option "${a}" — usage: vantage sessions prune [--older-than 30d] [--all] [--yes]`);
      return 1;
    }
  }
  const age = parseAge(ageRaw);
  if (age === null) {
    log(`--older-than needs an age like 30d, 12h or 2w (got "${ageRaw}")`);
    return 1;
  }

  const cwd = process.cwd();
  const same = (a: string, b: string): boolean => {
    const norm = (p: string): string => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
    return norm(a) === norm(b);
  };
  const refs = knownSessions(cwd).filter((r) => everywhere || same(r.cwd, cwd));
  const plan = planPrune(refs, age);
  const where = everywhere ? "recorded on this machine" : "in this project";

  for (const k of plan.kept) log(`kept ${k.ref.sessionId}: ${k.reason}`);
  if (plan.remove.length === 0) {
    log(`no sessions ${where} inactive for ${ageRaw}`);
    if (yes) compactSessionIndex();
    return 0;
  }

  const total = plan.remove.reduce((n, item) => n + item.bytes, 0);
  log(`${plan.remove.length} session(s) ${where} inactive for ${ageRaw} (${formatBytes(total)}):`);
  for (const item of plan.remove) {
    const last = new Date(item.lastActivityMs).toISOString().slice(0, 10);
    const project = everywhere ? `  ${plain(item.ref.cwd)}` : "";
    process.stdout.write(`  ${item.ref.sessionId}  last active ${last}  ${formatBytes(item.bytes).padStart(8)}${project}\n`);
  }
  if (!yes) {
    log("nothing deleted yet — run again with --yes to delete these");
    return 0;
  }
  const removed = applyPrune(plan);
  compactSessionIndex();
  log(`deleted ${removed} session(s)${removed < plan.remove.length ? `, ${plan.remove.length - removed} could not be removed` : ""}`);
  return removed < plan.remove.length ? 1 : 0;
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
