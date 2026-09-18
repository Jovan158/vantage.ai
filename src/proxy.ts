// Transparent streaming reverse proxy ("Schicht B"). Forwards every request
// verbatim to the upstream provider and streams the response body back
// chunk-by-chunk (no buffering, so SSE stays live), teeing the bytes into a
// usage extractor. On stream end it emits a typed UsageEvent.
//
// Proven byte-for-byte transparent in spike/proxy-passthrough.

import http from "node:http";
import zlib from "node:zlib";
import { URL } from "node:url";
import type { AddressInfo } from "node:net";
import type { Transform } from "node:stream";
import { createUsageExtractor, extractUsageFromJson } from "./usage.ts";
import type { TokenUsage } from "./usage.ts";
import { estimateCostUsd } from "./pricing.ts";
import { upstreamTransport } from "./upstream.ts";
import { extractRateLimit } from "./ratelimit.ts";
import type { RateLimitSnapshot } from "./ratelimit.ts";
import type { UsageEvent } from "./events.ts";

const DEBUG = process.env.VANTAGE_DEBUG === "1";

function log(msg: string): void {
  process.stderr.write(`\x1b[2m[vantage:proxy]\x1b[0m ${msg}\n`);
}

// Returns a decompression Transform for the response's content-encoding, or
// null when the body is already plaintext.
function makeDecompressor(encoding: string): Transform | null {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    case "zstd":
      // Node 22.15+ ships zstd; guard for older runtimes.
      return typeof zlib.createZstdDecompress === "function"
        ? zlib.createZstdDecompress()
        : null;
    default:
      return null;
  }
}

export interface ProxyOptions {
  upstream: string;
  port?: number;
  onUsage?: (event: UsageEvent) => void;
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;
}

export interface RunningProxy {
  server: http.Server;
  port: number;
  url: string;
  /** How the upstream is reached: "direct" or "proxy-tunnel". */
  via: "direct" | "proxy-tunnel";
  close(): Promise<void>;
}

export function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const upstreamUrl = new URL(opts.upstream);
  const transport = upstreamTransport(opts.upstream);
  const upstreamClient = transport.client;

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
        agent: transport.agent,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);

        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        const encoding = String(upstreamRes.headers["content-encoding"] ?? "").toLowerCase();
        const isStream = contentType.includes("text/event-stream");
        const isMessages = targetPath.includes("/v1/messages");
        const isJsonMessages = isMessages && contentType.includes("application/json");
        const observe = isStream || isJsonMessages;

        if (DEBUG) {
          log(`upstream ${upstreamRes.statusCode} ${targetPath} · type=${contentType || "?"} · enc=${encoding || "none"}`);
        }

        // Rate-limit headers are available immediately (no body needed).
        const rl = extractRateLimit(upstreamRes.headers);
        if (rl) {
          if (DEBUG) log(`ratelimit headers: ${JSON.stringify(rl.raw)}`);
          opts.onRateLimit?.(rl);
        } else if (DEBUG && isMessages) {
          log("ratelimit headers: none present on this response");
        }

        // The extractor must see PLAINTEXT, but the client must get the EXACT
        // upstream bytes. If the response is compressed we forward raw bytes to
        // the client and feed a decompressed copy to the observer. Streaming
        // responses parse SSE incrementally; JSON responses buffer the body.
        const sse = isStream ? createUsageExtractor() : null;
        const jsonChunks: Buffer[] | null = isJsonMessages ? [] : null;
        const decompressor = observe ? makeDecompressor(encoding) : null;

        const observeBytes = (buf: Buffer): void => {
          if (sse) sse.feed(buf);
          else if (jsonChunks) jsonChunks.push(buf);
        };
        if (decompressor) {
          decompressor.on("data", (d: Buffer) => observeBytes(d));
          decompressor.on("error", () => {
            /* observation-only; never break the client stream */
          });
        }

        const emit = (usage: TokenUsage): void => {
          if (!opts.onUsage) return;
          opts.onUsage({
            ts: new Date().toISOString(),
            type: "usage",
            path: targetPath,
            model: usage.model,
            in: usage.input_tokens,
            out: usage.output_tokens,
            cache_read: usage.cache_read_input_tokens,
            cache_write: usage.cache_creation_input_tokens,
            cost_usd: Number(estimateCostUsd(usage).toFixed(6)),
          });
        };

        const finish = (): void => {
          if (sse) {
            emit(sse.end());
          } else if (jsonChunks) {
            const usage = extractUsageFromJson(Buffer.concat(jsonChunks).toString("utf8"));
            if (usage) emit(usage);
          }
        };

        upstreamRes.on("data", (chunk: Buffer) => {
          clientRes.write(chunk); // exact bytes to the client
          if (!observe) return;
          if (decompressor) decompressor.write(chunk); // observe a decoded copy
          else observeBytes(chunk);
        });

        upstreamRes.on("end", () => {
          clientRes.end();
          if (!observe) return;
          if (decompressor) decompressor.end(() => finish());
          else finish();
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
        via: transport.via,
        close: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}
