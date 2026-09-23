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
import { summarize, relativeTarget } from "./replay.ts";
import { formatCost } from "./pricing.ts";
import { readLastSession, type SessionRef } from "./home.ts";

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

type Colors = typeof C;
type Usage = Extract<VantageEvent, { type: "usage" }>;

function noColor(): Colors {
  return new Proxy({}, { get: () => "" }) as Colors;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

// "45s", "12m", "3h20m", "1d 9h".
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? String(m % 60).padStart(2, "0") + "m" : ""}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Local clock time; with the weekday when it is not today.
function clock(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date(nowMs).toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`;
}

function clockSecs(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

function fit(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, Math.max(0, max - 1)) + "…" : one;
}

function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// Green while there is room, yellow when it gets tight, red near the end.
function levelColor(c: Colors, fraction: number): string {
  return fraction >= 0.9 ? c.red : fraction >= 0.7 ? c.yellow : c.green;
}

export interface LiveOptions {
  sessionId: string;
  /** Shown when the session belongs to another directory than watch's. */
  project?: string;
  nowMs?: number;
  color?: boolean;
  /** Terminal width; lines are fitted to it. */
  width?: number;
}

interface Snapshot {
  ts: number;
  snap: NonNullable<ReturnType<typeof extractRateLimit>>;
}

function describeCalls(e: Usage, project: string | undefined): string {
  const calls: Array<{ tool: string; target?: string }> = e.calls ?? (e.tools ?? []).map((tool) => ({ tool }));
  return calls.map((k) => (k.target ? `${k.tool} ${relativeTarget(k.target, project)}` : k.tool)).join(", ");
}

// One frame of the live view. Pure: same inputs, same string. Every line
// answers something you want to know mid-session: what is Claude doing, will
// my limit hold, what did it touch, what does it cost.
export function renderLive(events: VantageEvent[], opts: LiveOptions): string {
  const c = opts.color === false ? noColor() : C;
  const now = opts.nowMs ?? Date.now();
  const width = Math.max(50, Math.min(opts.width ?? 80, 140));
  const s = summarize(opts.sessionId, events);
  const at = (e: { ts: string }): number => Date.parse(e.ts);

  const start = events.find((e) => e.type === "session_start");
  const end = events.find((e) => e.type === "session_end");
  const turns = events.filter((e): e is Usage => e.type === "usage" && !e.background);
  const lastTurn = turns.at(-1);
  const lastRequest = events.filter((e) => e.type === "request").at(-1);
  const lastDecision = events.filter((e) => e.type === "decision").at(-1);
  const snapshots: Snapshot[] = [];
  for (const e of events) {
    if (e.type !== "ratelimit") continue;
    const snap = extractRateLimit(e.raw);
    if (snap) snapshots.push({ ts: at(e), snap });
  }
  const latest = snapshots.at(-1)?.snap;
  const windows = latest?.unified?.windows ?? [];
  const onSubscription = windows.length > 0;

  const lines: string[] = [];
  const section = (title: string, extra = ""): void => {
    lines.push("");
    lines.push(`${c.bold}${title}${c.reset}${extra ? `${c.dim} · ${extra}${c.reset}` : ""}`);
  };

  // --- Header: which session, how long, which model, where.
  const startedMs = start ? at(start) : now;
  const endedMs = end ? at(end) : null;
  const projectPath = opts.project ?? (start?.type === "session_start" ? start.project : undefined);
  // Folder name only (the log may come from Windows or POSIX); the full path
  // when watching a session from another directory.
  const projectName = projectPath ? opts.project ?? projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath : null;
  const state =
    end && end.type === "session_end"
      ? `${c.gray}ended${end.exitCode != null ? ` (exit ${end.exitCode})` : ""}${c.reset}`
      : `${c.green}running${c.reset}`;
  lines.push(
    `${c.bold}vantage${c.reset} ${c.dim}·${c.reset} ${state} ` +
      `${c.dim}· ${span((endedMs ?? now) - startedMs)}` +
      `${lastTurn?.model ? ` · ${lastTurn.model}` : ""}${projectName ? ` · ${fit(projectName, 40)}` : ""}${c.reset}`
  );
  lines.push(`${c.dim}${opts.sessionId}${c.reset}`);

  // --- Status: one sentence on what is happening right now.
  lines.push("");
  const newest = (...ts: Array<number | undefined>): number => Math.max(...ts.map((t) => t ?? -Infinity));
  if (end) {
    lines.push(`${c.dim}Session finished ${span(now - (endedMs ?? now))} ago — full timeline: vantage replay ${opts.sessionId}${c.reset}`);
  } else if (
    // Claude Code runs the hook while the reply is still streaming, so the
    // question can predate the turn's usage record. It is open until Claude
    // sends its next request — which happens once you have answered.
    lastDecision?.type === "decision" &&
    lastDecision.decision === "ask" &&
    at(lastDecision) >= newest(lastRequest && at(lastRequest))
  ) {
    lines.push(`${c.yellow}${c.bold}Waiting for your approval in Claude Code:${c.reset} ${fit(`${lastDecision.tool} ${relativeTarget(lastDecision.target ?? "", projectPath)}`, width - 40)}`);
  } else if (lastRequest && (!lastTurn || at(lastRequest) > at(lastTurn))) {
    lines.push(`${c.cyan}${c.bold}Claude is thinking…${c.reset} ${c.dim}${span(now - at(lastRequest))}${c.reset}`);
  } else if (lastTurn?.stopReason === "tool_use") {
    lines.push(`${c.cyan}${c.bold}Claude is working:${c.reset} ${fit(describeCalls(lastTurn, projectPath), width - 20)}`);
  } else if (lastTurn) {
    lines.push(`${c.green}${c.bold}Claude replied.${c.reset} ${c.dim}${span(now - at(lastTurn))} ago${c.reset}`);
  } else {
    lines.push(`${c.dim}Waiting for the first message…${c.reset}`);
  }

  // --- Limits: will the quota hold?
  if (onSubscription) {
    section("Limits");
    const label = (key: string): string => (key === "5h" ? "5-hour" : key === "7d" ? "weekly" : key);
    const ordered = [...windows].sort((a, z) => (a.key === "5h" ? -1 : z.key === "5h" ? 1 : 0));
    for (const w of ordered) {
      if (w.utilization == null) continue;
      const pct = `${Math.round(w.utilization * 100)}%`.padStart(4);
      const reset = w.resetUnix != null ? `resets ${clock(w.resetUnix * 1000, now)} (in ${span(w.resetUnix * 1000 - now)})` : "";
      lines.push(`  ${label(w.key).padEnd(7)} ${levelColor(c, w.utilization)}${bar(w.utilization, 20)}${c.reset} ${c.bold}${pct}${c.reset}  ${c.dim}${reset}${c.reset}`);
    }
    const status = latest?.unified?.status;
    if (status === "rejected") lines.push(`  ${c.red}${c.bold}Limit reached — Anthropic is rejecting requests until the reset.${c.reset}`);
    else if (status && status !== "allowed") lines.push(`  ${c.yellow}Anthropic reports you are close to your limit.${c.reset}`);

    // Share of the 5-hour window used since this session started, and whether
    // the current pace runs it out before it resets. The windows are account-
    // wide, so other Claude use in the meantime counts too.
    const fiveH = snapshots
      .map((x) => ({ ts: x.ts, w: x.snap.unified?.windows.find((w) => w.key === "5h") }))
      .filter((x): x is { ts: number; w: NonNullable<typeof x.w> } => x.w?.utilization != null);
    const first = fiveH[0];
    const last = fiveH.at(-1);
    if (first && last) {
      const delta = last.w.utilization! - first.w.utilization!;
      const notes: string[] = [];
      if (delta >= 0.005) notes.push(`this session so far: +${Math.round(delta * 100)}% of the 5-hour limit`);
      let warning: string | null = null;
      const elapsed = last.ts - first.ts;
      if (delta > 0 && elapsed >= 120_000 && last.w.resetUnix != null && !end) {
        const fullAt = last.ts + ((1 - last.w.utilization!) / delta) * elapsed;
        if (fullAt < last.w.resetUnix * 1000) {
          warning = `At this pace the 5-hour limit runs out around ${clock(fullAt, now)}, before it resets.`;
        } else {
          notes.push("at this pace it lasts until the reset");
        }
      }
      if (notes.length) lines.push(`  ${c.dim}${notes.join(" · ")}${c.reset}`);
      if (warning) lines.push(`  ${c.red}${c.bold}${warning}${c.reset}`);
    }
  } else if (latest) {
    const line = formatRateLimit(latest, now);
    if (line) {
      section("Limits");
      lines.push(`  ${c.yellow}${line}${c.reset}`);
    }
  }

  // --- This session: turns, cost, budget, context.
  section("This session");
  // Claude calls the model again after every tool it runs, carrying your
  // last message along — so a new message is a turn whose prompt changed.
  let messages = 0;
  let previous: string | undefined;
  for (const e of turns) {
    if (e.prompt && e.prompt !== previous) messages += 1;
    previous = e.prompt ?? previous;
  }
  const callCount = turns.reduce((n, e) => n + (e.calls?.length ?? e.tools?.length ?? 0), 0);
  lines.push(
    `  ${c.dim}work${c.reset}     ${c.bold}${messages}${c.reset} message(s) from you` +
      `${c.dim}  →  ${c.reset}${s.turns} model call(s)${callCount ? `, ${callCount} tool call(s)` : ""}`
  );
  lines.push(
    `  ${c.dim}cost${c.reset}     ${c.bold}${formatCost(s.costUsd, s.unpriced, s.requests)}${c.reset}` +
      (onSubscription ? `${c.dim}  API-equivalent; on your subscription the limits above count${c.reset}` : "")
  );
  const budget = start?.type === "session_start" ? start.budget : undefined;
  const reached = events.filter((e) => e.type === "budget").at(-1);
  if (budget) {
    const parts: string[] = [];
    if (budget.maxCostUsd != null) {
      const used = s.costUsd / budget.maxCostUsd;
      parts.push(`${levelColor(c, used)}${bar(used, 10)}${c.reset} ${Math.round(used * 100)}% of $${budget.maxCostUsd}`);
    }
    if (budget.maxQuota != null) parts.push(`approval needed from ${Math.round(budget.maxQuota * 100)}% quota`);
    lines.push(`  ${c.dim}budget${c.reset}   ${parts.join(`${c.dim}  ·  ${c.reset}`)}`);
    if (reached?.type === "budget" && reached.state === "reached") {
      lines.push(`  ${c.red}${c.bold}Budget reached — every action now needs your approval.${c.reset}`);
    }
  }
  if (lastTurn) {
    const context = lastTurn.in + lastTurn.cache_read + lastTurn.cache_write;
    const allInput = turns.reduce((n, e) => n + e.in + e.cache_read + e.cache_write, 0);
    const cached = turns.reduce((n, e) => n + e.cache_read, 0);
    lines.push(
      `  ${c.dim}context${c.reset}  ${c.bold}${fmtTokens(context)}${c.reset} tokens sent with the last message` +
        (allInput ? `${c.dim}  ·  ${Math.round((cached / allInput) * 100)}% of all input came from cache${c.reset}` : "")
    );
  }

  // --- The conversation, latest exchange.
  if (lastTurn) {
    section("Latest");
    const room = width - 10;
    lines.push(`  ${c.dim}you${c.reset}     ${lastTurn.prompt ? fit(lastTurn.prompt, room) : `${c.dim}(not captured)${c.reset}`}`);
    const reply = lastTurn.text ? fit(lastTurn.text, room * 2) : lastTurn.stopReason === "tool_use" ? `${c.dim}(went straight to tools)${c.reset}` : "";
    if (reply) lines.push(`  ${c.dim}claude${c.reset}  ${reply}`);
  }

  // --- Activity: what Claude did, with what it touched, and what was stopped.
  interface Entry {
    ts: number;
    tool: string;
    target?: string;
    mark?: "deny" | "ask";
    /** Entry made from a decision before its call was logged. */
    awaitingCall?: boolean;
  }
  const entries: Entry[] = [];
  const allTools: string[] = [];
  for (const e of events) {
    if (e.type === "usage" && !e.background) {
      allTools.push(...(e.tools ?? []));
      const calls: Array<{ tool: string; target?: string }> = e.calls ?? (e.tools ?? []).map((tool) => ({ tool }));
      for (const k of calls) {
        // The hook may have decided on this call already (see status above).
        const decided = entries.find((x) => x.awaitingCall && x.tool === k.tool && x.target === k.target);
        if (decided) decided.awaitingCall = false;
        else entries.push({ ts: at(e), tool: k.tool, ...(k.target ? { target: k.target } : {}) });
      }
    } else if (e.type === "decision") {
      // Mark the logged call if it is already there, else note the decision
      // and let the call join it when its turn is logged.
      const match = [...entries].reverse().find((x) => x.tool === e.tool && x.target === e.target && !x.mark);
      if (match) match.mark = e.decision;
      else entries.push({ ts: at(e), tool: e.tool, ...(e.target ? { target: e.target } : {}), mark: e.decision, awaitingCall: true });
    }
  }
  const edited = new Set(entries.filter((x) => x.target && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(x.tool)).map((x) => x.target));
  const summary = [formatActionSummary(summarizeActions(allTools)), edited.size ? `${edited.size} file(s) edited` : null]
    .filter(Boolean)
    .join(" · ");
  section("Activity", summary);
  if (entries.length === 0) {
    lines.push(`  ${c.dim}no tool calls yet${c.reset}`);
  } else {
    const shown = entries.slice(-6);
    if (entries.length > shown.length) lines.push(`  ${c.dim}… ${entries.length - shown.length} earlier${c.reset}`);
    for (const x of shown) {
      const mark =
        x.mark === "deny" ? `${c.red}blocked ${c.reset}` : x.mark === "ask" ? `${c.yellow}asked   ${c.reset}` : "        ";
      lines.push(`  ${c.dim}${clockSecs(x.ts)}${c.reset}  ${mark}${x.tool.padEnd(9)} ${fit(relativeTarget(x.target ?? "", projectPath), width - 32)}`);
    }
  }

  lines.push("");
  lines.push(`${c.dim}${end ? "session finished" : "Ctrl-C stops watching — Claude keeps running"}${c.reset}`);
  return lines.join("\n");
}

// The session `vantage watch` should show: the newest one started from this
// directory, or — when a session was started elsewhere more recently — that
// one. Session ids start with their start time, so they compare as strings.
// A pinned id is looked up here first, then as the last started session.
export function findWatchTarget(cwd: string, pinned?: string): SessionRef | null {
  const last = readLastSession();
  if (pinned) {
    if (fs.existsSync(path.join(sessionDir(cwd, pinned), "events.jsonl"))) return { cwd, sessionId: pinned };
    return last && last.sessionId === pinned ? last : null;
  }
  const local = newestSessionId(cwd);
  if (local && (!last || local >= last.sessionId)) return { cwd, sessionId: local };
  return last;
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
