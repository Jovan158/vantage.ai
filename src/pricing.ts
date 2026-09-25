// Per-model prices (USD per 1M tokens) for the cost estimate.
//
// Prices are data, not code. Nobody types them in by hand. Each provider's
// official price page is read by a parser of its own:
//
//   official pages (Markdown form) ──► parsers (pricing-source.ts) ──┬─► src/pricing-snapshot.ts
//     Anthropic, OpenAI, Google                                      │     generated, ships with Vantage
//                                                                    └─► ~/.vantage/pricing*.json
//                                                                          written by `vantage pricing update`
//
// At runtime both are merged, and per model the NEWER source wins: a fresh
// `pricing update` beats an old release, and a newer release beats an old
// update. Vantage never fetches prices on its own — metering must not create
// traffic the user did not ask for — so the only network request is the
// explicit `vantage pricing update`.
//
// Lookup is by exact model ID. A model with no price is reported as
// "price unknown" rather than guessed: an earlier version matched name
// prefixes against remembered prices and showed Opus 5.5 at old Opus 4.1
// rates, about 3x too high.
//
// Not modelled: fast mode, the 1.1x US-only inference multiplier, batch.
// Under a subscription (Pro/Max) no per-token cost applies at all — the
// estimate is what the same traffic would cost on the API; the quota line is
// the real signal there (CONCEPT.md §6a).

import fs from "node:fs";
import path from "node:path";
import type { TokenUsage } from "./usage.ts";
import { vantageHome } from "./home.ts";
import { SNAPSHOT, SNAPSHOTS } from "./pricing-snapshot.ts";

/** Whose official price list a table is. */
export type PriceProvider = "anthropic" | "openai" | "google";
export const PRICE_PROVIDERS: PriceProvider[] = ["anthropic", "openai", "google"];

export interface BasePrices {
  input: number;
  /** 5-minute cache write (1.25x input on most Claude models). Providers
   * without a separate write price list it at the input price. */
  cache_write_5m: number;
  /** 1-hour cache write (2x input). */
  cache_write_1h: number;
  /** Cache hit / refresh. */
  cache_read: number;
  output: number;
}

export interface ModelPricing extends BasePrices {
  /** Prices for a prompt larger than `above` tokens (OpenAI's and Google's
   * long-context rates), when the page names the limit. */
  long?: BasePrices & { above: number };
  /** Prices the page announces from a later day (ISO date) on. */
  next?: BasePrices & { from: string };
}

export interface PriceEntry extends ModelPricing {
  /** Name as printed on the official page, e.g. "Claude Opus 5.5". */
  name: string;
}

export interface PriceTable {
  /** Whose list it is; tables from before 0.2.0 are Anthropic's. */
  provider?: PriceProvider;
  /** Where the table was read from. */
  source: string;
  /** ISO timestamp of the fetch. Decides which table wins in a merge. */
  fetchedAt: string;
  models: Record<string, PriceEntry>;
}

// ---------------------------------------------------------------------------
// Table validation — shared by the cache loader and the parser's output, so a
// hand-edited or truncated cache file can never feed the meter bad numbers.

const PRICE_FIELDS = ["input", "cache_write_5m", "cache_write_1h", "cache_read", "output"] as const;

// Column swaps are the realistic way a format change corrupts a table, and
// they break this ordering. It holds for every model on the page without
// assuming the exact multipliers, which are allowed to change. Anthropic
// lists every price for every model (`strict`); OpenAI and Google leave some
// out — no cache discount, no separate write price, output priced like
// input — so there the order only has to hold loosely.
export function plausiblePrice(p: BasePrices, strict = true): string | null {
  for (const f of PRICE_FIELDS) {
    if (typeof p[f] !== "number" || !Number.isFinite(p[f]) || p[f] <= 0) return `${f} is not a positive number`;
  }
  if (strict) {
    if (!(p.cache_read < p.input)) return "cache read is not cheaper than input";
    if (!(p.input < p.cache_write_5m && p.cache_write_5m < p.cache_write_1h)) return "cache writes are not above input (5m < 1h)";
    if (!(p.output > p.input)) return "output is not above input";
  } else {
    if (!(p.cache_read <= p.input)) return "cache read is above input";
    if (!(p.input <= p.cache_write_5m && p.cache_write_5m <= p.cache_write_1h)) return "cache writes are below input";
    if (!(p.output >= p.input)) return "output is below input";
  }
  return null;
}

// The whole entry: its base prices and, when present, the long-context and
// announced ones.
export function plausibleEntry(p: ModelPricing, strict = true): string | null {
  const bad = plausiblePrice(p, strict);
  if (bad) return bad;
  if (p.long) {
    const b = plausiblePrice(p.long, false);
    if (b) return `long context: ${b}`;
    if (!(Number.isFinite(p.long.above) && p.long.above > 0)) return "long context: no token limit";
  }
  if (p.next) {
    const b = plausiblePrice(p.next, strict);
    if (b) return `announced prices: ${b}`;
    if (Number.isNaN(Date.parse(p.next.from))) return "announced prices: no valid date";
  }
  return null;
}

