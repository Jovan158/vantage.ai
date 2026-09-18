// Ports the spike's assertions into the standard test runner (node:test).
// Proves the proxy streams transparently AND extracts usage from real SSE.
//
// Run:  npm test   (node --experimental-strip-types --test test/*.test.ts)

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startMockAnthropic, EXPECTED_USAGE } from "../src/dev/mock-anthropic.ts";
import { startProxy } from "../src/proxy.ts";
import type { UsageEvent } from "../src/events.ts";

function postThroughProxy(
  proxyUrl: string
): Promise<{ body: Buffer; ttfbMs: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let ttfb = 0;
    const started = Date.now();
    const req = http.request(
      proxyUrl + "/v1/messages",
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        res.on("data", (c: Buffer) => {
          if (chunks.length === 0) ttfb = Date.now() - started;
          chunks.push(c);
        });
        res.on("end", () => resolve({ body: Buffer.concat(chunks), ttfbMs: ttfb }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [] }));
  });
}

test("proxy streams transparently and extracts usage", async () => {
  const mock = await startMockAnthropic();
  let usage: UsageEvent | null = null;
  const proxy = await startProxy({
    upstream: mock.url,
    onUsage: (e) => {
      usage = e;
    },
  });

  const { body } = await postThroughProxy(proxy.url);

  // 1. byte-for-byte transparency
  assert.ok(body.equals(mock.fullBody), "client bytes must equal upstream bytes");
  assert.ok(body.toString().includes("Hallo"), "forwarded body is readable SSE");

  // 2. usage extraction
  assert.ok(usage, "a usage event must be emitted");
  const u = usage as unknown as UsageEvent;
  assert.equal(u.in, EXPECTED_USAGE.input_tokens);
  assert.equal(u.out, EXPECTED_USAGE.output_tokens);
  assert.equal(u.cache_read, EXPECTED_USAGE.cache_read_input_tokens);
  assert.equal(u.model, EXPECTED_USAGE.model);

  // 3. cost estimate: (1024*3 + 87*15 + 512*0.3) / 1e6
  const expectedCost = (1024 * 3 + 87 * 15 + 512 * 0.3) / 1e6;
  assert.ok(Math.abs(u.cost_usd - expectedCost) < 1e-6, `cost ~$${expectedCost}`);

  await proxy.close();
  await mock.close();
});
