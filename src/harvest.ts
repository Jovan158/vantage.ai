// Assisted memory harvest (⑤, closing the loop).
//
// Deliberately NOT an automatic LLM distillation at session end. Two reasons:
// an LLM call after every session would silently burn quota — the very problem
// ① exists to prevent — and a wrong auto-written entry poisons every later
// session, because memory is injected into the agent's context. The concept
// said it too: always confirmed, never silently written.
//
// So this prepares the material and the exact command; a human decides what
// becomes memory. The best no-LLM summary we have is the agent's own closing
// reply, which usually states what it did.

import type { VantageEvent } from "./events.ts";
import { summarize } from "./replay.ts";
import { summarizeActions, formatActionSummary } from "./policy.ts";
import { formatCost } from "./pricing.ts";

const C = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
};

function noColor(): typeof C {
  return new Proxy({}, { get: () => "" }) as typeof C;
}

export interface Harvest {
  sessionId: string;
  turns: number;
  costUsd: number;
  unpriced: number;
  /** The agent's own closing summary — the most useful no-LLM signal. */
  closingReply: string | null;
  actions: string | null;
  files: string[];
}

export function collectHarvest(
  sessionId: string,
  events: VantageEvent[],
  changedFiles: string[] = []
): Harvest {
  const s = summarize(sessionId, events);
  const tools: string[] = [];
  let closingReply: string | null = null;
  for (const e of events) {
    if (e.type !== "usage") continue;
    if (e.tools) tools.push(...e.tools);
    // Keep the last non-empty reply that reads like prose rather than the
    // agent's internal JSON state blob.
    if (e.text && !e.text.trimStart().startsWith("{")) closingReply = e.text;
  }
  return {
    sessionId,
    turns: s.requests,
    costUsd: s.costUsd,
    unpriced: s.unpriced,
    closingReply,
    actions: formatActionSummary(summarizeActions(tools)),
    files: changedFiles,
  };
}

// Shell-safe double-quoted string for the suggested command.
function shellQuote(s: string): string {
  return `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

export function renderHarvest(h: Harvest, color = true): string {
  const c = color ? C : noColor();
  const lines: string[] = [];

  lines.push(`${c.bold}harvest${c.reset} ${c.dim}· session ${h.sessionId}${c.reset}`);
  lines.push(`${c.dim}${h.turns} turn(s) · ${formatCost(h.costUsd, h.unpriced, h.turns)}${h.actions ? ` · ${h.actions}` : ""}${c.reset}`);
  lines.push("");

  if (h.closingReply) {
    lines.push(`  ${c.cyan}what the agent said it did${c.reset}`);
    lines.push(`    ${h.closingReply}`);
    lines.push("");
  }
  if (h.files.length) {
    lines.push(`  ${c.cyan}files changed${c.reset}`);
    for (const f of h.files.slice(0, 15)) lines.push(`    ${f}`);
    if (h.files.length > 15) lines.push(`    ${c.dim}… and ${h.files.length - 15} more${c.reset}`);
    lines.push("");
  }
  if (!h.closingReply && h.files.length === 0) {
    lines.push(`  ${c.dim}nothing substantial recorded in this session${c.reset}`);
    lines.push("");
  }

  lines.push(`${c.dim}Nothing is written automatically. Record what is worth keeping:${c.reset}`);
  const seed = h.closingReply ? shellQuote(h.closingReply) : '"…"';
  lines.push(`  vantage memory add decisions ${seed}`);
  lines.push(`  ${c.dim}(categories: decisions · architecture · conventions · glossary)${c.reset}`);
  return lines.join("\n");
}

// Did this session do enough to be worth a memory prompt at the end?
export function worthHarvesting(events: VantageEvent[], changedFiles = 0): boolean {
  if (changedFiles > 0) return true;
  for (const e of events) {
    if (e.type === "usage" && e.tools?.length) return true;
  }
  return false;
}
