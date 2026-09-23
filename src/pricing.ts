// Per-model prices (USD per 1M tokens) for the cost estimate.
//
// Prices are data, not code. Nobody types them in by hand:
//
//   official page (Markdown form) ──► one parser (pricing-source.ts) ──┬─► src/pricing-snapshot.ts
//                                                                       │     generated, ships with Vantage
//                                                                       └─► ~/.vantage/pricing.json
//                                                                             written by `vantage pricing update`
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
import os from "node:os";
import path from "node:path";
import type { TokenUsage } from "./usage.ts";
import { SNAPSHOT } from "./pricing-snapshot.ts";

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

export interface PriceEntry extends ModelPricing {
  /** Name as printed on the official page, e.g. "Claude Opus 5.5". */
  name: string;
}

export interface PriceTable {
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
// assuming the exact multipliers, which are allowed to change.
export function plausiblePrice(p: ModelPricing): string | null {
  for (const f of PRICE_FIELDS) {
    if (typeof p[f] !== "number" || !Number.isFinite(p[f]) || p[f] <= 0) return `${f} is not a positive number`;
  }
  if (!(p.cache_read < p.input)) return "cache read is not cheaper than input";
  if (!(p.input < p.cache_write_5m && p.cache_write_5m < p.cache_write_1h)) return "cache writes are not above input (5m < 1h)";
  if (!(p.output > p.input)) return "output is not above input";
  return null;
}

export function validateTable(x: unknown): PriceTable {
  const t = x as Partial<PriceTable> | null;
  if (!t || typeof t !== "object") throw new Error("not an object");
  if (typeof t.source !== "string") throw new Error("missing source");
  if (typeof t.fetchedAt !== "string" || Number.isNaN(Date.parse(t.fetchedAt))) throw new Error("missing or invalid fetchedAt");
  if (!t.models || typeof t.models !== "object") throw new Error("missing models");
  const models: Record<string, PriceEntry> = {};
  for (const [id, entry] of Object.entries(t.models)) {
    const bad = plausiblePrice(entry);
    if (bad) throw new Error(`${id}: ${bad}`);
    models[id] = {
      name: typeof entry.name === "string" ? entry.name : id,
      input: entry.input,
      cache_write_5m: entry.cache_write_5m,
      cache_write_1h: entry.cache_write_1h,
      cache_read: entry.cache_read,
      output: entry.output,
    };
  }
  return { source: t.source, fetchedAt: t.fetchedAt, models };
}

// ---------------------------------------------------------------------------
// Active prices: bundled snapshot + the user's last `pricing update`.

// Per-user state (not per project: prices do not depend on the repo).
// VANTAGE_HOME relocates it — for tests, and for machines where the home
// directory is not writable.
export function vantageHome(): string {
  return process.env.VANTAGE_HOME || path.join(os.homedir(), ".vantage");
}

export function pricingCachePath(): string {
  return path.join(vantageHome(), "pricing.json");
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

export interface ActivePrices {
  models: Record<string, PriceEntry>;
  bundled: PriceTable;
  cached: PriceTable | null;
  cacheError: string | null;
  /** fetchedAt of the newest table in use. */
  asOf: string;
}

// Per model, the newer table wins. Models only one table lists are kept —
// a model that drops off the page (retired) still prices old sessions.
export function mergeTables(bundled: PriceTable, cached: PriceTable | null): Record<string, PriceEntry> {
  if (!cached) return { ...bundled.models };
  const cachedIsNewer = Date.parse(cached.fetchedAt) >= Date.parse(bundled.fetchedAt);
  return cachedIsNewer ? { ...bundled.models, ...cached.models } : { ...cached.models, ...bundled.models };
}

export function loadActivePrices(bundled: PriceTable = SNAPSHOT, file = pricingCachePath()): ActivePrices {
  const { table: cached, error } = readPricingCache(file);
  const asOf =
    cached && Date.parse(cached.fetchedAt) > Date.parse(bundled.fetchedAt) ? cached.fetchedAt : bundled.fetchedAt;
  return { models: mergeTables(bundled, cached), bundled, cached, cacheError: error, asOf };
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
  return activePrices().models[normalizeModelId(model)] ?? null;
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

// ---------------------------------------------------------------------------
// Hints shown at session end — the moment a missing or old price matters.

export const STALE_AFTER_DAYS = 60;

export function pricingHints(unpricedModels: string[], prices = activePrices(), nowMs = Date.now()): string[] {
  const hints: string[] = [];
  const claude = unpricedModels.filter((m) => m.startsWith("claude-"));
  const other = unpricedModels.filter((m) => !m.startsWith("claude-"));
  if (claude.length) {
    hints.push(`no price for ${claude.join(", ")} — \`vantage pricing update\` fetches the current official list`);
  }
  if (other.length) {
    hints.push(`no price for ${other.join(", ")} (not on Anthropic's price list) — tokens are still metered`);
  }
  const ageDays = Math.floor((nowMs - Date.parse(prices.asOf)) / 86_400_000);
  if (ageDays >= STALE_AFTER_DAYS) {
    hints.push(`price list is ${ageDays} days old — \`vantage pricing update\` refreshes it`);
  }
  return hints;
}
