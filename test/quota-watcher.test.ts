// Tests for the threshold warner: fires once on crossing, quiet while over,
// re-arms after dropping below, and warns acutely on rejected / retry-after.

import { test } from "node:test";
import assert from "node:assert/strict";
import { QuotaWatcher, extractRateLimit } from "../src/ratelimit.ts";

function unified(util5h: number, status = "allowed") {
  return extractRateLimit({
    "anthropic-ratelimit-unified-status": status,
    "anthropic-ratelimit-unified-5h-status": status,
    "anthropic-ratelimit-unified-5h-utilization": String(util5h),
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(Date.now() / 1000) + 3600),
  })!;
}

test("warns once when crossing the threshold, then stays quiet", () => {
  const w = new QuotaWatcher(0.9);
  assert.equal(w.update(unified(0.5)).length, 0, "below threshold: no warning");
  const first = w.update(unified(0.92));
  assert.equal(first.length, 1, "crossing: one warning");
  assert.equal(first[0]!.level, "warn");
  assert.match(first[0]!.message, /5-hour limit 92% used/);
  assert.equal(w.update(unified(0.95)).length, 0, "still over: no repeat");
});

test("re-arms after utilization drops below the threshold", () => {
  const w = new QuotaWatcher(0.9);
  assert.equal(w.update(unified(0.95)).length, 1);
  assert.equal(w.update(unified(0.2)).length, 0, "recovered: cleared");
  assert.equal(w.update(unified(0.95)).length, 1, "re-arms and warns again");
});

test("warns critically when a window is rejected", () => {
  const w = new QuotaWatcher(0.9);
  const out = w.update(unified(1.0, "rejected"));
  const critical = out.find((x) => x.level === "critical");
  assert.ok(critical, "a critical warning is emitted");
  assert.match(critical!.message, /rejected/);
});

test("warns on retry-after", () => {
  const w = new QuotaWatcher(0.9);
  const snap = extractRateLimit({ "retry-after": "30" })!;
  const out = w.update(snap);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.level, "critical");
  assert.match(out[0]!.message, /retry after 30s/);
});

test("classic buckets warn when nearly drained", () => {
  const w = new QuotaWatcher(0.9);
  const snap = extractRateLimit({
    "anthropic-ratelimit-tokens-limit": "1000",
    "anthropic-ratelimit-tokens-remaining": "50", // 95% used
  })!;
  const out = w.update(snap);
  assert.equal(out.length, 1);
  assert.match(out[0]!.message, /tokens 95% used/);
});

test("allowed_warning is close to the limit, not blocked", () => {
  const w = new QuotaWatcher(0.9);
  const out = w.update({
    unified: {
      status: "allowed_warning",
      representativeClaim: null,
      overageStatus: null,
      windows: [{ key: "5h", status: "allowed_warning", utilization: 0.92, resetUnix: null }],
    },
    retryAfterSec: null,
    raw: {},
  });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.level, "warn");
  assert.doesNotMatch(out[0]!.message, /blocked/);
});
