// Reads the official price list — the one place prices come from.
//
// Anthropic serves every docs page as Markdown too (the same URL plus ".md"),
// so the model table can be read as a table instead of scraped from HTML.
// Both the bundled snapshot (scripts/pricing-snapshot.ts) and
// `vantage pricing update` go through parsePricingMarkdown, so there is one
// parser and one set of checks.
//
// The parser is strict on purpose: columns are found by their header text,
// not position; every price must read "$X / MTok"; every row must pass
// plausiblePrice. A row that fails is skipped and reported; a table that
// yields too few models is rejected as a whole and nothing is written. A
// format change on the page therefore shows up as an error, never as wrong
// numbers in the meter.

import { upstreamTransport } from "./upstream.ts";
import { plausiblePrice, type ModelPricing, type PriceEntry, type PriceTable } from "./pricing.ts";

export const PRICING_SOURCE_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";

// Overridable for tests and for mirrors in networks without direct access.
export function pricingSourceUrl(): string {
  return process.env.VANTAGE_PRICING_URL || PRICING_SOURCE_URL;
}

export class PricingFormatError extends Error {}

export interface ParseResult {
  models: Record<string, PriceEntry>;
  /** Rows that were not taken, with the reason. */
  skipped: string[];
}

// A full table has ~20 models; far fewer means the page did not parse.
const MIN_MODELS = 3;

const COLUMNS = {
  model: /^model$/i,
  input: /base input/i,
  cache_write_5m: /5m cache write/i,
  cache_write_1h: /1h cache write/i,
  cache_read: /cache hit/i,
  output: /^output/i,
} as const;

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function stripMarkup(s: string): string {
  return s
    .replace(/<sup>.*?<\/sup>/gi, "")
    .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, "") // "([retired, ...](url))"
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // "[text](url)" -> "text"
    .replace(/\*\*?/g, "")
    .trim();
}

function parsePrice(cell: string): number | null {
  const m = /^\$(\d+(?:\.\d+)?)\s*\/\s*MTok$/i.exec(stripMarkup(cell));
  return m ? Number(m[1]) : null;
}

// "Claude Opus 5.5" -> "claude-opus-5-5". Before the 4 generation the
// version came first: "Claude Haiku 3.5" -> "claude-3-5-haiku". This matches
// the IDs listed on the models overview page.
export function modelIdFor(displayName: string): string | null {
  const m = /^Claude ([A-Za-z]+) (\d+(?:\.\d+)?)$/.exec(displayName);
  if (!m) return null;
  const family = m[1]!.toLowerCase();
  const version = m[2]!.replace(".", "-");
  return Number(m[2]!.split(".")[0]) < 4 ? `claude-${version}-${family}` : `claude-${family}-${version}`;
}

export function parsePricingMarkdown(md: string): ParseResult {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Model pricing\s*$/i.test(l));
  if (start < 0) throw new PricingFormatError('section "## Model pricing" not found — the page format changed');

  let i = start + 1;
  while (i < lines.length && !lines[i]!.trim().startsWith("|")) {
    if (/^##\s/.test(lines[i]!)) break;
    i++;
  }
  if (i >= lines.length || !lines[i]!.trim().startsWith("|")) {
    throw new PricingFormatError("no table under \"Model pricing\" — the page format changed");
  }

  const header = cells(lines[i]!);
  const col = {} as Record<keyof typeof COLUMNS, number>;
  for (const [key, re] of Object.entries(COLUMNS) as Array<[keyof typeof COLUMNS, RegExp]>) {
    const idx = header.findIndex((h) => re.test(h));
    if (idx < 0) throw new PricingFormatError(`column for "${key}" not found in the price table — the page format changed`);
    col[key] = idx;
  }
  i += 2; // header + separator row

  const models: Record<string, PriceEntry> = {};
  const skipped: string[] = [];
  for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
    const row = cells(lines[i]!);
    const name = stripMarkup(row[col.model] ?? "").replace(/\s*\(.*\)\s*$/, "");
    const id = modelIdFor(name);
    if (!id) {
      skipped.push(`"${name}": not a recognizable model name`);
      continue;
    }
    if (models[id]) {
      skipped.push(`"${name}": listed twice, first row kept`);
      continue;
    }
    const price = {} as ModelPricing;
    let missing: string | null = null;
    for (const f of ["input", "cache_write_5m", "cache_write_1h", "cache_read", "output"] as const) {
      const v = parsePrice(row[col[f]] ?? "");
      if (v === null) {
        missing = `${f} "${row[col[f]] ?? ""}" is not "$X / MTok"`;
        break;
      }
      price[f] = v;
    }
    const bad = missing ?? plausiblePrice(price);
    if (bad) {
      skipped.push(`"${name}": ${bad}`);
      continue;
    }
    models[id] = { name, ...price };
  }

  if (Object.keys(models).length < MIN_MODELS) {
    const why = skipped.length ? `; skipped: ${skipped.join("; ")}` : "";
    throw new PricingFormatError(
      `only ${Object.keys(models).length} model(s) read from the price table${why} — the page format changed`
    );
  }
  return { models, skipped };
}

