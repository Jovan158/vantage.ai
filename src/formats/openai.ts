// OpenAI's two API shapes, as the agents send them:
//
//   Responses         POST …/responses — Codex (over HTTP or a WebSocket),
//                     OpenCode and pi for OpenAI models, Copilot for GPT
//   Chat Completions  POST …/chat/completions — the shape most other
//                     providers copy (OpenRouter, Groq, DeepSeek, xAI, …)
//
// Both count cached input inside the input tokens; Vantage keeps them apart,
// as Anthropic reports them, so prices and cache rates stay comparable.
// Reasoning tokens are already inside the output tokens.

import type { TokenUsage } from "../usage.ts";
import {
  MAX_INPUT,
  MAX_TEXT,
  contentToText,
  lastUserText,
  toolTarget,
  truncate,
  type RequestInfo,
  type ToolCall,
  type TurnContent,
  type TurnExtractor,
} from "../turn.ts";
import { sseParser } from "./sse.ts";
import type { ConversationPart } from "./parts.ts";

function emptyUsage(model: string | null = null): TokenUsage {
  return { model, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

interface OpenAiUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  // Some OpenAI-compatible gateways in front of Claude report cache writes.
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export function applyOpenAiUsage(u: TokenUsage, from: OpenAiUsage | undefined | null): void {
  if (!from || typeof from !== "object") return;
  const input = from.input_tokens ?? from.prompt_tokens;
  const output = from.output_tokens ?? from.completion_tokens;
  const cached = from.input_tokens_details?.cached_tokens ?? from.prompt_tokens_details?.cached_tokens ?? from.cache_read_input_tokens ?? 0;
  const written = from.cache_creation_input_tokens ?? 0;
  if (typeof input === "number") u.input_tokens = Math.max(0, input - cached - written);
  if (typeof output === "number") u.output_tokens = output;
  u.cache_read_input_tokens = cached;
  u.cache_creation_input_tokens = written;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toolCall(name: string, input: unknown): ToolCall {
  const target = toolTarget(input);
  const preview = typeof input === "string" ? input : JSON.stringify(input ?? {});
  return { name, inputPreview: truncate(preview, MAX_INPUT), ...(target ? { target } : {}) };
}

// ---------------------------------------------------------------------------
// Responses API

type ResponseItem = {
  type?: string;
  name?: string;
  arguments?: string;
  input?: string;
  server_label?: string;
  action?: { type?: string; command?: unknown; query?: string; url?: string };
  content?: Array<{ type?: string; text?: string }>;
};

// A tool call in the output, as Vantage names it. Hosted tools (web search)
// and Codex's own shell item have no name of their own.
export function responseItemCall(item: ResponseItem): ToolCall | null {
  switch (item.type) {
    case "function_call":
      return toolCall(item.name ?? "tool", parseArgs(item.arguments));
    case "custom_tool_call":
      return toolCall(item.name ?? "tool", { input: item.input ?? "" });
    case "local_shell_call":
      return toolCall("shell", { command: item.action?.command });
    case "mcp_call":
      return toolCall(`mcp__${item.server_label ?? "server"}__${item.name ?? "tool"}`, parseArgs(item.arguments));
    case "web_search_call":
      return toolCall("web_search", { query: item.action?.query, url: item.action?.url });
    default:
      return null;
  }
}

interface ResponseObject {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  usage?: OpenAiUsage;
  output?: ResponseItem[];
}

// One response, fed event by event: SSE data or WebSocket messages carry the
// same events. `handle` returns true once the response is complete.
export interface ResponsesTurn {
  handle(event: unknown): boolean;
  result(): TurnContent;
}

export function createResponsesTurn(): ResponsesTurn {
  const usage = emptyUsage();
  let text = "";
  let stopReason: string | null = null;
  const tools: ToolCall[] = [];
  let sawItems = false;

  const finish = (r: ResponseObject | undefined): void => {
    if (!r) return;
    if (r.model) usage.model = r.model;
    applyOpenAiUsage(usage, r.usage);
    stopReason = r.incomplete_details?.reason ?? r.status ?? stopReason;
    // A response without streamed items (some gateways) still lists them.
    if (!sawItems) for (const item of r.output ?? []) addItem(item);
  };
  const addItem = (item: ResponseItem): void => {
    const call = responseItemCall(item);
    if (call) tools.push(call);
    else if (item.type === "message" && !text) {
      text = (item.content ?? []).map((c) => (c.type === "output_text" ? c.text ?? "" : "")).join("");
    }
  };

  return {
    handle(raw) {
      if (!raw || typeof raw !== "object") return false;
      const e = raw as { type?: string; delta?: string; item?: ResponseItem; response?: ResponseObject };
      switch (e.type) {
        case "response.created":
        case "response.in_progress":
          if (e.response?.model) usage.model = e.response.model;
          return false;
        case "response.output_text.delta":
          if (typeof e.delta === "string" && text.length < MAX_TEXT * 4) text += e.delta;
          return false;
        case "response.output_item.done":
          if (e.item) {
            sawItems = true;
            const call = responseItemCall(e.item);
            if (call) tools.push(call);
          }
          return false;
        case "response.completed":
        case "response.done":
        case "response.incomplete":
        case "response.failed":
          finish(e.response);
          return true;
        default:
          return false;
      }
    },
    result() {
      return { model: usage.model, stopReason, text: truncate(text, MAX_TEXT), tools, usage };
    },
  };
}

export function createResponsesExtractor(): TurnExtractor {
  const turn = createResponsesTurn();
  const sse = sseParser((e) => void turn.handle(e));
  return {
    feed: (chunk) => sse.feed(chunk),
    end() {
      sse.end();
      return turn.result();
    },
  };
}

export function responsesTurnFromJson(body: string): TurnContent | null {
  let json: ResponseObject;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || (!json.usage && !json.output)) return null;
  const turn = createResponsesTurn();
  turn.handle({ type: "response.completed", response: json });
  return turn.result();
}

type InputItem = {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  arguments?: string;
  input?: string;
  call_id?: string;
  output?: unknown;
  action?: { command?: unknown };
};

function inputItems(body: unknown): InputItem[] {
  const input = (body as { input?: unknown })?.input;
  if (typeof input === "string") return [{ type: "message", role: "user", content: input }];
  return Array.isArray(input) ? (input.filter((i) => i && typeof i === "object") as InputItem[]) : [];
}

// The tools a request offers: its "tools", or — Codex — an input item of
// type "additional_tools".
function offersTools(body: unknown): boolean {
  const tools = (body as { tools?: unknown[] }).tools;
  if (Array.isArray(tools) && tools.length > 0) return true;
  return inputItems(body).some((i) => i.type === "additional_tools" && Array.isArray((i as { tools?: unknown[] }).tools) && (i as { tools: unknown[] }).tools.length > 0);
}

export function responsesRequestInfo(body: unknown): RequestInfo {
  if (!body || typeof body !== "object") return { prompt: null, background: false };
  const messages = inputItems(body).filter((i) => (i.type ?? "message") === "message");
  // A request that continues an earlier response (Codex over a WebSocket)
  // sends only what is new; the tools came with the first one.
  const continues = typeof (body as { previous_response_id?: unknown }).previous_response_id === "string";
  return {
    prompt: lastUserText(messages),
    background: !offersTools(body) && !continues,
  };
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  return contentToText(output);
}

export function responsesParts(body: unknown, agent: string): ConversationPart[] {
  if (!body || typeof body !== "object") return [];
  const parts: ConversationPart[] = [];
  const instructions = (body as { instructions?: unknown }).instructions;
  if (typeof instructions === "string") parts.push({ key: "system", text: instructions, source: "the system prompt" });
  const calls = new Map<string, string>();
  for (const item of inputItems(body)) {
    const type = item.type ?? "message";
    if (type === "message") {
      const text = contentToText(item.content);
      const role = item.role ?? "user";
      if (role === "system" || role === "developer") parts.push({ key: `system:${role}`, text, source: "the system prompt" });
      else if (role === "assistant") parts.push({ key: "text:assistant", text, source: `${agent}'s reply` });
      else parts.push({ key: "text:user", text, source: "your message" });
    } else if (type === "function_call" || type === "custom_tool_call" || type === "local_shell_call") {
      const call = responseItemCall(item as ResponseItem);
      const label = call ? `${call.name}${call.target ? ` ${call.target}` : ""}` : "tool";
      if (item.call_id) calls.set(item.call_id, label);
      const raw = type === "custom_tool_call" ? item.input ?? "" : type === "local_shell_call" ? JSON.stringify(item.action ?? {}) : item.arguments ?? "";
      parts.push({ key: `use:${item.call_id ?? ""}`, text: stringValues(parseArgs(raw)), source: `${agent}'s ${label} call` });
    } else if (type.endsWith("_output")) {
      parts.push({
        key: `result:${item.call_id ?? ""}`,
        text: outputText(item.output),
        source: `the output of ${calls.get(item.call_id ?? "") ?? "a tool"}`,
      });
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Chat Completions

type ChatChunk = {
  model?: string;
  usage?: OpenAiUsage | null;
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> };
    message?: { content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
    finish_reason?: string | null;
  }>;
};

export function createChatExtractor(): TurnExtractor {
  const usage = emptyUsage();
  let text = "";
  let stopReason: string | null = null;
  const pending = new Map<number, { name: string; args: string }>();

  const sse = sseParser((raw) => {
    const c = raw as ChatChunk;
    if (!c || typeof c !== "object") return;
    if (c.model) usage.model = c.model;
    if (c.usage) applyOpenAiUsage(usage, c.usage);
    for (const choice of c.choices ?? []) {
      const d = choice.delta;
      if (typeof d?.content === "string" && text.length < MAX_TEXT * 4) text += d.content;
      for (const t of d?.tool_calls ?? []) {
        const idx = t.index ?? 0;
        const cur = pending.get(idx) ?? { name: "", args: "" };
        if (t.function?.name) cur.name += t.function.name;
        if (t.function?.arguments) cur.args += t.function.arguments;
        pending.set(idx, cur);
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }
  });

  return {
    feed: (chunk) => sse.feed(chunk),
    end() {
      sse.end();
      const tools = [...pending.entries()].sort(([a], [b]) => a - b).map(([, t]) => toolCall(t.name || "tool", parseArgs(t.args)));
      return { model: usage.model, stopReason, text: truncate(text, MAX_TEXT), tools, usage };
    },
  };
}

export function chatTurnFromJson(body: string): TurnContent | null {
  let json: ChatChunk;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object" || (!json.usage && !json.choices)) return null;
  const usage = emptyUsage(json.model ?? null);
  applyOpenAiUsage(usage, json.usage);
  const choice = json.choices?.[0];
  const tools = (choice?.message?.tool_calls ?? []).map((t) => toolCall(t.function?.name ?? "tool", parseArgs(t.function?.arguments)));
  return {
    model: usage.model,
    stopReason: choice?.finish_reason ?? null,
    text: truncate(contentToText(choice?.message?.content), MAX_TEXT),
    tools,
    usage,
  };
}

type ChatMessage = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
};

export function chatParts(body: unknown, agent: string): ConversationPart[] {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return [];
  const parts: ConversationPart[] = [];
  const calls = new Map<string, string>();
  for (const m of messages as ChatMessage[]) {
    if (!m || typeof m !== "object") continue;
    const text = contentToText(m.content);
    switch (m.role) {
      case "system":
      case "developer":
        parts.push({ key: "system", text, source: "the system prompt" });
        break;
      case "assistant":
        parts.push({ key: "text:assistant", text, source: `${agent}'s reply` });
        for (const t of m.tool_calls ?? []) {
          const call = toolCall(t.function?.name ?? "tool", parseArgs(t.function?.arguments));
          const label = `${call.name}${call.target ? ` ${call.target}` : ""}`;
          if (t.id) calls.set(t.id, label);
          parts.push({ key: `use:${t.id ?? ""}`, text: stringValues(parseArgs(t.function?.arguments)), source: `${agent}'s ${label} call` });
        }
        break;
      case "tool":
        parts.push({ key: `result:${m.tool_call_id ?? ""}`, text, source: `the output of ${calls.get(m.tool_call_id ?? "") ?? "a tool"}` });
        break;
      default:
        parts.push({ key: "text:user", text, source: "your message" });
    }
  }
  return parts;
}

// The text values inside a tool input, with their real line breaks — JSON
// would escape them.
export function stringValues(value: unknown, out: string[] = []): string {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringValues(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringValues(v, out);
  return out.join("\n");
}
