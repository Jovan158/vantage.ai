// Unit tests for rate-limit extraction: the usage windows of a subscription.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRateLimit, formatRateLimit } from "../src/ratelimit.ts";

test("parses unified subscription headers (real Claude Code shape)", () => {
  // Captured from a real api.anthropic.com response.
  const headers = {
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-overage-status": "rejected",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.5",
    "anthropic-ratelimit-unified-5h-reset": "1789729200",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.06",
    "anthropic-ratelimit-unified-7d-reset": "1790287200",
  };
  const s = extractRateLimit(headers);
  assert.ok(s);
  assert.ok(s!.unified);
  assert.equal(s!.unified!.representativeClaim, "five_hour");
  const w5 = s!.unified!.windows.find((w) => w.key === "5h");
  assert.equal(w5?.utilization, 0.5);
  assert.equal(w5?.resetUnix, 1789729200);

  // Format at a fixed "now" 2 hours before the 5h reset.
  const now = (1789729200 - 7200) * 1000;
  const line = formatRateLimit(s!, now);
  assert.ok(line);
  assert.match(line!, /quota 5h 50% used/);
  assert.match(line!, /reset 2h/);
  assert.match(line!, /7d 6% used/);
});

test("an API key's per-minute limits are not read: it has no usage windows", () => {
  const headers = {
    "anthropic-ratelimit-requests-limit": "50",
    "anthropic-ratelimit-requests-remaining": "49",
    "anthropic-ratelimit-input-tokens-limit": "30000",
    "anthropic-ratelimit-input-tokens-remaining": "1200",
    "x-ratelimit-remaining-tokens": "100",
  };
  assert.equal(extractRateLimit(headers), null);
  assert.equal(extractRateLimit({ "retry-after": "30" }), null, "a 429 on an API key is the agent's to wait out");
});

test("surfaces retry-after and non-allowed status", () => {
  const s = extractRateLimit({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1.0",
    "retry-after": "30",
  });
  assert.ok(s);
  assert.equal(s!.retryAfterSec, 30);
  const line = formatRateLimit(s!);
  assert.match(line!, /\[rejected\]/);
  assert.match(line!, /retry-after 30s/);
});

test("returns null when no rate-limit headers present", () => {
  assert.equal(extractRateLimit({ "content-type": "text/event-stream" }), null);
});