// ---------------------------------------------------------------------------
// Fetch: plain GET through the same proxy-aware transport the meter uses.

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  redirects?: number;
}

export function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { timeoutMs = 15_000, maxBytes = 2_000_000, redirects = 3 } = opts;
  return new Promise((resolve, reject) => {
    const { client, agent } = upstreamTransport(url);
    const req = client.get(
      url,
      { agent, headers: { accept: "text/markdown, text/plain;q=0.9", "user-agent": "vantage (pricing update)" } },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirects <= 0) return reject(new Error(`too many redirects fetching ${url}`));
          const next = new URL(location, url).href;
          return void fetchText(next, { timeoutMs, maxBytes, redirects: redirects - 1 }).then(resolve, reject);
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`${url} answered ${status}`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new Error(`${url} is larger than ${maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer from ${url} within ${timeoutMs / 1000}s`)));
    req.on("error", reject);
  });
}

export interface FetchedTable extends PriceTable {
  skipped: string[];
}

export async function fetchPriceTable(url = pricingSourceUrl(), now = new Date()): Promise<FetchedTable> {
  const md = await fetchText(url);
  const { models, skipped } = parsePricingMarkdown(md);
  return { source: url, fetchedAt: now.toISOString(), models, skipped };
}

// ---------------------------------------------------------------------------
// Diff, for `pricing update` / `pricing check` output.

export interface PriceChange {
  id: string;
  before: ModelPricing;
  after: ModelPricing;
}

export interface PriceDiff {
  added: string[];
  changed: PriceChange[];
  /** In `before` but no longer listed. Kept when merging (see mergeTables). */
  unlisted: string[];
}

const FIELDS = ["input", "cache_write_5m", "cache_write_1h", "cache_read", "output"] as const;

export function diffPrices(before: Record<string, ModelPricing>, after: Record<string, ModelPricing>): PriceDiff {
  const added: string[] = [];
  const changed: PriceChange[] = [];
  for (const [id, a] of Object.entries(after)) {
    const b = before[id];
    if (!b) added.push(id);
    else if (FIELDS.some((f) => b[f] !== a[f])) changed.push({ id, before: b, after: a });
  }
  const unlisted = Object.keys(before).filter((id) => !(id in after));
  return { added, changed, unlisted };
}

export function hasDrift(d: PriceDiff): boolean {
  return d.added.length > 0 || d.changed.length > 0;
}

// Price changes too large to take over without a person looking: a price
// that moved by more than `maxFactor` either way is far more likely a
// misread page than a real price change.
// Returns one line per suspicious price, empty when all is plausible.
export function implausibleChanges(d: PriceDiff, maxFactor = 10): string[] {
  const out: string[] = [];
  for (const c of d.changed) {
    for (const f of FIELDS) {
      const ratio = c.after[f] / c.before[f];
      if (ratio > maxFactor || ratio < 1 / maxFactor) out.push(`${c.id}: ${f} $${c.before[f]} → $${c.after[f]}`);
    }
  }
  return out;
}

// The bundled list after an update: the fetched prices, plus every model
// the page no longer lists — a retired model still prices old sessions.
export function nextSnapshot(current: PriceTable, fetched: PriceTable): PriceTable {
  return { ...fetched, models: { ...current.models, ...fetched.models } };
}

export function formatChange(c: PriceChange): string {
  const parts = FIELDS.filter((f) => c.before[f] !== c.after[f]).map((f) => `${f} $${c.before[f]} → $${c.after[f]}`);
  return `${c.id}: ${parts.join(", ")}`;
}
