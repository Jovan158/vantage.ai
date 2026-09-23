// `vantage pricing [update|check]`: the price list in use, and refreshing it
// from Anthropic's official page.

import {
  activePrices,
  resetActivePrices,
  writePricingCache,
  pricingCachePath,
  type PriceEntry,
} from "../pricing.ts";
import { fetchPriceTable, pricingSourceUrl, diffPrices, hasDrift, formatChange } from "../pricing-source.ts";
import { log } from "./output.ts";

// Human page for a source URL (the Markdown form is what gets fetched).
function pageUrl(source: string): string {
  return source.replace(/\.md$/, "");
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function priceRow(id: string, m: PriceEntry): string {
  const n = (v: number) => `$${v}`.padStart(8);
  return `  ${id.padEnd(20)}${n(m.input)}${n(m.cache_write_5m)}${n(m.cache_write_1h)}${n(m.cache_read)}${n(m.output)}\n`;
}

export async function cmdPricing(argv: string[]): Promise<number> {
  const sub = argv[0];
  switch (sub) {
    case "show":
    case undefined: {
      const p = activePrices();
      const updated = p.cached && p.cached.fetchedAt === p.asOf;
      log(
        `prices as of ${day(p.asOf)} · ` +
          (updated ? `from \`vantage pricing update\` (${pricingCachePath()})` : "bundled with vantage")
      );
      log(`source: ${pageUrl(updated ? p.cached!.source : p.bundled.source)}`);
      if (p.cacheError) log(`ignored an invalid price file — ${p.cacheError}`);
      process.stdout.write(`  ${"model".padEnd(20)}${"input".padStart(8)}${"5m wr".padStart(8)}${"1h wr".padStart(8)}${"read".padStart(8)}${"output".padStart(8)}   USD / MTok\n`);
      for (const [id, m] of Object.entries(p.models)) process.stdout.write(priceRow(id, m));
      log("vantage never fetches prices on its own — `vantage pricing update` gets the current list");
      return 0;
    }
    case "update": {
      const before = activePrices();
      log(`fetching ${pricingSourceUrl()}`);
      let fetched;
      try {
        fetched = await fetchPriceTable();
      } catch (err) {
        log(`update failed, prices unchanged — ${(err as Error).message}`);
        return 1;
      }
      for (const s of fetched.skipped) log(`skipped ${s}`);
      const { skipped: _skipped, ...table } = fetched;
      writePricingCache(table);
      resetActivePrices();
      const d = diffPrices(before.models, table.models);
      for (const id of d.added) log(`new: ${id}`);
      for (const c of d.changed) log(`changed: ${formatChange(c)}`);
      if (!hasDrift(d)) log("no price changes");
      log(`${Object.keys(table.models).length} models saved to ${pricingCachePath()} · applies from the next session`);
      return 0;
    }
    case "check": {
      // For CI: does the official list still match the bundled snapshot?
      const bundled = activePrices().bundled;
      let fetched;
      try {
        fetched = await fetchPriceTable();
      } catch (err) {
        log(`check failed — ${(err as Error).message}`);
        return 1;
      }
      for (const s of fetched.skipped) log(`skipped ${s}`);
      const d = diffPrices(bundled.models, fetched.models);
      for (const id of d.added) log(`new: ${id}`);
      for (const c of d.changed) log(`changed: ${formatChange(c)}`);
      for (const id of d.unlisted) log(`no longer listed: ${id}`);
      if (hasDrift(d)) {
        log("the bundled price list is out of date — run `npm run pricing:snapshot` and commit");
        return 1;
      }
      log(`bundled price list matches the official one (${Object.keys(fetched.models).length} models)`);
      return 0;
    }
    default:
      log(`unknown pricing command "${sub}" (show | update | check)`);
      return 1;
  }
}
