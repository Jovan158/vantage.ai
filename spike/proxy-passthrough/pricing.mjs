// Placeholder price table (USD per 1M tokens). In the real tool this lives in
// updatable config, NOT hardcoded — prices drift. Values here are representative
// public list prices and only serve to prove the cost-calc path in the spike.
//
// IMPORTANT (see CONCEPT.md §6a): tokens are exact; cost is only "very accurate"
// for API-key billing. Under subscription/flat-rate plans there is no per-token
// dollar cost — we then surface tokens + rate for limit prognosis, not euros.

const PRICES = {
  // model-id prefix : { input, output, cache_write, cache_read }  (USD / 1M)
  "claude-opus":   { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  "claude-sonnet": { input: 3,  output: 15, cache_write: 3.75,  cache_read: 0.3 },
  "claude-haiku":  { input: 0.8, output: 4, cache_write: 1.0,   cache_read: 0.08 },
};

function priceFor(model) {
  if (!model) return PRICES["claude-sonnet"];
  for (const prefix of Object.keys(PRICES)) {
    if (model.startsWith(prefix)) return PRICES[prefix];
  }
  return PRICES["claude-sonnet"];
}

export function estimateCostUsd(usage) {
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
