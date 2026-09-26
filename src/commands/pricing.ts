// `vantage pricing [show|update|check] [provider]`: the price lists in use,
// and refreshing them from Anthropic's, OpenAI's and Google's official pages.

import {
  activePrices,
  resetActivePrices,
  writePricingCache,
  pricingCachePath,
  PRICE_PROVIDERS,
  type BasePrices,
  type PriceEntry,
  type PriceProvider,
} from "../pricing.ts";
import { fetchProviderTable, pricingSourceUrl, diffPrices, hasDrift, formatChange } from "../pricing-source.ts";
import { log } from "./output.ts";

const PROVIDER_NAMES: Record<PriceProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" };

// Human page for a source URL (the Markdown form is what gets fetched).
function pageUrl(source: string): string {
  return source.replace(/\.md(?:\.txt)?$/, "");
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function priceRow(id: string, m: BasePrices, width: number, note = ""): string {
  const n = (v: number) => `$${v}`.padStart(8);
  return `  ${id.padEnd(width)}${n(m.input)}${n(m.cache_write_5m)}${n(m.cache_write_1h)}${n(m.cache_read)}${n(m.output)}${note}\n`;
}

function showProvider(provider: PriceProvider, models: Record<string, PriceEntry>): void {
  const p = activePrices().providers[provider];
  const updated = p.cached && p.cached.fetchedAt === p.asOf;
  log(
    `${PROVIDER_NAMES[provider]} · prices as of ${day(p.asOf)} · ` +
      (updated ? `from \`vantage pricing update\` (${pricingCachePath(provider)})` : "bundled with vantage")
  );
  log(`source: ${pageUrl(updated ? p.cached!.source : p.bundled.source)}`);
  const ids = Object.keys(models);
  const width = Math.max(20, ...ids.map((id) => id.length + 2));
  process.stdout.write(`  ${"model".padEnd(width)}${"input".padStart(8)}${"5m wr".padStart(8)}${"1h wr".padStart(8)}${"read".padStart(8)}${"output".padStart(8)}   USD / MTok\n`);
  for (const id of ids) {
    const m = models[id]!;
    process.stdout.write(priceRow(id, m, width));
    if (m.long) process.stdout.write(priceRow(`  above ${m.long.above / 1000}K`, m.long, width, "   prompt above the limit"));
    if (m.next) process.stdout.write(priceRow(`  from ${m.next.from}`, m.next, width, "   announced"));
  }
}

function isProvider(x: string): x is PriceProvider {
  return (PRICE_PROVIDERS as string[]).includes(x);
}

export async function cmdPricing(argv: string[]): Promise<number> {
  // `vantage pricing openai` is short for `vantage pricing show openai`.
  const args = argv[0] === undefined || isProvider(argv[0]) ? ["show", ...argv] : argv;
  const [sub, which] = args as [string, string | undefined];
  if (!["show", "update", "check"].includes(sub)) {
    log(`unknown pricing command "${sub}" (show | update | check)`);
    return 1;
  }
  if (which !== undefined && !isProvider(which)) {
    log(`unknown provider "${which}" (${PRICE_PROVIDERS.join(" | ")})`);
    return 1;
  }
  const providers = which ? [which] : PRICE_PROVIDERS;
  switch (sub) {
    case "show": {
      const p = activePrices();
      if (p.cacheError) log(`ignored an invalid price file — ${p.cacheError}`);
      for (const provider of providers) {
        const models: Record<string, PriceEntry> = {};
        const own = p.providers[provider];
        const ids = new Set([...Object.keys(own.bundled.models), ...Object.keys(own.cached?.models ?? {})]);
        for (const id of ids) if (p.models[id]) models[id] = p.models[id]!;
        showProvider(provider, models);
      }
      log("vantage never fetches prices on its own — `vantage pricing update` gets the current lists");
      return 0;
    }
    case "update": {
      let failed = 0;
      for (const provider of providers) {
        const before = activePrices().providers[provider];
        const name = PROVIDER_NAMES[provider];
        log(`fetching ${pricingSourceUrl(provider)}`);
        let fetched;
        try {
          fetched = await fetchProviderTable(provider);
        } catch (err) {
          log(`${name}: update failed, prices unchanged — ${(err as Error).message}`);
          failed++;
          continue;
        }
        for (const s of fetched.skipped) log(`${name}: skipped ${s}`);
        const { skipped: _skipped, ...table } = fetched;
        writePricingCache(table, pricingCachePath(provider));
        const beforeModels = { ...before.bundled.models, ...(before.cached?.models ?? {}) };
        const d = diffPrices(beforeModels, table.models);
        for (const id of d.added) log(`${name}: new: ${id}`);
        for (const c of d.changed) log(`${name}: changed: ${formatChange(c)}`);
        if (!hasDrift(d)) log(`${name}: no price changes`);
        log(`${name}: ${Object.keys(table.models).length} models saved to ${pricingCachePath(provider)}`);
      }
      resetActivePrices();
      if (failed < providers.length) log("new prices apply from the next session");
      return failed ? 1 : 0;
    }
    case "check": {
      // For CI: do the official lists still match the bundled snapshot?
      let stale = false;
      let failed = false;
      for (const provider of providers) {
        const name = PROVIDER_NAMES[provider];
        const bundled = activePrices().providers[provider].bundled;
        let fetched;
        try {
          fetched = await fetchProviderTable(provider);
        } catch (err) {
          log(`${name}: check failed — ${(err as Error).message}`);
          failed = true;
          continue;
        }
        for (const s of fetched.skipped) log(`${name}: skipped ${s}`);
        const d = diffPrices(bundled.models, fetched.models);
        for (const id of d.added) log(`${name}: new: ${id}`);
        for (const c of d.changed) log(`${name}: changed: ${formatChange(c)}`);
        for (const id of d.unlisted) log(`${name}: no longer listed: ${id}`);
        if (hasDrift(d)) stale = true;
        else log(`${name}: bundled price list matches the official one (${Object.keys(fetched.models).length} models)`);
      }
      if (stale) log("the bundled price list is out of date — run `npm run pricing:snapshot` and commit");
      return stale || failed ? 1 : 0;
    }
  }
  return 1;
}
