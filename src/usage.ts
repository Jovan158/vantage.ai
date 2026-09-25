// SSE usage extractor for Anthropic Messages streaming responses.
//
// Tees the raw response bytes as they stream to the client and pulls token
// counts out of the SSE frames WITHOUT altering or delaying the stream.
// Anthropic reports usage in `message_start` (input + partial output) and
// `message_delta` (final cumulative output).
//
// Proven end-to-end in spike/proxy-passthrough; this is the typed core.

export interface TokenUsage {
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** Share of cache_creation_input_tokens written with the 1-hour TTL, when
   * the response reports the split (usage.cache_creation.ephemeral_1h_input_tokens). */
  cache_write_1h_tokens?: number;
}

interface AnthropicUsageFields {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export interface UsageExtractor {
  feed(chunk: Uint8Array | string): void;
  end(): TokenUsage;
  snapshot(): TokenUsage;
}

// Extract usage from a complete non-streaming Messages response body
// (application/json). Returns null if the body has no usage block (e.g. errors).
export function extractUsageFromJson(text: string): TokenUsage | null {
  let json: { model?: string; usage?: AnthropicUsageFields };
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const u = json.usage;
  if (!u) return null;
  return {
    model: json.model ?? null,
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
  };
}

export function createUsageExtractor(): UsageExtractor {
  let buffer = "";
  const decoder = new TextDecoder();

  const usage: TokenUsage = {
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  function applyUsage(u: AnthropicUsageFields | undefined): void {
    if (!u) return;
    if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens;
    if (typeof u.output_tokens === "number") usage.output_tokens = u.output_tokens;
    if (typeof u.cache_creation_input_tokens === "number")
      usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
    if (typeof u.cache_read_input_tokens === "number")
      usage.cache_read_input_tokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation?.ephemeral_1h_input_tokens === "number")
      usage.cache_write_1h_tokens = u.cache_creation.ephemeral_1h_input_tokens;
  }

  function handleFrame(frame: string): void {
    let dataStr = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (!dataStr || dataStr === "[DONE]") return;

    let json: {
      type?: string;
      message?: { model?: string; usage?: AnthropicUsageFields };
      usage?: AnthropicUsageFields;
    };
    try {
      json = JSON.parse(dataStr);
    } catch {
      return; // partial/non-JSON data line; ignore
    }

    switch (json.type) {
      case "message_start":
        if (json.message?.model) usage.model = json.message.model;
        applyUsage(json.message?.usage);
        break;
      case "message_delta":
        applyUsage(json.usage);
        break;
      default:
        break;
    }
  }

  return {
    feed(chunk: Uint8Array | string): void {
      buffer +=
        typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.trim()) handleFrame(frame);
      }
    },
    end(): TokenUsage {
      if (buffer.trim()) handleFrame(buffer);
      buffer = "";
      return { ...usage };
    },
    snapshot(): TokenUsage {
      return { ...usage };
    },
  };
}
