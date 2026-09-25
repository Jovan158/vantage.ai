// Reads the official price lists — the one place prices come from.
//
// Anthropic, OpenAI and Google serve their pricing pages as Markdown too
// (Anthropic and OpenAI: the URL plus ".md"; Google: plus ".md.txt"), so the
// model tables can be read as tables instead of scraped from HTML. Both the
// bundled snapshot (scripts/pricing-snapshot.ts) and `vantage pricing update`
// go through the same parser per provider, so there is one set of checks.
//
// The parser is strict on purpose: columns are found by their header text,
// not position; every price must read "$X / MTok"; every row must pass
// plausiblePrice. A row that fails is skipped and reported; a table that
// yields too few models is rejected as a whole and nothing is written. A
// format change on the page therefore shows up as an error, never as wrong
// numbers in the meter.

import { upstreamTransport } from "./upstream.ts";
import { plausibleEntry, plausiblePrice, type BasePrices, type ModelPricing, type PriceEntry, type PriceProvider, type PriceTable } from "./pricing.ts";

export const PRICING_SOURCE_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";
export const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
export const GOOGLE_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing.md.txt";

const DEFAULT_URLS: Record<PriceProvider, string> = {
  anthropic: PRICING_SOURCE_URL,
  openai: OPENAI_PRICING_URL,
  google: GOOGLE_PRICING_URL,
};

// Overridable for tests and for mirrors in networks without direct access:
// VANTAGE_PRICING_URL (Anthropic), VANTAGE_PRICING_URL_OPENAI,
// VANTAGE_PRICING_URL_GOOGLE.
export function pricingSourceUrl(provider: PriceProvider = "anthropic"): string {
  const variable = provider === "anthropic" ? "VANTAGE_PRICING_URL" : `VANTAGE_PRICING_URL_${provider.toUpperCase()}`;
  return process.env[variable] || DEFAULT_URLS[provider];
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

// Any provider's page, read by its own parser. `at` decides which of
// Google's dated prices are current.
export function parseProviderPage(provider: PriceProvider, md: string, at = new Date()): ParseResult {
  if (provider === "openai") return parseOpenAiPricing(md);
  if (provider === "google") return parseGooglePricing(md, at);
  return parsePricingMarkdown(md);
}

export async function fetchProviderTable(provider: PriceProvider, now = new Date(), url = pricingSourceUrl(provider)): Promise<FetchedTable> {
  const md = await fetchText(url);
  const { models, skipped } = parseProviderPage(provider, md, now);
  return { provider, source: url, fetchedAt: now.toISOString(), models, skipped };
}

// ---------------------------------------------------------------------------
// OpenAI: one table per processing tier (Standard, Batch, Flex, Fast mode)
// and model group. Only Standard prices are read; the columns are named, in
// the flagship tables, "Short context input", "… cached input", "… cache
// writes", "… output" and the same for "Long context". A model whose long
// context starts at a size says so in its name: "gpt-5.5 (<272K context
// length)". Tables of other kinds (audio, images, fine-tuning, tools) have
// other columns and are passed over.

const OPENAI_MIN_MODELS = 10;
const TIERS = new Set(["Standard", "Batch", "Flex", "Fast mode", "Fast", "Priority"]);

function dollars(cell: string): number | null {
  const m = /^\$(\d+(?:\.\d+)?)$/.exec(stripMarkup(cell).replace(/,/g, ""));
  return m ? Number(m[1]) : null;
}

export function parseOpenAiPricing(md: string): ParseResult {
  const lines = md.split(/\r?\n/);
  const models: Record<string, PriceEntry> = {};
  const skipped: string[] = [];
  let tier = "Standard";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (TIERS.has(line)) tier = line;
    // Each model group starts with its unit; its first table is Standard.
    if (/^Prices per 1M tokens\.?$/i.test(line)) tier = "Standard";
    if (!line.startsWith("|") || !lines[i + 1]?.trim().startsWith("| ---")) continue;
    const header = cells(line).map((h) => h.toLowerCase());
    const find = (re: RegExp): number => header.findIndex((h) => re.test(h));
    const col = {
      model: find(/^model$/),
      input: find(/^(?:short context )?input$/),
      cached: find(/^(?:short context )?cached input$/),
      writes: find(/^(?:short context )?cache writes$/),
      output: find(/^(?:short context )?output$/),
      longInput: find(/^long context input$/),
      longCached: find(/^long context cached input$/),
      longWrites: find(/^long context cache writes$/),
      longOutput: find(/^long context output$/),
    };
    let j = i + 2;
    const rows: string[][] = [];
    for (; j < lines.length && lines[j]!.trim().startsWith("|"); j++) rows.push(cells(lines[j]!));
    i = j - 1;
    // Only token prices by model: no modality or training splits.
    if (tier !== "Standard" || col.model < 0 || col.input < 0 || col.output < 0 || header.some((h) => /modality|training|per minute/.test(h))) continue;
    for (const row of rows) {
      const raw = stripMarkup(row[col.model] ?? "");
      const id = raw.replace(/\s*\(.*\)\s*$/, "").trim();
      if (!/^[a-z0-9][a-z0-9.\-]*$/i.test(id)) continue;
      if (models[id]) continue; // the flagship table comes first
      const input = dollars(row[col.input] ?? "");
      const output = dollars(row[col.output] ?? "");
      if (input === null || output === null) {
        skipped.push(`"${raw}": no input and output price`);
        continue;
      }
      const cached = col.cached >= 0 ? dollars(row[col.cached] ?? "") : null;
      const writes = col.writes >= 0 ? dollars(row[col.writes] ?? "") : null;
      const price: ModelPricing = { input, cache_write_5m: writes ?? input, cache_write_1h: writes ?? input, cache_read: cached ?? input, output };
      // Long-context prices count only where the page names the limit.
      const limit = /<\s*(\d+(?:\.\d+)?)\s*K context length/i.exec(raw);
      const longInput = col.longInput >= 0 ? dollars(row[col.longInput] ?? "") : null;
      const longOutput = col.longOutput >= 0 ? dollars(row[col.longOutput] ?? "") : null;
      if (limit && longInput !== null && longOutput !== null) {
        const lc = col.longCached >= 0 ? dollars(row[col.longCached] ?? "") : null;
        const lw = col.longWrites >= 0 ? dollars(row[col.longWrites] ?? "") : null;
        price.long = { above: Number(limit[1]) * 1000, input: longInput, cache_write_5m: lw ?? longInput, cache_write_1h: lw ?? longInput, cache_read: lc ?? longInput, output: longOutput };
      }
      const bad = plausibleEntry(price, false);
      if (bad) {
        skipped.push(`"${raw}": ${bad}`);
        continue;
      }
      models[id] = { name: id, ...price };
    }
  }
  if (Object.keys(models).length < OPENAI_MIN_MODELS) {
    throw new PricingFormatError(`only ${Object.keys(models).length} model(s) read from OpenAI's price tables — the page format changed`);
  }
  return { models, skipped };
}

