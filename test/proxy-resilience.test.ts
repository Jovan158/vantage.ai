// Hardening tests: the proxy sits between the agent and the provider, so a
// crash here kills the user's session mid-work. These exercise the failure
// paths that previously had no error handler at all (an unhandled 'error'
// event on any of the three streams would throw and take the process down).

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { startProxy } from "../src/proxy.ts";
import type { UsageEvent } from "../src/events.ts";

function listen(server: http.Server): Promise<number> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)));
}

const sseHead = { "content-type": "text/event-stream; charset=utf-8" };

test("upstream dying mid-stream does not crash and still reports usage", async () => {
  // Sends a valid message_start (with usage), then destroys the socket.
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, sseHead);
    res.write(
      `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { model: "claude-sonnet-5", usage: { input_tokens: 42, output_tokens: 1 } },
      })}\n\n`
    );
    setTimeout(() => res.socket?.destroy(), 10); // abrupt death, no proper end
  });
  const port = await listen(upstream);

  let usage: UsageEvent | null = null;
  const proxy = await startProxy({
    upstream: `http://127.0.0.1:${port}`,
    onUsage: (e) => {
      usage = e;
    },
  });

  await new Promise<void>((resolve) => {
    const req = http.request(proxy.url + "/v1/messages", { method: "POST" }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve());
      res.on("error", () => resolve()); // client may see an aborted stream
    });
    req.on("error", () => resolve());
    req.end("{}");
  });

  // Give the proxy a tick to settle its own stream events.
  await new Promise((r) => setTimeout(r, 50));

  // The point: we are still alive. Partial usage is reported, not lost.
  const u = usage as unknown as UsageEvent | null;
  assert.ok(u, "partial usage is still emitted after an upstream failure");
  assert.equal(u!.in, 42);

  await proxy.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

test("client aborting mid-stream does not crash the proxy", async () => {
  let upstreamClosed = false;
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, sseHead);
    // Keep streaming until someone stops us.
    const timer = setInterval(() => {
      if (!res.writableEnded) res.write(`event: ping\ndata: {}\n\n`);
    }, 5);
    res.on("close", () => {
      upstreamClosed = true;
      clearInterval(timer);
    });
  });
  const port = await listen(upstream);
  const proxy = await startProxy({ upstream: `http://127.0.0.1:${port}` });

  await new Promise<void>((resolve) => {
    const req = http.request(proxy.url + "/v1/messages", { method: "POST" }, (res) => {
      res.once("data", () => {
        req.destroy(); // agent goes away mid-stream
        resolve();
      });
    });
    req.on("error", () => resolve());
    req.end("{}");
  });

  await new Promise((r) => setTimeout(r, 80));

  // Proxy still serves new requests — i.e. the process survived the abort.
  assert.equal(upstreamClosed, true, "upstream socket was released, not leaked");
  const alive = await new Promise<boolean>((resolve) => {
    const s = net.connect(proxy.port, "127.0.0.1", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
  assert.equal(alive, true, "proxy is still accepting connections");

  await proxy.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

test("unreachable upstream returns 502 instead of crashing", async () => {
  // Port 1 is reserved and will refuse the connection.
  const proxy = await startProxy({ upstream: "http://127.0.0.1:1" });

  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(proxy.url + "/v1/messages", { method: "POST" }, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end("{}");
  });

  assert.equal(status, 502);
  await proxy.close();
});
