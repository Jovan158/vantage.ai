// Upstream connector that honors the environment's HTTPS proxy.
//
// Node's https.request does NOT use HTTPS_PROXY automatically. In corporate /
// sandboxed setups the only egress path is an HTTP proxy that expects a CONNECT
// tunnel. This builds an https.Agent whose createConnection tunnels through that
// proxy — unless the host is covered by NO_PROXY, in which case it connects
// directly. For plain-HTTP upstreams (e.g. a local mock) no agent is needed.

import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import net from "node:net";
import { URL } from "node:url";

function proxyUrlFor(protocol: string): string | undefined {
  const https_ = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const http_ = process.env.HTTP_PROXY ?? process.env.http_proxy;
  return protocol === "https:" ? https_ : http_ ?? https_;
}

// Matches host against a NO_PROXY entry: exact, dot-suffix, or leading-dot.
function matchesNoProxyEntry(host: string, entry: string): boolean {
  const e = entry.trim().toLowerCase();
  if (!e) return false;
  if (e === "*") return true;
  const h = host.toLowerCase();
  const bare = e.startsWith(".") ? e.slice(1) : e;
  return h === bare || h.endsWith("." + bare);
}

export function isBypassed(host: string): boolean {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return raw.split(",").some((entry) => matchesNoProxyEntry(host, entry));
}

export interface UpstreamTransport {
  client: typeof http | typeof https;
  agent: http.Agent | https.Agent | undefined;
  /** How this upstream is reached — for logging/diagnostics. */
  via: "direct" | "proxy-tunnel";
}

export function upstreamTransport(upstream: string): UpstreamTransport {
  const url = new URL(upstream);
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;

  const proxy = proxyUrlFor(url.protocol);
  if (!proxy || isBypassed(url.hostname)) {
    return { client, agent: undefined, via: "direct" };
  }

  const proxyUrl = new URL(proxy);
  const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === "https:" ? 443 : 80);

  // For an HTTPS upstream we must CONNECT-tunnel, then TLS over the tunnel.
  if (isHttps) {
    const agent = new https.Agent({
      // @ts-expect-error Node's createConnection override signature
      createConnection(opts: { host: string; port: number }, cb: (err: Error | null, sock?: net.Socket) => void) {
        const connectReq = http.request({
          host: proxyUrl.hostname,
          port: proxyPort,
          method: "CONNECT",
          path: `${opts.host}:${opts.port}`,
          headers: { Host: `${opts.host}:${opts.port}` },
        });
        connectReq.on("connect", (res, socket) => {
          if (res.statusCode !== 200) {
            cb(new Error(`proxy CONNECT failed: ${res.statusCode} ${res.statusMessage ?? ""}`.trim()));
            socket.destroy();
            return;
          }
          const tlsSocket = tls.connect(
            { socket, servername: opts.host, host: opts.host, port: opts.port },
            () => cb(null, tlsSocket)
          );
          tlsSocket.on("error", (err) => cb(err));
        });
        connectReq.on("error", (err) => cb(err));
        connectReq.end();
      },
    });
    return { client, agent, via: "proxy-tunnel" };
  }

  // Plain-HTTP upstream through an HTTP proxy: absolute-form request URI.
  const agent = new http.Agent();
  return { client, agent, via: "proxy-tunnel" };
}
