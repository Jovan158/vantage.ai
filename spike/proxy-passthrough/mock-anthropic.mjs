// Minimal mock of api.anthropic.com's POST /v1/messages streaming endpoint.
//
// Emits a realistic Anthropic SSE sequence so the spike can prove the proxy
// end-to-end without a real API key or network egress. The exact byte stream it
// writes is also captured by run-spike.mjs to assert byte-for-byte transparency.

import http from "node:http";

// The canonical SSE frames the mock emits, in order. Token numbers are chosen
// to be distinctive so the assertions are unambiguous.
export const EXPECTED_USAGE = {
  model: "claude-sonnet-5",
  input_tokens: 1024,
  cache_read_input_tokens: 512,
  cache_creation_input_tokens: 0,
  output_tokens: 87,
};

function buildSseFrames() {
  const f = [];
  const push = (event, data) =>
    f.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  push("message_start", {
    type: "message_start",
    message: {
      id: "msg_spike_001",
      type: "message",
      role: "assistant",
      model: EXPECTED_USAGE.model,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: EXPECTED_USAGE.input_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: EXPECTED_USAGE.cache_read_input_tokens,
        output_tokens: 1,
      },
    },
  });
  push("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  for (const piece of ["Hallo", ", ", "Welt", "!"]) {
    push("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: piece },
    });
  }
  push("content_block_stop", { type: "content_block_stop", index: 0 });
  push("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: EXPECTED_USAGE.output_tokens },
  });
  push("message_stop", { type: "message_stop" });
  return f;
}

export function startMockAnthropic({ port = 0 } = {}) {
  const frames = buildSseFrames();
  // The complete body as one buffer — this is our ground truth for transparency.
  const fullBody = Buffer.from(frames.join(""), "utf8");

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    // Write frames with small gaps to simulate a real streaming response.
    let i = 0;
    const tick = () => {
      if (i >= frames.length) {
        res.end();
        return;
      }
      res.write(frames[i++]);
      setTimeout(tick, 5);
    };
    tick();
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        fullBody,
      });
    });
  });
}
