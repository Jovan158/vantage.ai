// Transparent streaming reverse proxy ("Schicht B"). Forwards every request
// verbatim to the upstream provider and streams the response body back
// chunk-by-chunk (no buffering, so SSE stays live), teeing the bytes into a
// usage extractor. On stream end it emits a typed UsageEvent.
//
// Proven byte-for-byte transparent in spike/proxy-passthrough.

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type { AddressInfo } from "node:net";
import { createUsageExtractor } from "./usage.ts";
import { estimateCostUsd } from "./pricing.ts";
import type { UsageEvent } from "./events.ts";

export interface ProxyOptions {
  upstream: string;
  port?: number;
  onUsage?: (event: UsageEvent) => void;
}

export interface RunningProxy {
  server: http.Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const upstreamUrl = new URL(opts.upstream);
  const upstreamClient = upstreamUrl.protocol === "https:" ? https : http;

  const server = http.createServer((clientReq, clientRes) => {
    const targetPath = clientReq.url ?? "/";
    const headers = { ...clientReq.headers, host: upstreamUrl.host };

    const upstreamReq = upstreamClient.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
        method: clientReq.method,
        path: targetPath,
        headers,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);

        const isStream = String(upstreamRes.headers["content-type"] ?? "").includes(
          "text/event-stream"
        );
        const extractor = isStream ? createUsageExtractor() : null;

        upstreamRes.on("data", (chunk: Buffer) => {
          clientRes.write(chunk); // exact bytes to the client
          if (extractor) extractor.feed(chunk); // observe a copy only
        });

        upstreamRes.on("end", () => {
          clientRes.end();
          if (extractor && opts.onUsage) {
            const usage = extractor.end();
            const event: UsageEvent = {
              ts: new Date().toISOString(),
              type: "usage",
              path: targetPath,
              model: usage.model,
              in: usage.input_tokens,
              out: usage.output_tokens,
              cache_read: usage.cache_read_input_tokens,
              cache_write: usage.cache_creation_input_tokens,
              cost_usd: Number(estimateCostUsd(usage).toFixed(6)),
            };
            opts.onUsage(event);
          }
        });
      }
    );

    upstreamReq.on("error", (err: Error) => {
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end("vantage proxy upstream error: " + err.message);
    });

    clientReq.pipe(upstreamReq);
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
