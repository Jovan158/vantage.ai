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
  /** What the call acts on — a file, a command, a URL — for activity views. */
  target?: string;
}

const MAX_TARGET = 80;

// Where agents put what a call acts on. Claude Code: file_path, command, url.
// Others spell it their own way: filePath (OpenCode), cmd (Codex).
const TARGET_KEYS = [
  "file_path",
  "filePath",
  "notebook_path",
  "path",
  "command",
  "cmd",
  "url",
  "query",
  "pattern",
  "description",
  "skill",
];

// A shell command as one line. Some agents pass it as an argv array, often
// wrapped in the shell itself (["bash", "-lc", "npm test"]); the part after
// -c/-lc is what runs.
export function commandText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return undefined;
  const argv = value as string[];
  const flag = argv.findIndex((a) => /^-[a-z]*c$/.test(a));
  if (flag >= 1 && flag === argv.length - 2 && /(?:^|[\\/])(?:ba|z|da|fi)?sh(?:\.exe)?$|powershell|pwsh/i.test(argv[0]!)) return argv[flag + 1];
  return argv.join(" ");
}

// The files an apply_patch call touches, from its "*** Add/Update/Delete
// File: path" headers (Codex, and Copilot's apply_patch tool). The patch text
// is under "input" or "command" (Codex's hook) or "patch".
export function patchFiles(input: Record<string, unknown>): string[] {
  const text = [input.input, input.patch, input.command].find((v): v is string => typeof v === "string" && v.includes("*** Begin Patch"));
  if (!text) return [];
  const files: string[] = [];
  for (const m of text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const f = (m[1] ?? m[2] ?? "").trim();
    if (f && !files.includes(f)) files.push(f);
  }
  return files;
}

// The one detail that says what a tool call does: the file for file tools,
// the command for a shell, the URL for a fetch. Read from the full input
// before any preview truncation, and redacted like every other preview.
export function toolTarget(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const i = input as Record<string, unknown>;
  const patched = patchFiles(i);
  if (patched.length) return patched.length === 1 ? patched[0] : `${patched[0]} (+${patched.length - 1} more)`;
  for (const key of TARGET_KEYS) {
    const v = key === "command" || key === "cmd" ? commandText(i[key]) : i[key];
    if (typeof v === "string" && v.trim()) {
      const one = redact(v).replace(/\s+/g, " ").trim();
      if (one.length <= MAX_TARGET) return one;
      // Paths keep their end (the file name), everything else its start.
      return /path|file/i.test(key) ? "…" + one.slice(-(MAX_TARGET - 1)) : one.slice(0, MAX_TARGET - 1) + "…";
    }
  }
  return undefined;
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
    let target: string | undefined;
    try {
      const input = JSON.parse(preview);
      preview = JSON.stringify(input);
      target = toolTarget(input);
    } catch {
      /* keep raw partial */
    }
    finished.push({ name: t.name, inputPreview: truncate(preview, MAX_INPUT), ...(target ? { target } : {}) });
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
      const target = toolTarget(block.input);
      tools.push({
        name: block.name ?? "tool",
        inputPreview: truncate(JSON.stringify(block.input ?? {}), MAX_INPUT),
        ...(target ? { target } : {}),
      });
    }
  }
  return { model: usage.model, stopReason: json.stop_reason ?? null, text: truncate(text, MAX_TEXT), tools, usage };
}

// Last user message text from a request body (Messages API shape).
export interface RequestInfo {
  prompt: string | null;
  /**
   * A request the agent made on its own, not a chat turn. Claude Code sends
   * every chat turn with its tool list; its background calls (e.g. judging
   * whether the agent is done or waiting) carry no tools. An unparseable body
   * — cut off because it is very large — is a chat turn: background calls are
   * small.
   */
  background: boolean;
}

export function extractRequestInfo(body: string): RequestInfo {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { prompt: null, background: false };
  }
  return requestInfoFrom(json);
}

// From an already parsed body (see proxy.ts, which parses once).
export function requestInfoFrom(parsed: unknown): RequestInfo {
  if (!parsed || typeof parsed !== "object") return { prompt: null, background: false };
  const json = parsed as { messages?: Array<{ role?: string; content?: unknown }>; tools?: unknown[] };
  return {
    prompt: promptFrom(json.messages ?? []),
    background: !Array.isArray(json.tools) || json.tools.length === 0,
  };
}

function promptFrom(msgs: Array<{ role?: string; content?: unknown }>): string | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "user") continue;
    const text = stripInjectedContext(contentToText(m.content));
    if (text) return truncate(text, MAX_TEXT);
  }
  return null;
}

// Claude Code prepends its own <system-reminder> blocks (environment, memory,
// user info) to the user's message; Codex sends its environment and
// AGENTS.md as user messages in tags of their own. They are not what the user
// typed, and at the front of a truncated preview they hide it completely — so
// drop them. An unclosed block (body capture cut off) is dropped to the end.
const INJECTED_TAGS = ["system-reminder", "environment_context", "user_instructions", "INSTRUCTIONS", "session_context", "current_datetime"];

export function stripInjectedContext(text: string): string {
  let out = text;
  for (const tag of INJECTED_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), " ").replace(new RegExp(`<${tag}>[\\s\\S]*$`), " ");
  }
  return out.replace(/^# AGENTS\.md instructions for \S+\s*$/m, " ").trim();
}

// The last message the user typed, from a list of chat messages.
export function lastUserText(msgs: Array<{ role?: string; content?: unknown }>): string | null {
  return promptFrom(msgs);
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: string }).text ?? "") : ""))
      .join(" ");
  }
  return "";
}
