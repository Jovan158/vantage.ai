// Turn content extraction: what the agent actually did each step — the last
// user prompt, the assistant's text, and which tools it called. This is the
// substance of problem ③ ("what was the agent trying to do over N steps"),
// layered on top of the same SSE/JSON the proxy already sees.
//
// Content is previewed/truncated, not stored whole; a real deployment would add
// a redaction pass (CONCEPT.md §6d) before persisting prompts.

import type { TokenUsage } from "./usage.ts";

export interface ToolCall {
  name: string;
  inputPreview: string;
}

export interface TurnContent {
  model: string | null;
  stopReason: string | null;
  text: string;
  tools: ToolCall[];
  usage: TokenUsage;
}

export const MAX_TEXT = 400;
export const MAX_INPUT = 120;

// Redact obvious secrets/PII before any preview is persisted (CONCEPT.md §6d).
// Conservative and targeted — a real deployment would make this configurable.
const REDACTIONS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b(sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/g, "[key]"],
  [/\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi, "Bearer [token]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[jwt]"],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

export function truncate(s: string, max: number): string {
  const oneLine = redact(s).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function emptyUsage(): TokenUsage {
  return {
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  // Real Claude Code traffic reports the TTL split of cache writes here.
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

function applyUsage(u: TokenUsage, from: AnthropicUsage | undefined): void {
  if (!from) return;
  if (typeof from.input_tokens === "number") u.input_tokens = from.input_tokens;
  if (typeof from.output_tokens === "number") u.output_tokens = from.output_tokens;
  if (typeof from.cache_creation_input_tokens === "number")
    u.cache_creation_input_tokens = from.cache_creation_input_tokens;
  if (typeof from.cache_read_input_tokens === "number")
    u.cache_read_input_tokens = from.cache_read_input_tokens;
  if (typeof from.cache_creation?.ephemeral_1h_input_tokens === "number")
    u.cache_write_1h_tokens = from.cache_creation.ephemeral_1h_input_tokens;
}

export interface TurnExtractor {
  feed(chunk: Uint8Array | string): void;
  end(): TurnContent;
}

// Streaming (SSE) extractor: accumulates text_delta, tool_use blocks (name +
// input_json_delta), stop_reason, and usage.
export function createTurnExtractor(): TurnExtractor {
  let buffer = "";
  const decoder = new TextDecoder();
  const usage = emptyUsage();
  let text = "";
  let stopReason: string | null = null;
  // index -> partial tool call being streamed
  const toolsByIndex = new Map<number, { name: string; parts: string[] }>();
  const finished: ToolCall[] = [];

  function finalizeTool(index: number): void {
    const t = toolsByIndex.get(index);
    if (!t) return;
    let preview = t.parts.join("");
    try {
      preview = JSON.stringify(JSON.parse(preview));
    } catch {
      /* keep raw partial */
    }
    finished.push({ name: t.name, inputPreview: truncate(preview, MAX_INPUT) });
    toolsByIndex.delete(index);
  }

  function handle(json: {
    type?: string;
    index?: number;
    message?: { model?: string; usage?: AnthropicUsage };
    content_block?: { type?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
    usage?: AnthropicUsage;
  }): void {
    switch (json.type) {
      case "message_start":
        if (json.message?.model) usage.model = json.message.model;
        applyUsage(usage, json.message?.usage);
        break;
      case "content_block_start":
        if (json.content_block?.type === "tool_use" && json.index != null) {
          toolsByIndex.set(json.index, { name: json.content_block.name ?? "tool", parts: [] });
        }
        break;
      case "content_block_delta":
        if (json.delta?.type === "text_delta" && json.delta.text) {
          if (text.length < MAX_TEXT * 4) text += json.delta.text;
        } else if (json.delta?.type === "input_json_delta" && json.index != null) {
          toolsByIndex.get(json.index)?.parts.push(json.delta.partial_json ?? "");
        }
        break;
      case "content_block_stop":
        if (json.index != null && toolsByIndex.has(json.index)) finalizeTool(json.index);
        break;
      case "message_delta":
        if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
        applyUsage(usage, json.usage);
        break;
    }
  }

  function handleFrame(frame: string): void {
    let dataStr = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (!dataStr || dataStr === "[DONE]") return;
    try {
      handle(JSON.parse(dataStr));
    } catch {
      /* ignore partial/non-JSON */
    }
  }

  return {
    feed(chunk: Uint8Array | string): void {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.trim()) handleFrame(frame);
      }
    },
    end(): TurnContent {
      if (buffer.trim()) handleFrame(buffer);
      for (const idx of [...toolsByIndex.keys()]) finalizeTool(idx);
      return { model: usage.model, stopReason, text: truncate(text, MAX_TEXT), tools: finished, usage };
    },
  };
}

// Non-streaming JSON Messages response → the same content shape.
export function extractTurnFromJson(body: string): TurnContent | null {
  let json: {
    model?: string;
    stop_reason?: string;
    usage?: AnthropicUsage;
    content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>;
  };
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json.usage && !json.content) return null;
  const usage = emptyUsage();
  usage.model = json.model ?? null;
  applyUsage(usage, json.usage);
  let text = "";
  const tools: ToolCall[] = [];
  for (const block of json.content ?? []) {
    if (block.type === "text" && block.text) text += block.text;
    else if (block.type === "tool_use") {
      tools.push({ name: block.name ?? "tool", inputPreview: truncate(JSON.stringify(block.input ?? {}), MAX_INPUT) });
    }
  }
  return { model: usage.model, stopReason: json.stop_reason ?? null, text: truncate(text, MAX_TEXT), tools, usage };
}

// Last user message text from a request body (Messages API shape).
export function extractUserPrompt(body: string): string | null {
  let json: { messages?: Array<{ role?: string; content?: unknown }> };
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const msgs = json.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "user") continue;
    const text = stripInjectedContext(contentToText(m.content));
    if (text) return truncate(text, MAX_TEXT);
  }
  return null;
}

// Claude Code prepends its own <system-reminder> blocks (environment, memory,
// user info) to the user's message. They are not what the user typed, and at
// the front of a truncated preview they hide it completely — so drop them. An
// unclosed block (body capture cut off) is dropped to the end.
export function stripInjectedContext(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/<system-reminder>[\s\S]*$/, " ")
    .trim();
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: string }).text ?? "") : ""))
      .join(" ");
  }
  return "";
}
