// `vantage stats`: where the usage goes over days and projects.
//
// Everything comes from the session logs that already exist; nothing is
// fetched. The quota share per project is the rise of the weekly window
// during that project's sessions. The windows are account-wide, so other
// Claude use at the same time (another session, claude.ai) counts too, and
// the figure is labelled as approximate.

import path from "node:path";
import type { VantageEvent } from "./events.ts";
import { summarize } from "./replay.ts";
import { extractRateLimit } from "./ratelimit.ts";
import { formatCost } from "./pricing.ts";
import type { SessionRef } from "./home.ts";

export interface SessionStat {
  ref: SessionRef;
  /** Full project path: two projects named alike stay apart. */
  project: string;
  startedMs: number;
  messages: number;
  requests: number;
  costUsd: number;
  unpriced: number;
  tokens: number;
  filesChanged: number;
  firstPrompt: string | null;
  /** Rise of the 5-hour / weekly window during the session, 0..1. */
  quota5h: number;
  quota7d: number;
}

function windowRise(events: VantageEvent[], key: string): number {
  const values: number[] = [];
  for (const e of events) {
    if (e.type !== "ratelimit") continue;
    const w = extractRateLimit(e.raw)?.unified?.windows.find((x) => x.key === key);
    if (w?.utilization != null) values.push(w.utilization);
  }
  if (values.length < 2) return 0;
  // A reset inside the session drops the value; count only the rises.
  let rise = 0;
  for (let i = 1; i < values.length; i++) rise += Math.max(0, values[i]! - values[i - 1]!);
  return rise;
}

function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

export function sessionStat(ref: SessionRef, events: VantageEvent[]): SessionStat | null {
  const start = events.find((e) => e.type === "session_start");
  if (!start) return null;
  const s = summarize(ref.sessionId, events);
  const end = events.find((e) => e.type === "session_end");
  const firstTurn = events.find((e) => e.type === "usage" && !e.background && e.prompt);
  let tokens = 0;
  for (const e of events) if (e.type === "usage") tokens += e.in + e.out + e.cache_read + e.cache_write;
  return {
    ref,
    project: (start.type === "session_start" && start.project) || ref.cwd,
    startedMs: Date.parse(start.ts),
    messages: s.messages,
    requests: s.requests,
    costUsd: s.costUsd,
    unpriced: s.unpriced,
    tokens,
    filesChanged: end?.type === "session_end" ? (end.changes?.files.length ?? 0) : 0,
    firstPrompt: firstTurn?.type === "usage" ? (firstTurn.prompt ?? null) : null,
    quota5h: windowRise(events, "5h"),
    quota7d: windowRise(events, "7d"),
  };
}

// ---------------------------------------------------------------------------
// Rendering.

