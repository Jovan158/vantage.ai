// Transparent streaming reverse proxy (layer B in docs/CONCEPT.md). Forwards every request
// verbatim to the upstream provider and streams the response body back
// chunk-by-chunk (no buffering, so SSE stays live), teeing the bytes into a
// usage extractor. On stream end it emits a typed UsageEvent.
//
// One proxy serves every provider an agent talks to. Each route is a path
// prefix the agent is pointed at ("/openai" → https://api.openai.com/v1); the
// default route has no prefix, which is how Claude Code is pointed at it.
// What a request carries is told by its path (src/formats), so an agent that
// switches models mid-session is still read right. WebSocket connections
// (Codex streams its turns over one) pass through as bytes, read from a copy.

import http from "node:http";
import zlib from "node:zlib";
import type net from "node:net";
import { URL } from "node:url";
import type { AddressInfo } from "node:net";
import type { Transform } from "node:stream";
import type { RequestInfo, TurnContent } from "./turn.ts";
import { scanParts, type SecretFinding } from "./secrets.ts";
import { formatForPath, FORMATS, type Format } from "./formats/index.ts";
import { createResponsesTurn, type ResponsesTurn } from "./formats/openai.ts";
import { estimateCostUsd } from "./pricing.ts";
import { upstreamTransport, type UpstreamTransport } from "./upstream.ts";
import { extractRateLimit, rateLimitFromEvent } from "./ratelimit.ts";
import type { RateLimitSnapshot } from "./ratelimit.ts";
import type { UsageEvent } from "./events.ts";
import { WsReader } from "./ws.ts";

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

