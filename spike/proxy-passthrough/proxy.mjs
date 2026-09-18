// Transparent streaming reverse proxy — the keystone of Vantage's "Schicht B".
//
// It forwards every request verbatim to the upstream provider and streams the
// response body back to the client chunk-by-chunk (no buffering, so SSE stays
// live). While forwarding, it tees the bytes into a usage extractor. When the
// stream ends it computes an estimated cost and appends one event to the
// session's events.jsonl.
//
// Byte-for-byte transparency is the whole point: the wrapped agent must not be
// able to tell it is talking to a proxy.

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createUsageExtractor } from "./usage.mjs";
import { estimateCostUsd } from "./pricing.mjs";

export function startProxy({ upstream, port = 0, eventsPath } = {}) {
  const upstreamUrl = new URL(upstream);
  const upstreamClient = upstreamUrl.protocol === "https:" ? https : http;

  const server = http.createServer((clientReq, clientRes) => {
    const targetPath = clientReq.url;

    // Forward headers verbatim, but rewrite Host to the upstream authority.
    const headers = { ...clientReq.headers, host: upstreamUrl.host };

    const options = {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
      method: clientReq.method,
      path: targetPath,
      headers,
    };

    const upstreamReq = upstreamClient.request(options, (upstreamRes) => {
      // Pass status + headers through unchanged.
      clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);

      const isStream = String(upstreamRes.headers["content-type"] || "").includes(
        "text/event-stream"
      );
      const extractor = isStream ? createUsageExtractor() : null;

      upstreamRes.on("data", (chunk) => {
        // 1) forward the EXACT bytes to the client
        clientRes.write(chunk);
        // 2) observe a copy for usage (never touches the forwarded bytes)
        if (extractor) extractor.feed(chunk);
      });

      upstreamRes.on("end", () => {
        clientRes.end();
        if (extractor) {
          const usage = extractor.end();
          const costUsd = estimateCostUsd(usage);
          const event = {
            ts: new Date().toISOString(),
            type: "usage",
            path: targetPath,
            model: usage.model,
            in: usage.input_tokens,
            out: usage.output_tokens,
            cache_read: usage.cache_read_input_tokens,
            cache_write: usage.cache_creation_input_tokens,
            cost_usd: Number(costUsd.toFixed(6)),
          };
          if (eventsPath) {
            fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
            fs.appendFileSync(eventsPath, JSON.stringify(event) + "\n");
          }
          server.emit("vantage:usage", event);
        }
      });
    });

    upstreamReq.on("error", (err) => {
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end("vantage proxy upstream error: " + err.message);
    });

    // Stream the client's request body to upstream unchanged.
    clientReq.pipe(upstreamReq);
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}
