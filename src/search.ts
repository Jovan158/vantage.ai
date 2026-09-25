// `vantage search <text>`: which session did what.
//
//   vantage search fetch.ts            which sessions read or changed it
//   vantage search "npm publish"       when it ran, or was blocked
//   vantage search --commands push     only shell commands
//
// Searches every session this machine recorded (plus those in the current
// directory): your messages, Claude's replies, the file or command of every
// tool call, files changed at the end, blocked or questioned calls, and
// secret warnings. Case-insensitive substring match — what you would type.

import type { VantageEvent } from "./events.ts";
import type { SessionRef } from "./home.ts";
import { shortenPaths } from "./replay.ts";
import { plain } from "./sanitize.ts";
import { agentShort } from "./agents/index.ts";

export type HitKind = "message" | "reply" | "file" | "command" | "call" | "changed" | "blocked" | "asked" | "secret";

export interface Hit {
  ts: number;
  kind: HitKind;
  /** For blocked/asked: whether the call was about a file or a command. */
  about?: "file" | "command";
  /** Short verb shown before the text: "edited", "ran", "you", … */
  label: string;
  text: string;
}

export interface SessionHits {
  ref: SessionRef;
  project: string;
  startedMs: number;
  hits: Hit[];
}

export type Scope = "all" | "files" | "commands";

const FILE_TOOLS: Record<string, string> = {
  Read: "read",
  Write: "wrote",
  Edit: "edited",
  MultiEdit: "edited",
  NotebookEdit: "edited",
  NotebookRead: "read",
};

function callHit(ts: number, tool: string, target: string | undefined): Hit {
  if (tool in FILE_TOOLS && target) return { ts, kind: "file", label: FILE_TOOLS[tool]!, text: target };
  if (/^(Bash|BashOutput|PowerShell)$/.test(tool) && target) return { ts, kind: "command", label: "ran", text: target };
  return { ts, kind: "call", label: tool, text: target ?? "" };
}

function inScope(h: Hit, scope: Scope): boolean {
  if (scope === "files") return h.kind === "file" || h.kind === "changed" || h.about === "file";
  if (scope === "commands") return h.kind === "command" || h.about === "command";
  return true;
}

export function searchSession(ref: SessionRef, events: VantageEvent[], query: string, scope: Scope = "all"): SessionHits | null {
  const start = events.find((e) => e.type === "session_start");
  if (!start || start.type !== "session_start") return null;
  const project = start.project ?? ref.cwd;
  const agent = agentShort(start.agent).toLowerCase();
  const needle = query.toLowerCase();
  const hits: Hit[] = [];
  const add = (h: Hit): void => {
    if (!inScope(h, scope)) return;
    // The text only: labels like "claude" or "ran" would match every hit.
    if (!h.text.toLowerCase().includes(needle)) return;
    hits.push({ ...h, text: shortenPaths(h.text, project) });
  };

  // The agent's tool loop resends your last message with every model call;
  // it is one message, so it is one hit.
  let lastPrompt: string | undefined;
  for (const e of events) {
    const ts = Date.parse(e.ts);
    if (e.type === "usage" && !e.background) {
      if (e.prompt && e.prompt !== lastPrompt) add({ ts, kind: "message", label: "you", text: e.prompt });
      lastPrompt = e.prompt ?? lastPrompt;
      if (e.text) add({ ts, kind: "reply", label: agent, text: e.text });
      const calls: Array<{ tool: string; target?: string }> = e.calls ?? (e.tools ?? []).map((tool) => ({ tool }));
      for (const k of calls) add(callHit(ts, k.tool, k.target));
    } else if (e.type === "decision") {
      const call = callHit(ts, e.tool, e.target);
      const about = call.kind === "file" || call.kind === "command" ? call.kind : undefined;
      add({ ts, kind: e.decision === "deny" ? "blocked" : "asked", label: e.decision === "deny" ? "blocked" : "asked", text: `${e.tool} ${e.target ?? ""}`.trim(), ...(about ? { about } : {}) });
    } else if (e.type === "secret") {
      add({ ts, kind: "secret", label: "secret sent", text: `${e.kind} from ${e.source}` });
    } else if (e.type === "session_end" && e.changes) {
      for (const file of e.changes.files) add({ ts, kind: "changed", label: "changed", text: file });
    }
  }
  if (hits.length === 0) return null;
  return { ref, project, startedMs: Date.parse(start.ts), hits };
}

// ---------------------------------------------------------------------------

const C = { dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m", yellow: "\x1b[33m", red: "\x1b[31m" };
type Colors = typeof C;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function when(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function clockSecs(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

// Shows the match in context: a window around it, highlighted.
function excerpt(text: string, query: string, c: Colors, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  const i = one.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return one.length > max ? one.slice(0, max - 1) + "…" : one;
  const room = Math.max(0, max - query.length);
  let from = Math.max(0, i - Math.floor(room / 2));
  const to = Math.min(one.length, from + max);
  from = Math.max(0, to - max);
  const pre = (from > 0 ? "…" : "") + one.slice(from, i);
  const post = one.slice(i + query.length, to) + (to < one.length ? "…" : "");
  return `${pre}${c.bold}${c.yellow}${one.slice(i, i + query.length)}${c.reset}${post}`;
}

export interface SearchOptions {
  query: string;
  color?: boolean;
  width?: number;
  /** Most sessions to list; the rest are counted. */
  limit?: number;
}

export function renderSearch(results: SessionHits[], opts: SearchOptions): string {
  const c: Colors = opts.color === false ? (new Proxy({}, { get: () => "" }) as Colors) : C;
  const width = Math.max(60, Math.min(opts.width ?? 100, 160));
  const sorted = [...results].sort((a, z) => z.startedMs - a.startedMs);
  const total = sorted.reduce((n, r) => n + r.hits.length, 0);
  const lines: string[] = [];
  if (sorted.length === 0) {
    return `${c.dim}No session mentions "${opts.query}".${c.reset}`;
  }
  lines.push(`${c.bold}${total} match(es) in ${sorted.length} session(s)${c.reset} ${c.dim}for "${opts.query}", newest first${c.reset}`);
  const limit = opts.limit ?? 10;
  for (const r of sorted.slice(0, limit)) {
    const name = plain(r.project.split(/[\\/]/).filter(Boolean).at(-1) ?? r.project);
    lines.push("");
    lines.push(`${c.bold}${when(r.startedMs)}${c.reset}  ${name}  ${c.dim}vantage replay ${r.ref.sessionId}${c.reset}`);
    const shown = r.hits.slice(0, 8);
    for (const h of shown) {
      const color = h.kind === "blocked" || h.kind === "secret" ? c.red : "";
      lines.push(`  ${c.dim}${clockSecs(h.ts)}${c.reset}  ${color}${h.label.padEnd(11)}${color ? c.reset : ""} ${excerpt(h.text, opts.query, c, width - 26)}`);
    }
    if (r.hits.length > shown.length) lines.push(`  ${c.dim}… ${r.hits.length - shown.length} more in this session${c.reset}`);
  }
  if (sorted.length > limit) lines.push("", `${c.dim}… and ${sorted.length - limit} older session(s)${c.reset}`);
  return lines.join("\n");
}
