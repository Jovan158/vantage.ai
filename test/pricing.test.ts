// Pricing: exact model IDs, list prices from the official pricing page, the
// 5m/1h cache-write split, and "price unknown" instead of guessing.

import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { estimateCostUsd, priceFor, normalizeModelId, formatCost } from "../src/pricing.ts";
import type { TokenUsage } from "../src/usage.ts";

// Price against the bundled list only, never this machine's
// `vantage pricing update` file.
process.env.VANTAGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-home-"));

const usage = (model: string | null, over: Partial<TokenUsage> = {}): TokenUsage => ({
  model,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  ...over,
});
const close = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 1e-9;

// Regression, with the numbers from a real Windows session: Opus 5.5, 2 in,
// 109 out, 77k cache writes. The old prefix table priced this at Opus 4.1
// rates and showed ~$1.45; list price is $4 in / $20 out / $5 5m write.
test("Opus 5.5 is priced at its own list price, not old Opus rates", () => {
  const u = usage("claude-opus-5-5", { input_tokens: 2, output_tokens: 109, cache_creation_input_tokens: 77_000 });
  assert.ok(close(estimateCostUsd(u), (2 * 4 + 109 * 20 + 77_000 * 5) / 1e6)); // $0.387188
});

test("1-hour cache writes are billed at the 1h rate when the split is reported", () => {
  const u = usage("claude-opus-5-5", {
    output_tokens: 109,
    cache_creation_input_tokens: 77_000,
    cache_write_1h_tokens: 77_000,
  });
  assert.ok(close(estimateCostUsd(u), (109 * 20 + 77_000 * 8) / 1e6));
  const mixed = usage("claude-opus-5", { cache_creation_input_tokens: 1000, cache_write_1h_tokens: 400 });
  assert.ok(close(estimateCostUsd(mixed), (600 * 6.25 + 400 * 10) / 1e6));
});

test("model-specific cache-read multipliers", () => {
  assert.equal(priceFor("claude-opus-5-5")!.cache_read, 0.2); // 0.05x
  assert.equal(priceFor("claude-fable-5-1")!.cache_read, 0.25); // 0.025x
  assert.equal(priceFor("claude-fable-5")!.cache_read, 1); // standard 0.1x
  assert.equal(priceFor("claude-sonnet-5")!.cache_read, 0.2);
});

test("lookup is exact: no prefix bleeding between model generations", () => {
  assert.equal(priceFor("claude-opus-4")!.input, 15);
  assert.equal(priceFor("claude-opus-4-8")!.input, 5);
  assert.equal(priceFor("claude-opus-5")!.input, 5);
  assert.equal(priceFor("claude-opus-5-5")!.input, 4);
  assert.equal(priceFor("claude-sonnet-5")!.input, 2);
  assert.equal(priceFor("claude-sonnet-4-6")!.input, 3);
  assert.equal(priceFor("claude-haiku-4-5")!.output, 5);
});

test("dated snapshot IDs and context tags resolve to the base model", () => {
  assert.equal(normalizeModelId("claude-opus-4-5-20251101"), "claude-opus-4-5");
  assert.equal(normalizeModelId("claude-opus-5[1m]"), "claude-opus-5");
  assert.equal(priceFor("claude-3-5-haiku-20241022")!.input, 0.8);
});

test("unknown models have no price — never a guessed one", () => {
  assert.equal(priceFor("claude-opus-9"), null);
  assert.equal(priceFor("some-gateway-model"), null);
  assert.equal(priceFor(null), null);
  assert.equal(estimateCostUsd(usage("claude-opus-9", { input_tokens: 1000 })), null);
});

test("cost label states what is and is not priced", () => {
  assert.equal(formatCost(0.387, 0, 1), "~$0.3870 (est.)");
  assert.equal(formatCost(0, 2, 2), "cost n/a (price unknown)");
  assert.equal(formatCost(0.1, 1, 3), "~$0.1000 (est., 1 request(s) unpriced)");
  assert.equal(formatCost(0, 0, 0), "~$0.0000 (est.)");
});
