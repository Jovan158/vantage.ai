// Session replay: render the append-only event log as a readable timeline
// (CONCEPT.md §4, problem ③). Pure functions over the events so they are easy
// to test; the CLI wires them to stdout.

import fs from "node:fs";
import path from "node:path";
import { EventLog, sessionDir, type VantageEvent } from "./events.ts";
import { extractRateLimit, formatRateLimit } from "./ratelimit.ts";
import { summarizeActions, formatActionSummary } from "./policy.ts";
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

function relTime(fromMs: number, toMs: number): string {
  const s = Math.max(0, (toMs - fromMs) / 1000);
  if (s < 10) return `+${s.toFixed(1)}s`;
  if (s < 600) return `+${Math.round(s)}s`;
  return `+${Math.round(s / 60)}m`;
}

function tally(names: string[]): string {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()].map(([n, k]) => (k > 1 ? `${n}×${k}` : n)).join(", ");
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

// Paths inside the project are shown relative to it; the log may come from
// Windows or POSIX, so both separators count.
export function relativeTarget(target: string, project: string | undefined): string {
  if (!project) return target;
  const root = project.replace(/[\\/]+$/, "");
  const lower = (x: string): string => (/^[a-z]:/i.test(x) ? x.toLowerCase() : x);
  if (lower(target).startsWith(lower(root)) && /[\\/]/.test(target.charAt(root.length))) {
    return target.slice(root.length + 1);
  }
  return target;
}

export interface SessionSummary {
  sessionId: string;
  agent: string | null;
  isolated: boolean;
  startedAt: string | null;
  /** Every metered request, background calls included (cost basis). */
  requests: number;
  /** Chat turns only — what the user would count. */
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  unpriced: number;
  exitCode: number | null | undefined;
}

export function summarize(sessionId: string, events: VantageEvent[]): SessionSummary {
  const s: SessionSummary = {
    sessionId,
    agent: null,
    isolated: false,
    startedAt: null,
    requests: 0,
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    unpriced: 0,
    exitCode: undefined,
  };
  for (const e of events) {
    if (e.type === "session_start") {
      s.agent = e.agent ?? null;
      s.startedAt = e.ts;
    } else if (e.type === "session_end") {
      s.exitCode = e.exitCode;
    } else if (e.type === "usage") {
      s.requests += 1;
      if (!e.background) s.turns += 1;
      s.input += e.in;
      s.output += e.out;
      s.cacheRead += e.cache_read;
      s.cacheWrite += e.cache_write;
      if (e.cost_usd === null) s.unpriced += 1;
      else s.costUsd += e.cost_usd;
    }
  }
  return s;
}

