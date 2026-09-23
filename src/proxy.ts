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
import { requestInfoFrom, type RequestInfo } from "./turn.ts";
import { scanRequest, type SecretFinding } from "./secrets.ts";
import type { TurnContent } from "./turn.ts";
import { getProvider } from "./providers/index.ts";
import type { Provider, ProviderName } from "./providers/index.ts";
import { estimateCostUsd } from "./pricing.ts";
import { upstreamTransport } from "./upstream.ts";
import { extractRateLimit } from "./ratelimit.ts";
import type { RateLimitSnapshot } from "./ratelimit.ts";
import type { UsageEvent } from "./events.ts";

const DEBUG = process.env.VANTAGE_DEBUG === "1";

function stderrLog(msg: string): void {
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
  /** Response format to parse; defaults to Anthropic. */
  provider?: ProviderName;
  onUsage?: (event: UsageEvent) => void;
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;
  /**
   * A request to an observed path has been fully received, with what looks
   * like a secret in it (the whole conversation so far — deduplicate).
   */
  onRequest?: (info: RequestInfo & { secrets: SecretFinding[] }) => void;
  /**
   * An observed request began, or its response has been fully metered
   * (onUsage already called) or failed. "end" comes exactly once per
   * "start"; the budget guard uses the pair to know nothing is in flight.
   */
  onExchange?: (phase: "start" | "end") => void;
  /** Where VANTAGE_DEBUG output goes; defaults to stderr. */
  log?: (msg: string) => void;
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
  const log = opts.log ?? stderrLog;
  const upstreamUrl = new URL(opts.upstream);
  const transport = upstreamTransport(opts.upstream);
  const upstreamClient = transport.client;
  const provider: Provider = getProvider(opts.provider ?? "anthropic");

  const server = http.createServer((clientReq, clientRes) => {
    const targetPath = clientReq.url ?? "/";
    const headers = { ...clientReq.headers, host: upstreamUrl.host };

    // Tee the request body (capped) to recover the last user prompt. Requests
    // to the Messages API are uncompressed JSON in practice. The cap is high
    // because a long session resends its whole history every turn; a body
    // cut off at the cap yields no prompt.
    const reqChunks: Buffer[] = [];
    let reqBytes = 0;
    const captureReq =
      clientReq.method === "POST" &&
      provider.isObservablePath(targetPath) &&
      String(clientReq.headers["content-type"] ?? "").includes("json") &&
      !clientReq.headers["content-encoding"];
    if (captureReq) {
      clientReq.on("data", (chunk: Buffer) => {
        if (reqBytes < 16 * 1024 * 1024) {
          reqChunks.push(chunk);
          reqBytes += chunk.length;
        }
      });
    }
    // Parsed once, when the request is complete — a long session's body is
    // megabytes of history.
    let parsed: unknown;
    let parsedOnce = false;
    const body = (): unknown => {
      if (!parsedOnce) {
        parsedOnce = true;
        try {
          parsed = captureReq && reqChunks.length > 0 ? JSON.parse(Buffer.concat(reqChunks).toString("utf8")) : undefined;
        } catch {
          parsed = undefined; // cut off at the capture limit
        }
      }
      return parsed;
    };
    let info: RequestInfo | null = null;
    const requestInfo = (): RequestInfo => (info ??= requestInfoFrom(body()));

    let exchangeOpen = false;
    const endExchange = (): void => {
      if (!exchangeOpen) return;
      exchangeOpen = false;
      opts.onExchange?.("end");
    };
    if (captureReq) {
      exchangeOpen = true;
      opts.onExchange?.("start");
    }
    if (captureReq && opts.onRequest) {
      clientReq.on("end", () => {
        try {
          opts.onRequest?.({ ...requestInfo(), secrets: scanRequest(body()) });
        } catch {
          /* observation only; never break the request */
        }
      });
    }

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
        const isMessages = provider.isObservablePath(targetPath);
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
        const sse = isStream ? provider.createTurnExtractor() : null;
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

        const emit = (turn: TurnContent): void => {
          if (!opts.onUsage) return;
          const u = turn.usage;
          const { prompt, background } = requestInfo();
          opts.onUsage({
            ts: new Date().toISOString(),
            type: "usage",
            path: targetPath,
            model: u.model,
            in: u.input_tokens,
            out: u.output_tokens,
            cache_read: u.cache_read_input_tokens,
            cache_write: u.cache_creation_input_tokens,
            cost_usd: ((c) => (c === null ? null : Number(c.toFixed(6))))(estimateCostUsd(u)),
            ...(prompt ? { prompt } : {}),
            ...(background ? { background: true } : {}),
            ...(turn.text ? { text: turn.text } : {}),
            ...(turn.tools.length ? { tools: turn.tools.map((t) => t.name) } : {}),
            ...(turn.tools.length
              ? { calls: turn.tools.map((t) => ({ tool: t.name, ...(t.target ? { target: t.target } : {}) })) }
              : {}),
            ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
          });
        };

        // A stream can end exactly once; guard so an error after data, or an
        // error following 'end', never emits a second usage event.
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          try {
            if (sse) {
              emit(sse.end());
            } else if (jsonChunks) {
              const turn = provider.extractTurnFromJson(Buffer.concat(jsonChunks).toString("utf8"));
              if (turn) emit(turn);
            }
          } finally {
            endExchange();
          }
        };
        const drain = (): void => {
          if (!observe) return endExchange();
          if (decompressor) decompressor.end(() => finish());
          else finish();
        };

        upstreamRes.on("data", (chunk: Buffer) => {
          // The agent may have gone away mid-stream; writing then throws.
          if (!clientRes.writableEnded && !clientRes.destroyed) clientRes.write(chunk);
          if (!observe) return;
          if (decompressor) decompressor.write(chunk); // observe a decoded copy
          else observeBytes(chunk);
        });

        upstreamRes.on("end", () => {
          if (!clientRes.writableEnded) clientRes.end();
          drain();
        });

        // Mid-stream upstream failure: end the client cleanly and still report
        // whatever usage we managed to observe. Never let this throw.
        upstreamRes.on("error", (err: Error) => {
          if (DEBUG) log(`upstream stream error: ${err.message}`);
          if (!clientRes.writableEnded && !clientRes.destroyed) clientRes.end();
          drain();
        });
      }
    );

    upstreamReq.on("error", (err: Error) => {
      endExchange();
      if (DEBUG) log(`upstream request error: ${err.message}`);
      if (clientRes.destroyed || clientRes.writableEnded) return;
      if (!clientRes.headersSent) clientRes.writeHead(502);
      clientRes.end("vantage proxy upstream error: " + err.message);
    });

    // If the agent aborts (Ctrl-C, crash, timeout) stop talking upstream
    // instead of leaking the socket — and never crash on the resulting error.
    const abortUpstream = (): void => {
      if (!upstreamReq.destroyed) upstreamReq.destroy();
    };
    clientReq.on("error", abortUpstream);
    clientRes.on("error", abortUpstream);
    clientRes.on("close", () => {
      if (!clientRes.writableEnded) abortUpstream();
      // Fallback for a response that never reached its end handlers.
      setTimeout(endExchange, 5_000).unref();
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
