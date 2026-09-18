// Session replay: render the append-only event log as a readable timeline
// (CONCEPT.md §4, problem ③). Pure functions over the events so they are easy
// to test; the CLI wires them to stdout.

import fs from "node:fs";
import path from "node:path";
import { EventLog, sessionDir, type VantageEvent } from "./events.ts";
import { extractRateLimit, formatRateLimit } from "./ratelimit.ts";

const C = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
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

export interface SessionSummary {
  sessionId: string;
  agent: string | null;
  isolated: boolean;
  startedAt: string | null;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
  exitCode: number | null | undefined;
}

export function summarize(sessionId: string, events: VantageEvent[]): SessionSummary {
  const s: SessionSummary = {
    sessionId,
    agent: null,
    isolated: false,
    startedAt: null,
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    costUsd: 0,
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
      s.input += e.in;
      s.output += e.out;
      s.cacheRead += e.cache_read;
      s.costUsd += e.cost_usd;
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
  let lastQuota: string | null = null;

  for (const e of events) {
    const at = `${c.gray}${relTime(startMs, Date.parse(e.ts)).padStart(6)}${c.reset}`;
    switch (e.type) {
      case "session_start":
        lines.push(`${c.bold}● session start${c.reset} ${c.dim}· agent ${e.agent ?? "?"}${c.reset}`);
        break;
      case "usage": {
        step += 1;
        const model = e.model ?? "?";
        const cost = `$${e.cost_usd.toFixed(4)}`;
        lines.push(
          `${at} ${c.cyan}▸ turn ${step}${c.reset} ${c.dim}${model}${c.reset} · ` +
            `in ${fmtTokens(e.in)} · out ${c.green}${fmtTokens(e.out)}${c.reset} · ` +
            `cache ${fmtTokens(e.cache_read)} · ${cost}`
        );
        if (e.prompt) lines.push(`         ${c.dim}prompt:${c.reset} ${e.prompt}`);
        if (e.text) lines.push(`         ${c.dim}reply:${c.reset}  ${e.text}`);
        if (e.tools && e.tools.length) {
          const counts = tally(e.tools);
          lines.push(`         ${c.dim}tools:${c.reset}  ${counts}`);
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
      case "session_end": {
        const s = summarize("", events);
        lines.push(
          `${at} ${c.bold}● session end${c.reset} ${c.dim}· ${s.requests} turn(s) · ` +
            `in ${fmtTokens(s.input)} · out ${fmtTokens(s.output)} · cache ${fmtTokens(s.cacheRead)} · ` +
            `~$${s.costUsd.toFixed(4)} (est.)` +
            (e.exitCode != null ? ` · exit ${e.exitCode}` : "") +
            c.reset
        );
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
