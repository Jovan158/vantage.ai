// A request's conversation, cut into the parts the secret scan reports on:
// the system prompt, each message, each tool call and each tool's output,
// every one labelled with where it came from. Each API format has its own
// cutter; the scan itself (src/secrets.ts) is the same for all.

import { toolTarget } from "../turn.ts";
import { stringValues } from "./openai.ts";

export interface ConversationPart {
  /** Identifies the part across requests: a long session resends it every turn. */
  key: string;
  text: string;
  /** Where it came from, e.g. "your message" or "the output of Read .env". */
  source: string;
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === "object" && typeof (b as Block).text === "string" ? (b as Block).text : "")).join("\n");
  return "";
}

// Anthropic Messages API: system, then messages of text, tool_use and
// tool_result blocks.
export function anthropicParts(body: unknown, agent = "Claude"): ConversationPart[] {
  if (!body || typeof body !== "object") return [];
  const req = body as { system?: unknown; messages?: Array<{ role?: string; content?: unknown }> };
  const parts: ConversationPart[] = [{ key: "system", text: blockText(req.system), source: "the system prompt (CLAUDE.md, memory)" }];
  const calls = new Map<string, string>();
  for (const m of req.messages ?? []) {
    if (!m || typeof m !== "object") continue;
    const blocks: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? (m.content as Block[]) : [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use") {
        const target = toolTarget(b.input);
        const label = `${b.name ?? "tool"}${target ? ` ${target}` : ""}`;
        if (b.id) calls.set(b.id, label);
        parts.push({ key: `use:${b.id ?? ""}`, text: stringValues(b.input), source: `${agent}'s ${label} call` });
      } else if (b.type === "tool_result") {
        parts.push({ key: `result:${b.tool_use_id ?? ""}`, text: blockText(b.content), source: `the output of ${calls.get(b.tool_use_id ?? "") ?? "a tool"}` });
      } else if (typeof b.text === "string") {
        parts.push({ key: `text:${m.role ?? ""}`, text: b.text, source: m.role === "assistant" ? `${agent}'s reply` : "your message" });
      }
    }
  }
  return parts;
}