// ---------------------------------------------------------------------------
// Google: one section per model ("## Gemini 2.5 Pro", with its IDs as
// links: [`gemini-2.5-pro`](…)), and in it a table per tier; "### Standard" is
// read, its "Paid Tier" column. Only models billed for text output ("Output
// price (including thinking tokens)") — the ones coding agents call. A cell
// can hold more than one price:
//
//   $1.25, prompts <= 200k tokens $2.50, prompts > 200k tokens   (long context)
//   $0.75 through December 31, 2026. $1.50 starting January 1, 2027.   (announced)
//   $0.30 (text / image / video) $1.00 (audio)   (by modality: text is read)
//   … $1.00 / 1,000,000 tokens per hour (storage price)   (not per token: left out)

const GOOGLE_MIN_MODELS = 3;

interface CellPrices {
  now: number;
  long?: { above: number; value: number };
  next?: { from: string; value: number };
}

function unescape(s: string): string {
  return s.replace(/\\([<>*_\[\]()])/g, "$1").replace(/\^\\?\*+\^/g, "").replace(/\^[^^]*\^/g, "");
}

// The prices in one Google cell, as they apply at `at`.
export function parseGoogleCell(cell: string, at = new Date()): CellPrices | null {
  const text = unescape(stripMarkup(cell));
  const parts: Array<{ value: number; rest: string }> = [];
  const re = /\$(\d+(?:\.\d+)?)/g;
  const found = [...text.matchAll(re)];
  found.forEach((m, k) => {
    const end = k + 1 < found.length ? found[k + 1]!.index! : text.length;
    parts.push({ value: Number(m[1]), rest: text.slice(m.index! + m[0].length, end) });
  });
  // Only per-token text prices.
  const priced = parts.filter(
    (p) => !/storage|per hour|\/\s*min|per (?:image|second|minute|request)|1,000 requests/i.test(p.rest) && (!/\((?![^)]*text)[^)]*\)/i.test(p.rest) || /\(\s*(?:text|input caching)/i.test(p.rest))
  );
  if (priced.length === 0) return null;
  const low = priced.find((p) => /prompts\s*<=\s*\d+k/i.test(p.rest));
  const high = priced.find((p) => /prompts\s*>\s*\d+k/i.test(p.rest));
  const through = priced.find((p) => /through\s+[A-Z][a-z]+ \d{1,2}, \d{4}/.test(p.rest));
  const starting = priced.find((p) => /starting\s+[A-Z][a-z]+ \d{1,2}, \d{4}/.test(p.rest));
  if (low && high) {
    const k = Number(/prompts\s*<=\s*(\d+)k/i.exec(low.rest)![1]);
    return { now: low.value, long: { above: k * 1000, value: high.value } };
  }
  if (through && starting) {
    const end = Date.parse(/through\s+([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(through.rest)![1]!);
    const from = Date.parse(/starting\s+([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(starting.rest)![1]!);
    if (Number.isNaN(end) || Number.isNaN(from)) return null;
    // Dates are the provider's calendar days: the new price applies from
    // the start of that day (UTC).
    if (at.getTime() >= from) return { now: starting.value };
    return { now: through.value, next: { from: new Date(from).toISOString().slice(0, 10), value: starting.value } };
  }
  return { now: priced[0]!.value };
}

export function parseGooglePricing(md: string, at = new Date()): ParseResult {
  const models: Record<string, PriceEntry> = {};
  const skipped: string[] = [];
  const sections = md.split(/\n## /).slice(1);
  for (const section of sections) {
    const title = section.split("\n")[0]!.trim();
    const head = section.split(/\n### /)[0]!;
    const ids = [...head.matchAll(/\[`([a-z0-9.\-]+)`\]\(/g)].map((m) => m[1]!);
    if (ids.length === 0) continue;
    const std = /\n### Standard\n([\s\S]*?)(?=\n### |$)/.exec(section);
    if (!std) continue;
    const lines = std[1]!.split("\n").filter((l) => l.trim().startsWith("|"));
    if (lines.length < 3) continue;
    const header = cells(lines[0]!);
    const paid = header.findIndex((h) => /paid tier/i.test(h));
    if (paid < 0) continue;
    const row = (re: RegExp): string | null => {
      const r = lines.map(cells).find((c) => re.test(unescape(stripMarkup(c[0] ?? ""))));
      return r ? r[paid] ?? null : null;
    };
    const outputCell = row(/^Output price \(including thinking/i);
    if (!outputCell) continue; // not a text model
    const inputCell = row(/^Input price/i);
    const cacheCell = row(/^Context caching price/i);
    const input = inputCell ? parseGoogleCell(inputCell, at) : null;
    const output = parseGoogleCell(outputCell, at);
    const cache = cacheCell ? parseGoogleCell(cacheCell, at) : null;
    if (!input || !output) {
      skipped.push(`"${title}": prices not readable`);
      continue;
    }
    const base = (i: number, o: number, c: number): BasePrices => ({ input: i, cache_write_5m: i, cache_write_1h: i, cache_read: c, output: o });
    const price: ModelPricing = base(input.now, output.now, cache?.now ?? input.now);
    if (input.long && output.long) {
      price.long = { above: input.long.above, ...base(input.long.value, output.long.value, cache?.long?.value ?? input.long.value) };
    }
    if (input.next || output.next) {
      const from = (input.next ?? output.next)!.from;
      price.next = { from, ...base(input.next?.value ?? input.now, output.next?.value ?? output.now, cache?.next?.value ?? cache?.now ?? input.next?.value ?? input.now) };
    }
    const bad = plausibleEntry(price, false);
    if (bad) {
      skipped.push(`"${title}": ${bad}`);
      continue;
    }
    for (const id of ids) if (!models[id]) models[id] = { name: title, ...price };
  }
  if (Object.keys(models).length < GOOGLE_MIN_MODELS) {
    throw new PricingFormatError(`only ${Object.keys(models).length} model(s) read from Google's price page — the page format changed`);
  }
  return { models, skipped };
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

const extras = (p: ModelPricing): string => JSON.stringify([p.long ?? null, p.next ?? null]);

export function diffPrices(before: Record<string, ModelPricing>, after: Record<string, ModelPricing>): PriceDiff {
  const added: string[] = [];
  const changed: PriceChange[] = [];
  for (const [id, a] of Object.entries(after)) {
    const b = before[id];
    if (!b) added.push(id);
    else if (FIELDS.some((f) => b[f] !== a[f]) || extras(b) !== extras(a)) changed.push({ id, before: b, after: a });
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
  if (extras(c.before) !== extras(c.after)) parts.push("long-context or announced prices");
  return `${c.id}: ${parts.join(", ")}`;
}