export function validateTable(x: unknown): PriceTable {
  const t = x as Partial<PriceTable> | null;
  if (!t || typeof t !== "object") throw new Error("not an object");
  if (typeof t.source !== "string") throw new Error("missing source");
  if (typeof t.fetchedAt !== "string" || Number.isNaN(Date.parse(t.fetchedAt))) throw new Error("missing or invalid fetchedAt");
  if (!t.models || typeof t.models !== "object") throw new Error("missing models");
  const provider = t.provider ?? "anthropic";
  if (!PRICE_PROVIDERS.includes(provider)) throw new Error(`unknown provider ${String(provider)}`);
  const models: Record<string, PriceEntry> = {};
  const base = (p: BasePrices): BasePrices => ({
    input: p.input,
    cache_write_5m: p.cache_write_5m,
    cache_write_1h: p.cache_write_1h,
    cache_read: p.cache_read,
    output: p.output,
  });
  for (const [id, entry] of Object.entries(t.models)) {
    const bad = plausibleEntry(entry, provider === "anthropic");
    if (bad) throw new Error(`${id}: ${bad}`);
    models[id] = {
      name: typeof entry.name === "string" ? entry.name : id,
      ...base(entry),
      ...(entry.long ? { long: { above: entry.long.above, ...base(entry.long) } } : {}),
      ...(entry.next ? { next: { from: entry.next.from, ...base(entry.next) } } : {}),
    };
  }
  return { ...(t.provider ? { provider } : {}), source: t.source, fetchedAt: t.fetchedAt, models };
}

// ---------------------------------------------------------------------------
// Active prices: bundled snapshot + the user's last `pricing update`.

// Per user, not per project: prices do not depend on the repo. Anthropic's
// list keeps the name it had before there were others.
export function pricingCachePath(provider: PriceProvider = "anthropic"): string {
  return path.join(vantageHome(), provider === "anthropic" ? "pricing.json" : `pricing-${provider}.json`);
}

export interface CacheRead {
  table: PriceTable | null;
  /** Set when a cache file exists but was rejected; the snapshot is used. */
  error: string | null;
}

export function readPricingCache(file = pricingCachePath()): CacheRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { table: null, error: null };
  }
  try {
    return { table: validateTable(JSON.parse(raw)), error: null };
  } catch (err) {
    return { table: null, error: `${file}: ${(err as Error).message}` };
  }
}