const C = { dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m", cyan: "\x1b[36m" };
type Colors = typeof C;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
}

function bar(fraction: number, width: number): string {
  const n = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return "█".repeat(n) + "░".repeat(width - n);
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

function pct(fraction: number): string {
  return fraction >= 0.005 ? `+${Math.round(fraction * 100)}%` : "–";
}

function fit(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

interface Group {
  sessions: number;
  messages: number;
  costUsd: number;
  unpriced: number;
  requests: number;
  quota7d: number;
  files: number;
}

function group(stats: SessionStat[], key: (s: SessionStat) => string): Map<string, Group> {
  const out = new Map<string, Group>();
  for (const s of stats) {
    const g = out.get(key(s)) ?? { sessions: 0, messages: 0, costUsd: 0, unpriced: 0, requests: 0, quota7d: 0, files: 0 };
    g.sessions += 1;
    g.messages += s.messages;
    g.costUsd += s.costUsd;
    g.unpriced += s.unpriced;
    g.requests += s.requests;
    g.quota7d += s.quota7d;
    g.files += s.filesChanged;
    out.set(key(s), g);
  }
  return out;
}

export interface StatsOptions {
  days: number;
  nowMs?: number;
  color?: boolean;
  /** Where the command runs; sessions elsewhere show their directory. */
  cwd?: string;
}

export function renderStats(all: SessionStat[], opts: StatsOptions): string {
  const c: Colors = opts.color === false ? (new Proxy({}, { get: () => "" }) as Colors) : C;
  const now = opts.nowMs ?? Date.now();
  // Whole days: today and the days before it.
  const first = new Date(now);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - (opts.days - 1));
  const stats = all.filter((s) => s.startedMs >= first.getTime() && s.startedMs <= now).sort((a, z) => a.startedMs - z.startedMs);

  const lines: string[] = [];
  const projects = new Set(stats.map((s) => s.project));
  // Folder names for display; with the parent folder when two share a name.
  const label = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const p of projects) byName.set(projectName(p), [...(byName.get(projectName(p)) ?? []), p]);
  for (const [n, paths] of byName) {
    for (const p of paths) {
      const parts = p.split(/[\\/]/).filter(Boolean);
      label.set(p, paths.length > 1 ? parts.slice(-2).join("/") : n);
    }
  }
  const show = (p: string): string => label.get(p) ?? projectName(p);
  lines.push(
    `${c.bold}Usage${c.reset} ${c.dim}· last ${opts.days} day(s) · ${stats.length} session(s) in ${projects.size} project(s)${c.reset}`
  );
  if (stats.length === 0) {
    lines.push("");
    lines.push(`${c.dim}No sessions in this period. Sessions started with \`vantage run\` show up here.${c.reset}`);
    return lines.join("\n");
  }

  const total = group(stats, () => "all").get("all")!;
  lines.push(
    `${c.dim}${total.messages} message(s) · ${formatCost(total.costUsd, total.unpriced, total.requests)} API-equivalent · ` +
      `weekly limit ≈ ${pct(total.quota7d)} · ${total.files} file change(s)${c.reset}`
  );

  // By day, every day of the period, busiest bar full width.
  lines.push("");
  lines.push(`${c.bold}By day${c.reset}`);
  const byDay = group(stats, (s) => dayKey(s.startedMs));
  const maxDay = Math.max(...[...byDay.values()].map((g) => g.costUsd), 0.000001);
  for (let d = new Date(first); d.getTime() <= now; d.setDate(d.getDate() + 1)) {
    const g = byDay.get(dayKey(d.getTime()));
    const label = dayLabel(d.getTime()).padEnd(11);
    if (!g) {
      lines.push(`  ${c.dim}${label} –${c.reset}`);
      continue;
    }
    lines.push(
      `  ${label} ${c.cyan}${bar(g.costUsd / maxDay, 12)}${c.reset} ${formatCost(g.costUsd, g.unpriced, g.requests).padEnd(9)} ` +
        `${c.dim}${String(g.sessions).padStart(2)} session(s) · ${g.messages} message(s) · weekly ${pct(g.quota7d)}${c.reset}`
    );
  }

  // By project, most expensive first.
  lines.push("");
  lines.push(`${c.bold}By project${c.reset} ${c.dim}· weekly limit share is approximate: other Claude use at the same time counts too${c.reset}`);
  const byProject = [...group(stats, (s) => s.project).entries()].sort((a, z) => z[1].costUsd - a[1].costUsd);
  const nameWidth = Math.min(24, Math.max(...byProject.map(([p]) => show(p).length)));
  for (const [project, g] of byProject) {
    lines.push(
      `  ${fit(show(project), nameWidth).padEnd(nameWidth)}  ${formatCost(g.costUsd, g.unpriced, g.requests).padEnd(9)} ` +
        `${c.dim}weekly ${pct(g.quota7d).padEnd(5)} ${String(g.sessions).padStart(2)} session(s) · ${g.messages} message(s) · ${g.files} file change(s)${c.reset}`
    );
  }

  // The sessions that cost the most, to see what drove the numbers.
  lines.push("");
  lines.push(`${c.bold}Largest sessions${c.reset}`);
  for (const s of stats.filter((x) => x.requests > 0).sort((a, z) => z.costUsd - a.costUsd).slice(0, 5)) {
    const d = new Date(s.startedMs);
    const when = `${dayLabel(s.startedMs)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    lines.push(
      `  ${formatCost(s.costUsd, s.unpriced, s.requests).padEnd(9)} ${c.dim}${when}  ${fit(show(s.project), 16).padEnd(16)}  ${fmtTokens(s.tokens).padStart(5)} tokens${c.reset}  ` +
        `${fit(s.firstPrompt ?? "(no prompt captured)", 60)}`
    );
    lines.push(`  ${c.dim}${" ".repeat(9)} vantage replay ${s.ref.sessionId}${opts.cwd && path.resolve(s.ref.cwd) === path.resolve(opts.cwd) ? "" : `   (in ${s.ref.cwd})`}${c.reset}`);
  }
  return lines.join("\n");
}
