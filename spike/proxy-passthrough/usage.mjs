// SSE usage extractor for Anthropic Messages streaming responses.
//
// This is the core of the risky assumption: we tee the raw response bytes as
// they stream to the client, and pull token counts out of the SSE frames
// WITHOUT altering or delaying the stream.
//
// Anthropic streams token usage in two places:
//   - `message_start`  -> message.usage { input_tokens, cache_creation_input_tokens,
//                          cache_read_input_tokens, output_tokens (partial, usually 1) }
//   - `message_delta`  -> usage { output_tokens (final cumulative) }
//
// We accumulate a text buffer, split it into complete SSE frames (separated by
// a blank line), and parse each frame's `data:` JSON. Incomplete trailing data
// is kept in the buffer until the next chunk completes it.

export function createUsageExtractor() {
  let buffer = "";
  const decoder = new TextDecoder();

  const usage = {
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };

  function applyUsage(u) {
    if (!u) return;
    if (typeof u.input_tokens === "number") usage.input_tokens = u.input_tokens;
    if (typeof u.output_tokens === "number") usage.output_tokens = u.output_tokens;
    if (typeof u.cache_creation_input_tokens === "number")
      usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
    if (typeof u.cache_read_input_tokens === "number")
      usage.cache_read_input_tokens = u.cache_read_input_tokens;
  }

  function handleFrame(frame) {
    // A frame is one or more lines: `event: <type>` and `data: <json>`.
    let dataStr = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (!dataStr || dataStr === "[DONE]") return;
    let json;
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
    // Feed a raw chunk (Buffer/Uint8Array). Never blocks, never mutates the chunk.
    feed(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let idx;
      // SSE frames are separated by a blank line ("\n\n").
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.trim()) handleFrame(frame);
      }
    },
    // Flush any trailing frame with no terminating blank line.
    end() {
      if (buffer.trim()) handleFrame(buffer);
      buffer = "";
      return { ...usage };
    },
    snapshot() {
      return { ...usage };
    },
  };
}
