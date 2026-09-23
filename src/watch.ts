// Live session view for a SECOND terminal (tmux pane, split window).
//
// The wrapped agent owns its own terminal — Vantage runs it with inherited
// stdio precisely so its TUI is never redrawn or corrupted (CONCEPT.md §6b:
// observe, don't re-render). So the live meter does not overlay the agent;
// it renders here, driven by the append-only event log. Zero risk to the
// agent's UI, zero dependencies.

import fs from "node:fs";
import path from "node:path";
import { EventLog, sessionDir, type VantageEvent } from "./events.ts";
import { extractRateLimit, formatRateLimit } from "./ratelimit.ts";
import { summarizeActions, formatActionSummary } from "./policy.ts";
import { summarize } from "./replay.ts";
import { formatCost } from "./pricing.ts";

const C = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

function noColor(): typeof C {
  return new Proxy({}, { get: () => "" }) as typeof C;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, "0")}s`;
}

// Output tokens per minute over the trailing window of usage events.
function outputRate(events: VantageEvent[], nowMs: number, windowMs = 60_000): number {
  const points = events
    .filter((e): e is Extract<VantageEvent, { type: "usage" }> => e.type === "usage")
    .map((e) => ({ t: Date.parse(e.ts), out: e.out }))
    .filter((p) => nowMs - p.t <= windowMs);
  if (points.length === 0) return 0;
  const span = Math.max(1000, nowMs - points[0]!.t);
  const total = points.reduce((a, p) => a + p.out, 0);
  return (total / span) * 60_000;
}

export interface LiveOptions {
  sessionId: string;
  nowMs?: number;
  color?: boolean;
}

// One full frame of the live view. Pure: same inputs, same string.
export function renderLive(events: VantageEvent[], opts: LiveOptions): string {
  const c = opts.color === false ? noColor() : C;
  const now = opts.nowMs ?? Date.now();
  const s = summarize(opts.sessionId, events);
  const start = s.startedAt ? Date.parse(s.startedAt) : now;
  const ended = events.some((e) => e.type === "session_end");

  const lines: string[] = [];
  const dot = ended ? `${c.gray}●${c.reset}` : `${c.green}●${c.reset}`;
  const state = ended
    ? `${c.gray}ended${s.exitCode != null ? ` (exit ${s.exitCode})` : ""}${c.reset}`
    : `${c.green}running${c.reset}`;

  lines.push(`${dot} ${c.bold}vantage${c.reset} ${c.dim}·${c.reset} ${s.agent ?? "?"} ${c.dim}·${c.reset} ${state} ${c.dim}· ${fmtElapsed(now - start)}${c.reset}`);
  lines.push(`${c.dim}${opts.sessionId}${c.reset}`);
  lines.push("");

  // Headline numbers.
  lines.push(
    `  ${c.dim}turns${c.reset}  ${c.bold}${s.requests}${c.reset}` +
      `   ${c.dim}in${c.reset} ${fmtTokens(s.input)}` +
      `   ${c.dim}out${c.reset} ${c.green}${fmtTokens(s.output)}${c.reset}` +
      `   ${c.dim}cache${c.reset} ${fmtTokens(s.cacheRead)}r/${fmtTokens(s.cacheWrite)}w`
  );
  const rate = Math.round(outputRate(events, now));
  lines.push(
    `  ${c.dim}cost${c.reset}   ${c.bold}${formatCost(s.costUsd, s.unpriced, s.requests)}${c.reset}` +
      (rate > 0 && !ended ? `   ${c.dim}rate${c.reset} ${fmtTokens(rate)}/min` : "")
  );

  // Quota — the answer to "will I hit a limit mid-work".
  const lastRl = [...events].reverse().find((e) => e.type === "ratelimit");
  if (lastRl && lastRl.type === "ratelimit") {
    const snap = extractRateLimit(lastRl.raw);
    const line = snap ? formatRateLimit(snap, now) : null;
    if (line) lines.push(`  ${c.yellow}${line}${c.reset}`);
  }

  // A reached budget changes how the agent runs, so it stays in view.
  const lastBudget = [...events].reverse().find((e) => e.type === "budget");
  if (lastBudget && lastBudget.type === "budget" && lastBudget.state === "reached") {
    lines.push(`  ${c.red}budget reached${c.reset} ${c.dim}· ${lastBudget.reason} · actions need approval${c.reset}`);
  }

  // What the agent has been doing.
  const allTools: string[] = [];
  for (const e of events) if (e.type === "usage" && e.tools) allTools.push(...e.tools);
  const actions = formatActionSummary(summarizeActions(allTools));
  if (actions) lines.push(`  ${c.dim}actions${c.reset} ${actions}`);

  // Most recent turn, so you can see the current intent at a glance.
  const lastTurn = [...events].reverse().find((e) => e.type === "usage");
  if (lastTurn && lastTurn.type === "usage") {
    lines.push("");
    lines.push(`  ${c.cyan}latest turn${c.reset} ${c.dim}${lastTurn.model ?? "?"}${c.reset}`);
    if (lastTurn.prompt) lines.push(`    ${c.dim}prompt${c.reset} ${clip(lastTurn.prompt, 160)}`);
    if (lastTurn.text) lines.push(`    ${c.dim}reply${c.reset}  ${clip(lastTurn.text, 160)}`);
    if (lastTurn.tools?.length) lines.push(`    ${c.dim}tools${c.reset}  ${lastTurn.tools.join(", ")}`);
  }

  lines.push("");
  lines.push(`${c.dim}${ended ? "session finished" : "watching… Ctrl-C to stop"}${c.reset}`);
  return lines.join("\n");
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Newest session id on disk (ids are timestamp-prefixed, so lexicographic
// order is chronological), or null when none exist yet.
export function newestSessionId(cwd: string): string | null {
  const base = path.join(cwd, ".vantage", "sessions");
  if (!fs.existsSync(base)) return null;
  const ids = fs.readdirSync(base).filter((id) => fs.existsSync(path.join(sessionDir(cwd, id), "events.jsonl")));
  if (ids.length === 0) return null;
  return ids.sort().at(-1) ?? null;
}

export function readSessionEvents(cwd: string, sessionId: string): VantageEvent[] {
  const file = path.join(sessionDir(cwd, sessionId), "events.jsonl");
  if (!fs.existsSync(file)) return [];
  try {
    return new EventLog(file).readAll();
  } catch {
    return []; // a half-written final line; the next poll picks it up
  }
}
