// Spike runner: proves the riskiest assumption of the Vantage MVP.
//
// Chain:  client  ->  vantage proxy  ->  mock anthropic (SSE)
//
// Asserts:
//   1. TRANSPARENCY  — bytes the client receives are IDENTICAL to what the
//      upstream emitted (the proxy is invisible).
//   2. USAGE         — input/output/cache tokens are correctly extracted from
//      the streamed SSE frames.
//   3. COST          — an estimate is computed from the price table.
//   4. EVENT LOG     — one `usage` event is appended to events.jsonl.
//
// Run:  node spike/proxy-passthrough/run-spike.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { startMockAnthropic, EXPECTED_USAGE } from "./mock-anthropic.mjs";
import { startProxy } from "./proxy.mjs";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let failures = 0;
function check(name, cond, detail = "") {
  const mark = cond ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  [${mark}] ${name}${detail ? `  ${DIM}${detail}${RESET}` : ""}`);
  if (!cond) failures++;
}

// POST through the proxy and collect the raw response bytes exactly as received.
function postThroughProxy(proxyUrl) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const firstByteMarker = { t: 0 };
    const started = Date.now();
    const req = http.request(
      proxyUrl + "/v1/messages",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-spike" },
      },
      (res) => {
        res.on("data", (c) => {
          if (chunks.length === 0) firstByteMarker.t = Date.now() - started;
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({ body: Buffer.concat(chunks), ttfbMs: firstByteMarker.t })
        );
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [] }));
  });
}

async function main() {
  console.log("\nVantage spike — transparent streaming proxy + usage extraction\n");

  const eventsPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "vantage-spike-")),
    "events.jsonl"
  );

  const mock = await startMockAnthropic();
  const proxy = await startProxy({ upstream: mock.url, eventsPath });

  // Capture the usage event the proxy emits.
  let emittedEvent = null;
  proxy.server.on("vantage:usage", (e) => (emittedEvent = e));

  const { body, ttfbMs } = await postThroughProxy(proxy.url);

  // --- 1. TRANSPARENCY -----------------------------------------------------
  const identical = body.equals(mock.fullBody);
  check(
    "byte-for-byte transparency (client bytes === upstream bytes)",
    identical,
    identical ? `${body.length} bytes` : `got ${body.length}, expected ${mock.fullBody.length}`
  );
  // The client should still see a real SSE stream it can parse.
  check(
    "forwarded body is valid SSE the agent can read",
    body.toString().includes("event: message_start") &&
      body.toString().includes("Hallo")
  );

  // --- 2. USAGE ------------------------------------------------------------
  check(
    "input tokens extracted",
    emittedEvent?.in === EXPECTED_USAGE.input_tokens,
    `got ${emittedEvent?.in}, expected ${EXPECTED_USAGE.input_tokens}`
  );
  check(
    "output tokens extracted (final cumulative from message_delta)",
    emittedEvent?.out === EXPECTED_USAGE.output_tokens,
    `got ${emittedEvent?.out}, expected ${EXPECTED_USAGE.output_tokens}`
  );
  check(
    "cache-read tokens extracted",
    emittedEvent?.cache_read === EXPECTED_USAGE.cache_read_input_tokens,
    `got ${emittedEvent?.cache_read}, expected ${EXPECTED_USAGE.cache_read_input_tokens}`
  );
  check("model captured", emittedEvent?.model === EXPECTED_USAGE.model, emittedEvent?.model);

  // --- 3. COST -------------------------------------------------------------
  // sonnet: (1024*3 + 87*15 + 512*0.3) / 1e6 = 0.0045861 USD
  const expectedCost = (1024 * 3 + 87 * 15 + 512 * 0.3) / 1e6;
  check(
    "cost estimated from price table",
    Math.abs((emittedEvent?.cost_usd ?? -1) - expectedCost) < 1e-6,
    `$${emittedEvent?.cost_usd} (expected ~$${expectedCost.toFixed(6)})`
  );

  // --- 4. EVENT LOG --------------------------------------------------------
  const logged = fs.existsSync(eventsPath)
    ? fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
  check("events.jsonl written with one usage event", logged.length === 1);
  if (logged.length) {
    let ok = false;
    try {
      ok = JSON.parse(logged[0]).type === "usage";
    } catch {}
    check("logged event is valid JSON of type 'usage'", ok);
  }

  console.log(`\n  ${DIM}time-to-first-byte through proxy: ${ttfbMs}ms · events.jsonl: ${eventsPath}${RESET}`);

  proxy.server.close();
  mock.server.close();

  if (failures === 0) {
    console.log(`\n${GREEN}✔ Spike passed — the proxy streams transparently AND extracts usage.${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`\n${RED}�’✘ Spike failed: ${failures} check(s) failed.${RESET}\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