// A compressed request body, decoded for observation only.
function decodeBody(buf: Buffer, encoding: string): Buffer | null {
  try {
    switch (encoding) {
      case "":
      case "identity":
        return buf;
      case "gzip":
      case "x-gzip":
        return zlib.gunzipSync(buf);
      case "deflate":
        return zlib.inflateSync(buf);
      case "br":
        return zlib.brotliDecompressSync(buf);
      case "zstd":
        return typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync(buf) : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export interface Route {
  /** Path prefix the agent is pointed at, e.g. "/openai"; "" is the default route. */
  prefix: string;
  /**
   * Base URL requests go to; its path comes before the request's own. A
   * function chooses per request (Codex: ChatGPT sign-in or API key).
   */
  upstream: string | ((headers: http.IncomingHttpHeaders) => string);
}

export interface ProxyOptions {
  /** The default route's upstream (shorthand for routes: [{ prefix: "", upstream }]). */
  upstream?: string;
  routes?: Route[];
  port?: number;
  /** Whose replies these are, in secret findings ("Claude's reply"). */
  agentName?: string;
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

interface Target {
  url: URL;
  /** The upstream path with query, e.g. /v1/messages?beta=true. */
  path: string;
  transport: UpstreamTransport;
}

// The route a request path belongs to: the longest matching prefix.
export function matchRoute(routes: Route[], reqPath: string): { route: Route; rest: string } | null {
  let best: Route | null = null;
  for (const r of routes) {
    const p = r.prefix.replace(/\/+$/, "");
    const hit = p === "" || reqPath === p || reqPath.startsWith(p + "/") || reqPath.startsWith(p + "?");
    if (hit && (!best || p.length > best.prefix.replace(/\/+$/, "").length)) best = r;
  }
  if (!best) return null;
  return { route: best, rest: reqPath.slice(best.prefix.replace(/\/+$/, "").length) };
}

function joinPath(base: URL, rest: string): string {
  const basePath = base.pathname.replace(/\/+$/, "");
  if (rest === "" || rest.startsWith("?")) return (basePath || "/") + rest;
  return basePath + (rest.startsWith("/") ? rest : "/" + rest);
}

// A turn with nothing in it (a WebSocket warm-up, an empty retry) is noise.
function isEmptyTurn(t: TurnContent): boolean {
  const u = t.usage;
  return !u.input_tokens && !u.output_tokens && !u.cache_read_input_tokens && !u.cache_creation_input_tokens && !t.text && t.tools.length === 0;
}

export function startProxy(opts: ProxyOptions): Promise<RunningProxy> {
  const log = opts.log ?? stderrLog;
  const agentName = opts.agentName ?? "Claude";
  // Conversation parts already scanned for secrets (see secrets.ts).
  const scanned = new Set<string>();
  const routes: Route[] = opts.routes ?? (opts.upstream ? [{ prefix: "", upstream: opts.upstream }] : []);
  const transports = new Map<string, UpstreamTransport>();
  const transportFor = (url: URL): UpstreamTransport => {
    let t = transports.get(url.origin);
    if (!t) transports.set(url.origin, (t = upstreamTransport(url.origin)));
    return t;
  };
  const firstUpstream = routes.map((r) => (typeof r.upstream === "string" ? r.upstream : null)).find(Boolean);
  const via = firstUpstream ? upstreamTransport(firstUpstream).via : upstreamTransport("https://example.com").via;

  const resolveTarget = (reqPath: string, headers: http.IncomingHttpHeaders): Target | null => {
    const m = matchRoute(routes, reqPath);
    if (!m) return null;
    const base = typeof m.route.upstream === "function" ? m.route.upstream(headers) : m.route.upstream;
    const url = new URL(base);
    return { url, path: joinPath(url, m.rest), transport: transportFor(url) };
  };

  const emitTurn = (turn: TurnContent, path: string, info: RequestInfo): void => {
    if (!opts.onUsage || isEmptyTurn(turn)) return;
    const u = turn.usage;
    opts.onUsage({
      ts: new Date().toISOString(),
      type: "usage",
      path: path.split("?")[0]!,
      model: u.model,
      in: u.input_tokens,
      out: u.output_tokens,
      cache_read: u.cache_read_input_tokens,
      cache_write: u.cache_creation_input_tokens,
      cost_usd: ((c) => (c === null ? null : Number(c.toFixed(6))))(estimateCostUsd(u)),
      ...(info.prompt ? { prompt: info.prompt } : {}),
      ...(info.background ? { background: true } : {}),
      ...(turn.text ? { text: turn.text } : {}),
      ...(turn.tools.length ? { tools: turn.tools.map((t) => t.name) } : {}),
      ...(turn.tools.length
        ? { calls: turn.tools.map((t) => ({ tool: t.name, ...(t.target ? { target: t.target } : {}) })) }
        : {}),
      ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
    });
  };

  const observeRequest = (format: Format, body: unknown): RequestInfo => {
    const info = format.requestInfo(body);
    if (opts.onRequest) {
      try {
        opts.onRequest({ ...info, secrets: scanParts(format.parts(body, agentName), scanned) });
      } catch {
        /* observation only; never break the request */
      }
    }
    return info;
  };

  const server = http.createServer((clientReq, clientRes) => {
    const target = resolveTarget(clientReq.url ?? "/", clientReq.headers);
    if (!target) {
      clientRes.writeHead(404);
      clientRes.end("vantage proxy: no route for this path");
      return;
    }
    const targetPath = target.path;
    const format = formatForPath(targetPath);
    const headers = { ...clientReq.headers, host: target.url.host };

    // Tee the request body (capped) to recover the last user prompt. The cap
    // is high because a long session resends its whole history every turn;
    // a body cut off at the cap yields no prompt.
    const reqChunks: Buffer[] = [];
    let reqBytes = 0;
    const captureReq =
      clientReq.method === "POST" && format !== null && String(clientReq.headers["content-type"] ?? "").includes("json");
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
          const raw = captureReq && reqChunks.length > 0 ? decodeBody(Buffer.concat(reqChunks), String(clientReq.headers["content-encoding"] ?? "").toLowerCase()) : null;
          parsed = raw ? JSON.parse(raw.toString("utf8")) : undefined;
        } catch {
          parsed = undefined; // cut off at the capture limit
        }
      }
      return parsed;
    };
    let info: RequestInfo | null = null;
    const requestInfo = (): RequestInfo => (info ??= format ? format.requestInfo(body()) : { prompt: null, background: false });

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
    if (captureReq && format) {
      clientReq.on("end", () => {
        info = observeRequest(format, body());
      });
    }

    const upstreamReq = target.transport.client.request(
      {
        protocol: target.url.protocol,
        hostname: target.url.hostname,
        port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
        method: clientReq.method,
        path: targetPath,
        headers,
        agent: target.transport.agent,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);

        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        const encoding = String(upstreamRes.headers["content-encoding"] ?? "").toLowerCase();
        const isStream = format !== null && contentType.includes("text/event-stream");
        const isJson = format !== null && contentType.includes("application/json") && (upstreamRes.statusCode ?? 0) < 400;
        const observe = isStream || isJson;

        if (DEBUG) {
          log(`upstream ${upstreamRes.statusCode} ${target.url.host}${targetPath} · format=${format?.name ?? "-"} · type=${contentType || "?"} · enc=${encoding || "none"}`);
        }

        // Rate-limit headers are available immediately (no body needed).
        const rl = extractRateLimit(upstreamRes.headers);
        if (rl) {
          if (DEBUG) log(`ratelimit headers: ${JSON.stringify(rl.raw)}`);
          opts.onRateLimit?.(rl);
        } else if (DEBUG && format) {
          log("ratelimit headers: none present on this response");
        }

        // The extractor must see PLAINTEXT, but the client must get the EXACT
        // upstream bytes. If the response is compressed we forward raw bytes to
        // the client and feed a decompressed copy to the observer. Streaming
        // responses parse SSE incrementally; JSON responses buffer the body.
        const sse = isStream && format ? format.createTurnExtractor(targetPath) : null;
        const jsonChunks: Buffer[] | null = isJson ? [] : null;
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

        // A stream can end exactly once; guard so an error after data, or an
        // error following 'end', never emits a second usage event.
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          try {
            if (sse) {
              emitTurn(sse.end(), targetPath, requestInfo());
            } else if (jsonChunks && format) {
              const turn = format.extractTurnFromJson(Buffer.concat(jsonChunks).toString("utf8"), targetPath);
              if (turn) emitTurn(turn, targetPath, requestInfo());
            }
          } catch {
            /* observation only */
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

  // WebSocket: pass the handshake and then the bytes through both ways,
  // reading a copy of each direction. Only the Responses API is read this way
  // (Codex); any other WebSocket passes through unread.
  // Upgraded sockets leave the server's books; they are closed with it.
  const upgraded = new Set<net.Socket>();
  const track = (s: net.Socket): void => {
    upgraded.add(s);
    s.on("close", () => upgraded.delete(s));
  };

  server.on("upgrade", (clientReq: http.IncomingMessage, clientSocket: net.Socket, clientHead: Buffer) => {
    clientSocket.on("error", () => {});
    track(clientSocket);
    const target = resolveTarget(clientReq.url ?? "/", clientReq.headers);
    if (!target) {
      clientSocket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const readable = formatForPath(target.path)?.name === "openai-responses";
    const headers: http.OutgoingHttpHeaders = { ...clientReq.headers, host: target.url.host };
    // No compression, so the frames can be read; the upstream then sends
    // plain frames, which every client accepts.
    delete headers["sec-websocket-extensions"];

    const upstreamReq = target.transport.client.request({
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
      method: clientReq.method,
      path: target.path,
      headers,
      agent: target.transport.agent,
    });

    upstreamReq.on("upgrade", (res: http.IncomingMessage, upSocket: net.Socket, upHead: Buffer) => {
      track(upSocket);
      upSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upSocket.destroy());
      const lines = [`HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? "Switching Protocols"}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      clientSocket.write(lines.join("\r\n") + "\r\n\r\n");
      if (DEBUG) log(`websocket ${target.url.host}${target.path}`);

      const rl = extractRateLimit(res.headers);
      if (rl) opts.onRateLimit?.(rl);

      // One exchange per response.create, ended by its response.completed.
      let turn: ResponsesTurn | null = null;
      let info: RequestInfo = { prompt: null, background: false };
      let open = 0;
      const endOne = (): void => {
        if (open > 0) {
          open--;
          opts.onExchange?.("end");
        }
      };
      const fromClient = readable
        ? new WsReader((text) => {
            const msg = JSON.parse(text) as { type?: string };
            if (msg?.type !== "response.create") return;
            info = observeRequest(FORMATS["openai-responses"], msg);
            open++;
            opts.onExchange?.("start");
          })
        : null;
      const fromServer = readable
        ? new WsReader((text) => {
            const event = JSON.parse(text) as { type?: string };
            const limits = rateLimitFromEvent(event);
            if (limits) {
              opts.onRateLimit?.(limits);
              return;
            }
            turn ??= createResponsesTurn();
            if (turn.handle(event)) {
              const done = turn.result();
              turn = null;
              try {
                emitTurn(done, target.path, info);
              } finally {
                endOne();
              }
            } else if (event?.type === "error") {
              turn = null;
              endOne();
            }
          })
        : null;

      if (upHead.length) {
        clientSocket.write(upHead);
        fromServer?.feed(upHead);
      }
      if (clientHead.length) {
        upSocket.write(clientHead);
        fromClient?.feed(clientHead);
      }
      upSocket.on("data", (d: Buffer) => {
        if (!clientSocket.destroyed) clientSocket.write(d);
        fromServer?.feed(d);
      });
      clientSocket.on("data", (d: Buffer) => {
        if (!upSocket.destroyed) upSocket.write(d);
        fromClient?.feed(d);
      });
      const closeBoth = (): void => {
        while (open > 0) endOne();
        if (!upSocket.destroyed) upSocket.end();
        if (!clientSocket.destroyed) clientSocket.end();
      };
      upSocket.on("close", closeBoth);
      clientSocket.on("close", closeBoth);
    });

    // The upstream refused the upgrade: hand its answer to the agent, which
    // then falls back to plain HTTP.
    upstreamReq.on("response", (res: http.IncomingMessage) => {
      const lines = [`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ""}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const name = res.rawHeaders[i]!.toLowerCase();
        if (name === "transfer-encoding" || name === "connection") continue;
        lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      }
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const b = Buffer.concat(chunks);
        lines.push(`Content-Length: ${b.length}`, "Connection: close");
        clientSocket.end(Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n\r\n"), b]));
      });
    });
    upstreamReq.on("error", (err: Error) => {
      if (DEBUG) log(`websocket upstream error: ${err.message}`);
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    upstreamReq.end();
  });

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        via,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            // Open WebSockets and keep-alive sockets must not hold the exit.
            server.closeAllConnections?.();
            for (const s of upgraded) s.destroy();
          }),
      });
    });
  });
}