// A full, colorized timeline of one session.
export function renderTimeline(events: VantageEvent[], color = true): string {
  const c = color ? C : new Proxy({}, { get: () => "" }) as typeof C;
  const start = events.find((e) => e.type === "session_start");
  const startMs = start ? Date.parse(start.ts) : events[0] ? Date.parse(events[0].ts) : Date.now();
  const lines: string[] = [];
  let step = 0;
  const project = start?.type === "session_start" ? start.project : undefined;
  let lastQuota: string | null = null;
  const allTools: string[] = [];

  for (const e of events) {
    const at = `${c.gray}${relTime(startMs, Date.parse(e.ts)).padStart(6)}${c.reset}`;
    switch (e.type) {
      case "session_start":
        lines.push(`${c.bold}● session start${c.reset} ${c.dim}· agent ${e.agent ?? "?"}${c.reset}`);
        break;
      case "usage": {
        const model = e.model ?? "?";
        const cost = e.cost_usd === null ? "$? (price unknown)" : `$${e.cost_usd.toFixed(4)}`;
        // A call the agent made on its own: one dim line, so its cost is
        // visible without it posing as a step of the conversation.
        if (e.background) {
          lines.push(
            `${at} ${c.dim}· background call ${model} · in ${fmtTokens(e.in)} · out ${fmtTokens(e.out)} · ${cost}${c.reset}`
          );
          break;
        }
        step += 1;
        lines.push(
          `${at} ${c.cyan}▸ turn ${step}${c.reset} ${c.dim}${model}${c.reset} · ` +
            `in ${fmtTokens(e.in)} · out ${c.green}${fmtTokens(e.out)}${c.reset} · ` +
            `cache ${fmtTokens(e.cache_read)}${e.cache_write ? `r/${fmtTokens(e.cache_write)}w` : ""} · ${cost}`
        );
        if (e.prompt) lines.push(`         ${c.dim}prompt:${c.reset} ${e.prompt}`);
        if (e.text) lines.push(`         ${c.dim}reply:${c.reset}  ${e.text}`);
        if (e.tools && e.tools.length) {
          allTools.push(...e.tools);
          // With targets when recorded: "Edit src/app.ts, Bash npm test".
          const shown = e.calls
            ? e.calls.map((k) => (k.target ? `${k.tool} ${relativeTarget(k.target, project)}` : k.tool)).join(", ")
            : tally(e.tools);
          lines.push(`         ${c.dim}tools:${c.reset}  ${shown}`);
        }
        break;
      }
      case "ratelimit": {
        const snap = extractRateLimit(e.raw);
        const line = snap ? formatRateLimit(snap, Date.parse(e.ts)) : null;
        if (line && line !== lastQuota) {
          lines.push(`${at} ${c.yellow}◔ ${line}${c.reset}`);
          lastQuota = line;
        }
        break;
      }
      case "decision":
        lines.push(
          `${at} ${e.decision === "deny" ? `${c.red}⛔ blocked` : `${c.yellow}? asked you about`}${c.reset} ` +
            `${e.tool}${e.target ? ` ${relativeTarget(e.target, project)}` : ""} ${c.dim}· ${e.reason}${c.reset}`
        );
        break;
      case "budget":
        lines.push(
          e.state === "reached"
            ? `${at} ${c.red}⛔ budget reached${c.reset} ${c.dim}· ${e.reason} · actions need approval${c.reset}`
            : `${at} ${c.green}● budget cleared${c.reset} ${c.dim}· ${e.reason}${c.reset}`
        );
        break;
      case "session_end": {
        const s = summarize("", events);
        lines.push(
          `${at} ${c.bold}● session end${c.reset} ${c.dim}· ${s.turns} turn(s) · ` +
            `in ${fmtTokens(s.input)} · out ${fmtTokens(s.output)} · ` +
            `cache ${fmtTokens(s.cacheRead)}r/${fmtTokens(s.cacheWrite)}w · ` +
            formatCost(s.costUsd, s.unpriced, s.requests) +
            (e.exitCode != null ? ` · exit ${e.exitCode}` : "") +
            c.reset
        );
        const actions = formatActionSummary(summarizeActions(allTools));
        if (actions) lines.push(`         ${c.dim}actions:${c.reset} ${actions}`);
        break;
      }
    }
  }
  return lines.join("\n");
}

// List sessions found on disk, newest first.
export function listSessions(cwd: string): SessionSummary[] {
  const base = path.join(cwd, ".vantage", "sessions");
  if (!fs.existsSync(base)) return [];
  const out: SessionSummary[] = [];
  for (const id of fs.readdirSync(base)) {
    const log = new EventLog(path.join(sessionDir(cwd, id), "events.jsonl"));
    let events: VantageEvent[];
    try {
      events = log.readAll();
    } catch {
      continue;
    }
    if (events.length === 0) continue;
    const summary = summarize(id, events);
    const meta = readMetaIsolated(cwd, id);
    if (meta != null) summary.isolated = meta;
    out.push(summary);
  }
  return out.sort((a, z) => (z.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

function readMetaIsolated(cwd: string, id: string): boolean | null {
  const p = path.join(sessionDir(cwd, id), "meta.json");
  if (!fs.existsSync(p)) return null;
  try {
    return Boolean((JSON.parse(fs.readFileSync(p, "utf8")) as { isolated?: boolean }).isolated);
  } catch {
    return null;
  }
}
