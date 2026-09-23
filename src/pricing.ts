// Per-model prices (USD per 1M tokens) for the cost estimate.
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing, fetched
// 2026-09-23. Prices change — this table must be refreshed from that page, not
// from memory. An earlier version matched on name prefixes ("claude-opus") with
// remembered prices and priced Opus 5.5 at the old Opus 4.1 rates, about 3x
// too high. So lookup is by exact model ID, and a model that is not in the
// table has NO price: the meter says "price unknown" rather than guess.
//
// Not modelled: fast mode, the 1.1x US-only inference multiplier, batch.
// Under a subscription (Pro/Max) no per-token cost applies at all — the
// estimate is what the same traffic would cost on the API; the quota line is
// the real signal there (CONCEPT.md §6a).
//
// OpenAI prices are deliberately absent: they could not be verified from the
// current environment, so OpenAI-based agents show "price unknown".

import type { TokenUsage } from "./usage.ts";

export interface ModelPricing {
  input: number;
  /** 5-minute cache write (1.25x input on most models). */
  cache_write_5m: number;
  /** 1-hour cache write (2x input). */
  cache_write_1h: number;
  /** Cache hit / refresh. */
  cache_read: number;
  output: number;
}

const p = (input: number, w5: number, w1h: number, read: number, output: number): ModelPricing => ({
  input,
  cache_write_5m: w5,
  cache_write_1h: w1h,
  cache_read: read,
  output,
});

const FABLE_5_1 = p(10, 12.5, 20, 0.25, 50);
const FABLE_5 = p(10, 12.5, 20, 1, 50);
const OPUS_5_5 = p(4, 5, 8, 0.2, 20);
const OPUS_5 = p(5, 6.25, 10, 0.5, 25);
const OPUS_4_1 = p(15, 18.75, 30, 1.5, 75);
const SONNET_5 = p(2, 2.5, 4, 0.2, 10);
const SONNET_4 = p(3, 3.75, 6, 0.3, 15);
const HAIKU_4_5 = p(1, 1.25, 2, 0.1, 5);
const HAIKU_3_5 = p(0.8, 1, 1.6, 0.08, 4);

// Keyed by exact model ID (after normalisation, see below).
const PRICES: Record<string, ModelPricing> = {
  "claude-fable-5-1": FABLE_5_1,
  "claude-mythos-5-1": FABLE_5_1,
  "claude-fable-5": FABLE_5,
  "claude-mythos-5": FABLE_5,
  "claude-opus-5-5": OPUS_5_5,
  "claude-opus-5": OPUS_5,
  "claude-opus-4-8": OPUS_5,
  "claude-opus-4-7": OPUS_5,
  "claude-opus-4-6": OPUS_5,
  "claude-opus-4-5": OPUS_5,
  "claude-opus-4-1": OPUS_4_1,
  "claude-opus-4": OPUS_4_1,
  "claude-sonnet-5": SONNET_5,
  "claude-sonnet-4-6": SONNET_4,
  "claude-sonnet-4-5": SONNET_4,
  "claude-sonnet-4": SONNET_4,
  "claude-haiku-4-5": HAIKU_4_5,
  "claude-3-5-haiku": HAIKU_3_5,
};

// Responses may carry a dated snapshot ID ("claude-opus-4-5-20251101") or a
// context-window tag ("claude-opus-5[1m]"); both price like the base model.
export function normalizeModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
}

export function priceFor(model: string | null): ModelPricing | null {
  if (!model) return null;
  return PRICES[normalizeModelId(model)] ?? null;
}

// Estimated USD for one request, or null when the model's price is unknown.
export function estimateCostUsd(usage: TokenUsage): number | null {
  const price = priceFor(usage.model);
  if (!price) return null;
  // cache_creation_input_tokens is the total written; the 1h share (when the
  // response reports the split) is billed at the 1h rate, the rest at 5m.
  const write1h = Math.min(usage.cache_write_1h_tokens ?? 0, usage.cache_creation_input_tokens);
  const write5m = usage.cache_creation_input_tokens - write1h;
  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      write5m * price.cache_write_5m +
      write1h * price.cache_write_1h +
      usage.cache_read_input_tokens * price.cache_read) /
    1_000_000
  );
}

// One cost label for every view. `unpriced` counts requests whose model had
// no known price; their cost is NOT in `knownUsd`, and the label says so.
export function formatCost(knownUsd: number, unpriced: number, requests: number): string {
  if (requests > 0 && unpriced >= requests) return "cost n/a (price unknown)";
  const base = `~$${knownUsd.toFixed(4)}`;
  if (unpriced > 0) return `${base} (est., ${unpriced} request(s) unpriced)`;
  return `${base} (est.)`;
}