export function writePricingCache(table: PriceTable, file = pricingCachePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename, so a crash never leaves a half-written file behind.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(table, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export interface ProviderPrices {
  bundled: PriceTable;
  cached: PriceTable | null;
  cacheError: string | null;
  /** fetchedAt of the newest table in use for this provider. */
  asOf: string;
}

export interface ActivePrices {
  /** Every provider's models, merged (model IDs do not overlap). */
  models: Record<string, PriceEntry>;
  /** Anthropic's, as before there were several. */
  bundled: PriceTable;
  cached: PriceTable | null;
  cacheError: string | null;
  providers: Record<PriceProvider, ProviderPrices>;
  /** The oldest of the providers' dates: how fresh the list is at worst. */
  asOf: string;
}

// Per model, the newer table wins. Models only one table lists are kept —
// a model that drops off the page (retired) still prices old sessions.
export function mergeTables(bundled: PriceTable, cached: PriceTable | null): Record<string, PriceEntry> {
  if (!cached) return { ...bundled.models };
  const cachedIsNewer = Date.parse(cached.fetchedAt) >= Date.parse(bundled.fetchedAt);
  return cachedIsNewer ? { ...bundled.models, ...cached.models } : { ...cached.models, ...bundled.models };
}

function providerPrices(bundled: PriceTable, file: string): ProviderPrices & { models: Record<string, PriceEntry> } {
  const { table: cached, error } = readPricingCache(file);
  const asOf =
    cached && Date.parse(cached.fetchedAt) > Date.parse(bundled.fetchedAt) ? cached.fetchedAt : bundled.fetchedAt;
  return { models: mergeTables(bundled, cached), bundled, cached, cacheError: error, asOf };
}

// `bundled` and `file` are Anthropic's; the others come from their own
// snapshot and file (`others` replaces them in tests).
export function loadActivePrices(
  bundled: PriceTable = SNAPSHOT,
  file = pricingCachePath(),
  others: Partial<Record<PriceProvider, PriceTable>> = { openai: SNAPSHOTS.openai, google: SNAPSHOTS.google }
): ActivePrices {
  const anthropic = providerPrices(bundled, file);
  const providers = { anthropic } as Record<PriceProvider, ProviderPrices & { models: Record<string, PriceEntry> }>;
  for (const p of ["openai", "google"] as const) {
    const t = others[p];
    providers[p] = t
      ? providerPrices(t, pricingCachePath(p))
      : { models: {}, bundled: { provider: p, source: "", fetchedAt: anthropic.asOf, models: {} }, cached: null, cacheError: null, asOf: anthropic.asOf };
  }
  const models = Object.assign({}, providers.google.models, providers.openai.models, anthropic.models);
  const asOf = PRICE_PROVIDERS.map((p) => providers[p].asOf).sort()[0]!;
  const cacheError = PRICE_PROVIDERS.map((p) => providers[p].cacheError).filter(Boolean).join("; ") || null;
  return { models, bundled, cached: anthropic.cached, cacheError, providers, asOf };
}

// Loaded once per process, on first use. A running session keeps the prices
// it started with; `pricing update` applies from the next session on.
let active: ActivePrices | null = null;

export function activePrices(): ActivePrices {
  return (active ??= loadActivePrices());
}

export function resetActivePrices(): void {
  active = null;
}

// ---------------------------------------------------------------------------
// Lookup and cost.

// Responses may carry a dated snapshot ID ("claude-opus-4-5-20251101",
// "gpt-5.5-2026-08-01") or a context-window tag ("claude-opus-5[1m]"); both
// price like the base model. Gateways put the provider in front
// ("openai/gpt-5", "models/gemini-2.5-pro"), and Copilot writes Claude's
// versions with a dot ("claude-sonnet-4.5").
export function normalizeModelId(model: string): string {
  let id = model
    .toLowerCase()
    .trim()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:models|anthropic|openai|google|google-ai-studio|vertex_ai)\//, "")
    .replace(/-\d{8}$/, "");
  if (id.startsWith("claude-")) id = id.replace(/(\d)\.(\d)/g, "$1-$2");
  return id;
}

export function priceFor(model: string | null): ModelPricing | null {
  if (!model) return null;
  const models = activePrices().models;
  const lower = model.toLowerCase();
  // The exact ID first: a dated snapshot may have a price of its own
  // (OpenAI lists gpt-4o-2024-05-13 apart from gpt-4o).
  return models[lower] ?? models[normalizeModelId(model)] ?? models[normalizeModelId(model).replace(/-\d{4}-\d{2}-\d{2}$/, "")] ?? null;
}

// The prices that apply to one request: the announced ones once their day
// has come, the long-context ones for a prompt above the limit.
export function pricesForRequest(price: ModelPricing, promptTokens: number, now = Date.now()): BasePrices {
  const current = price.next && now >= Date.parse(price.next.from) ? price.next : price;
  if (price.long && promptTokens > price.long.above) {
    // An announced change moves the long-context rates by the same factor.
    const f = current === price ? 1 : current.input / price.input;
    return {
      input: price.long.input * f,
      cache_write_5m: price.long.cache_write_5m * f,
      cache_write_1h: price.long.cache_write_1h * f,
      cache_read: price.long.cache_read * f,
      output: price.long.output * f,
    };
  }
  return current;
}

// Estimated USD for one request, or null when the model's price is unknown.
export function estimateCostUsd(usage: TokenUsage, now = Date.now()): number | null {
  const listed = priceFor(usage.model);
  if (!listed) return null;
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  const price = pricesForRequest(listed, prompt, now);
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

// One cost label for every view. The "~" marks it as an estimate.
// `unpriced` counts requests whose model had no known price; their cost is
// NOT in `knownUsd`, and the label says so.
export function formatCost(knownUsd: number, unpriced: number, requests: number): string {
  if (requests > 0 && unpriced >= requests) return "cost n/a (price unknown)";
  const base = `~$${knownUsd.toFixed(4)}`;
  if (unpriced > 0) return `${base} (${unpriced} request(s) unpriced)`;
  return base;
}

// ---------------------------------------------------------------------------
// Hints shown at session end — the moment a missing or old price matters.

export const STALE_AFTER_DAYS = 60;

export function pricingHints(unpricedModels: string[], prices = activePrices(), nowMs = Date.now()): string[] {
  const hints: string[] = [];
  // Families whose maker's list Vantage reads: a newer list may have them.
  const listed = (m: string): boolean => /^(?:claude-|gpt-|o\d|chatgpt-|codex-|gemini-)/.test(normalizeModelId(m));
  const known = unpricedModels.filter(listed);
  const other = unpricedModels.filter((m) => !listed(m));
  if (known.length) {
    hints.push(`no price for ${known.join(", ")} — \`vantage pricing update\` fetches the current official lists`);
  }
  if (other.length) {
    hints.push(`no price for ${other.join(", ")} (not on the Anthropic, OpenAI or Google price lists) — tokens are still metered`);
  }
  const ageDays = Math.floor((nowMs - Date.parse(prices.asOf)) / 86_400_000);
  if (ageDays >= STALE_AFTER_DAYS) {
    hints.push(`price list is ${ageDays} days old — \`vantage pricing update\` refreshes it`);
  }
  return hints;
}
