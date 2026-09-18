// Placeholder price table (USD per 1M tokens). In production this belongs in
// updatable config, NOT hardcoded — prices drift. See CONCEPT.md §6a:
// tokens are exact; dollar cost is only accurate under API-key billing, not
// under subscription/flat-rate plans.

import type { TokenUsage } from "./usage.ts";

export interface ModelPricing {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
}

// Keyed by model-id prefix. Representative public list prices.
const PRICES: Record<string, ModelPricing> = {
  "claude-opus": { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  "claude-sonnet": { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  "claude-haiku": { input: 0.8, output: 4, cache_write: 1.0, cache_read: 0.08 },
};

const DEFAULT_PRICING = PRICES["claude-sonnet"]!;

export function priceFor(model: string | null): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  for (const prefix of Object.keys(PRICES)) {
    if (model.startsWith(prefix)) return PRICES[prefix]!;
  }
  return DEFAULT_PRICING;
}

export function estimateCostUsd(usage: TokenUsage): number {
  const p = priceFor(usage.model);
  const m = 1_000_000;
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      usage.cache_creation_input_tokens * p.cache_write +
      usage.cache_read_input_tokens * p.cache_read) /
    m
  );
}
