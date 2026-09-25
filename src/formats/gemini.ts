// Google's Gemini API — POST …/models/<model>:generateContent and
// :streamGenerateContent — as Gemini CLI, OpenCode and pi send it. Gemini
// CLI signed in with a Google account talks to Code Assist instead
// (…/v1internal:streamGenerateContent), which wraps the same request in
// "request" and each response in "response"; both are read here.
//
// usageMetadata is cumulative: the last chunk's counts are the totals. The
// prompt count includes cached input and the thoughts are billed as output,
// so both are moved to where Anthropic reports them.

import type { TokenUsage } from "../usage.ts";
import {
  MAX_INPUT,
  MAX_TEXT,
  lastUserText,
  toolTarget,
  truncate,
  type RequestInfo,
  type ToolCall,
  type TurnContent,
  type TurnExtractor,
} from "../turn.ts";
import { sseParser } from "./sse.ts";
import { stringValues } from "./openai.ts";
import type { ConversationPart } from "./parts.ts";

type Part = { text?: string; thought?: boolean; functionCall?: { name?: string; args?: unknown }; functionResponse?: { name?: string; response?: unknown } };

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  modelVersion?: string;
}

function unwrap(raw: unknown): GeminiResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { response?: GeminiResponse };
  return r.response && typeof r.response === "object" ? r.response : (raw as GeminiResponse);
}

function call(name: string, input: unknown): ToolCall {
  const target = toolTarget(input);
  return { name, inputPreview: truncate(JSON.stringify(input ?? {}), MAX_INPUT), ...(target ? { target } : {}) };
}

class GeminiTurn {
  private usage: TokenUsage = { model: null, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  private text = "";
  private stopReason: string | null = null;
  private tools: ToolCall[] = [];

  add(raw: unknown): void {
    const r = unwrap(raw);
    if (!r) return;
    if (r.modelVersion) this.usage.model = r.modelVersion;
    const m = r.usageMetadata;
    if (m) {
      const cached = m.cachedContentTokenCount ?? 0;
      const prompt = (m.promptTokenCount ?? 0) + (m.toolUsePromptTokenCount ?? 0);
      this.usage.input_tokens = Math.max(0, prompt - cached);
      this.usage.cache_read_input_tokens = cached;
      this.usage.output_tokens = (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0);
    }
    for (const c of r.candidates ?? []) {
      for (const p of c.content?.parts ?? []) {
        if (p.functionCall) this.tools.push(call(p.functionCall.name ?? "tool", p.functionCall.args));
        else if (typeof p.text === "string" && !p.thought && this.text.length < MAX_TEXT * 4) this.text += p.text;
      }
      if (c.finishReason) this.stopReason = c.finishReason;
    }
  }

  result(model: string | null): TurnContent {
    if (!this.usage.model) this.usage.model = model;
    return { model: this.usage.model, stopReason: this.stopReason, text: truncate(this.text, MAX_TEXT), tools: this.tools, usage: this.usage };
  }
}

// The model named in the request path: …/models/gemini-3-pro:streamGenerateContent.
export function geminiModelFromPath(path: string): string | null {
  const m = /\/models\/([^/:?]+):/.exec(path);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function createGeminiExtractor(path = ""): TurnExtractor {
  const turn = new GeminiTurn();
  const sse = sseParser((e) => turn.add(e));
  return {
    feed: (chunk) => sse.feed(chunk),
    end() {
      sse.end();
      return turn.result(geminiModelFromPath(path));
    },
  };
}

// A whole response, or — for streamGenerateContent without alt=sse — a JSON
// array of chunks.
export function geminiTurnFromJson(body: string, path = ""): TurnContent | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const chunks = Array.isArray(json) ? json : [json];
  if (!chunks.some((c) => unwrap(c)?.usageMetadata || unwrap(c)?.candidates)) return null;
  const turn = new GeminiTurn();
  for (const c of chunks) turn.add(c);
  return turn.result(geminiModelFromPath(path));
}

type Content = { role?: string; parts?: Part[] };

function requestOf(body: unknown): { contents?: Content[]; systemInstruction?: { parts?: Part[] }; tools?: unknown[] } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { request?: unknown; contents?: unknown };
  const r = b.request && typeof b.request === "object" ? b.request : b;
  return r as { contents?: Content[]; systemInstruction?: { parts?: Part[] }; tools?: unknown[] };
}

function partsText(parts: Part[] | undefined): string {
  return (parts ?? []).map((p) => (typeof p.text === "string" && !p.thought ? p.text : "")).join("\n");
}

export function geminiRequestInfo(body: unknown): RequestInfo {
  const r = requestOf(body);
  if (!r) return { prompt: null, background: false };
  const messages = (r.contents ?? []).map((c) => ({ role: c.role === "model" ? "assistant" : c.role ?? "user", content: partsText(c.parts) }));
  return {
    prompt: lastUserText(messages),
    background: !Array.isArray(r.tools) || r.tools.length === 0,
  };
}

export function geminiParts(body: unknown, agent: string): ConversationPart[] {
  const r = requestOf(body);
  if (!r) return [];
  const parts: ConversationPart[] = [{ key: "system", text: partsText(r.systemInstruction?.parts), source: "the system prompt" }];
  // Gemini matches a result to its call by name and order, not by id.
  const pending: string[] = [];
  let n = 0;
  for (const c of r.contents ?? []) {
    for (const p of c.parts ?? []) {
      n++;
      if (p.functionCall) {
        const tc = call(p.functionCall.name ?? "tool", p.functionCall.args);
        const label = `${tc.name}${tc.target ? ` ${tc.target}` : ""}`;
        pending.push(label);
        parts.push({ key: `use:${n}`, text: stringValues(p.functionCall.args), source: `${agent}'s ${label} call` });
      } else if (p.functionResponse) {
        const name = p.functionResponse.name ?? "a tool";
        const i = pending.findIndex((l) => l === name || l.startsWith(`${name} `));
        const label = i === -1 ? name : pending.splice(i, 1)[0]!;
        parts.push({ key: `result:${n}`, text: stringValues(p.functionResponse.response), source: `the output of ${label}` });
      } else if (typeof p.text === "string" && !p.thought) {
        parts.push({ key: `text:${c.role ?? ""}`, text: p.text, source: c.role === "model" ? `${agent}'s reply` : "your message" });
      }
    }
  }
  return parts;
}
