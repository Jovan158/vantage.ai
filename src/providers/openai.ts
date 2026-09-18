// OpenAI Chat Completions parser (Codex CLI, Aider, and other OpenAI-compatible
// agents). Produces the same TurnContent shape as the Anthropic parser so the
// meter, replay, and policy layers work unchanged — this is what makes Vantage
// genuinely multi-agent rather than Anthropic-only.
//
// Streaming SSE shape:
//   data: {"model":..,"choices":[{"delta":{"content":"Hi"}}]}
//   data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":..,
//           "function":{"name":"f","arguments":"{\"x"}}]}}]}
//   data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
//   data: {"usage":{"prompt_tokens":10,"completion_tokens":5,
//           "prompt_tokens_details":{"cached_tokens":8}}}   (needs include_usage)
//   data: [DONE]

import type { TokenUsage } from "../usage.ts";
import type { TurnContent, TurnExtractor, ToolCall } from "../turn.ts";
import { truncate, MAX_INPUT, MAX_TEXT } from "../turn.ts";

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function mapUsage(u: OpenAIUsage | undefined, model: string | null): TokenUsage {
  return {
    model,
    input_tokens: u?.prompt_tokens ?? 0,
    output_tokens: u?.completion_tokens ?? 0,
    cache_read_input_tokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

interface Delta {
  content?: string;
  tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }>;
}

export function createOpenAITurnExtractor(): TurnExtractor {
  let buffer = "";
  const decoder = new TextDecoder();
  let model: string | null = null;
  let text = "";
  let stopReason: string | null = null;
  let usage: OpenAIUsage | undefined;
  const toolsByIndex = new Map<number, { name: string; parts: string[] }>();

  function handle(json: {
    model?: string;
    usage?: OpenAIUsage;
    choices?: Array<{ delta?: Delta; finish_reason?: string | null }>;
  }): void {
    if (json.model) model = json.model;
    if (json.usage) usage = json.usage;
    for (const choice of json.choices ?? []) {
      if (choice.finish_reason) stopReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) continue;
      if (delta.content) text += delta.content;
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const entry = toolsByIndex.get(idx) ?? { name: "tool", parts: [] };
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) entry.parts.push(tc.function.arguments);
        toolsByIndex.set(idx, entry);
      }
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

  function finalizeTools(): ToolCall[] {
    const out: ToolCall[] = [];
    for (const { name, parts } of toolsByIndex.values()) {
      let preview = parts.join("");
      try {
        preview = JSON.stringify(JSON.parse(preview));
      } catch {
        /* keep raw partial */
      }
      out.push({ name, inputPreview: truncate(preview, MAX_INPUT) });
    }
    return out;
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
      return { model, stopReason, text: truncate(text, MAX_TEXT), tools: finalizeTools(), usage: mapUsage(usage, model) };
    },
  };
}

export function extractOpenAITurnFromJson(body: string): TurnContent | null {
  let json: {
    model?: string;
    usage?: OpenAIUsage;
    choices?: Array<{
      message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> };
      finish_reason?: string | null;
    }>;
  };
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json.usage && !json.choices) return null;
  const model = json.model ?? null;
  const choice = json.choices?.[0];
  const msg = choice?.message;
  const tools: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
    name: tc.function?.name ?? "tool",
    inputPreview: truncate(tc.function?.arguments ?? "{}", MAX_INPUT),
  }));
  return {
    model,
    stopReason: choice?.finish_reason ?? null,
    text: truncate(msg?.content ?? "", MAX_TEXT),
    tools,
    usage: mapUsage(json.usage, model),
  };
}
