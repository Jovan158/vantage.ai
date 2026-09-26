// The price list pipeline: parse the official Markdown table, reject anything
// that does not read cleanly, merge with the bundled snapshot, and the
// `vantage pricing update` command end to end against a local server.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parsePricingMarkdown,
  modelIdFor,
  PricingFormatError,
  fetchText,
  diffPrices,
  hasDrift,
  implausibleChanges,
  nextSnapshot,
  parseOpenAiPricing,
  parseGooglePricing,
  parseGoogleCell,
} from "../src/pricing-source.ts";
import { mergeTables, loadActivePrices, validateTable, pricingHints, type PriceTable } from "../src/pricing.ts";
import { SNAPSHOT, SNAPSHOTS } from "../src/pricing-snapshot.ts";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

// Same shape as the real page: link parentheticals in model names, <sup>
// footnotes in prices, and a second table (batch) that must not be read.
const HEADER =
  "| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |\n" +
  "| :---- | :---------------- | :-------------- | :-------------- | :----------------------- | :------------ |\n";
const PAGE = `---
title: Pricing
---

## Model pricing

The following table shows pricing for all Claude models:

${HEADER}| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Mythos 5.1 ([limited availability](https://anthropic.com/glasswing)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Haiku 3.5 ([retired, except on Bedrock and Google Cloud](https://example.com/deprecations)) | $0.80 / MTok | $1 / MTok | $1.60 / MTok | $0.08 / MTok | $4 / MTok |

<sup>1</sup> footnote

## Feature-specific pricing

### Batch processing

| Model | Batch input | Batch output |
| :---- | :---------- | :----------- |
| Claude Opus 5.5 | $2 / MTok | $10 / MTok |
`;

test("reads every model row with its five prices", () => {
  const { models, skipped } = parsePricingMarkdown(PAGE);
  assert.deepEqual(Object.keys(models), ["claude-opus-5-5", "claude-mythos-5-1", "claude-sonnet-5", "claude-3-5-haiku"]);
  assert.deepEqual(models["claude-opus-5-5"], {
    name: "Claude Opus 5.5",
    input: 4,
    cache_write_5m: 5,
    cache_write_1h: 8,
    cache_read: 0.2,
    output: 20,
  });
  assert.equal(models["claude-mythos-5-1"]!.name, "Claude Mythos 5.1");
  assert.equal(models["claude-3-5-haiku"]!.cache_read, 0.08);
  assert.deepEqual(skipped, []);
});

test("display names map to API model IDs", () => {
  assert.equal(modelIdFor("Claude Opus 5.5"), "claude-opus-5-5");
  assert.equal(modelIdFor("Claude Sonnet 5"), "claude-sonnet-5");
  assert.equal(modelIdFor("Claude Fable 5.1"), "claude-fable-5-1");
  assert.equal(modelIdFor("Claude Haiku 4.5"), "claude-haiku-4-5");
  assert.equal(modelIdFor("Claude Haiku 3.5"), "claude-3-5-haiku"); // pre-4 naming
  assert.equal(modelIdFor("Some other row"), null);
});

test("columns are found by header text, not position", () => {
  const swapped = PAGE.replace(HEADER, HEADER.replace("Base input tokens", "OUT").replace("Output tokens", "Base input tokens").replace("OUT", "Output tokens"));
  // With the headers swapped, input and output trade places: every row now
  // fails the plausibility check instead of silently pricing output as input.
  assert.throws(() => parsePricingMarkdown(swapped), PricingFormatError);
});

test("a bad row is skipped and reported, the rest is kept", () => {
  const page = PAGE.replace("| Claude Sonnet 5 | $2 / MTok |", "| Claude Sonnet 5 | Contact sales |");
  const { models, skipped } = parsePricingMarkdown(page);
  assert.equal(models["claude-sonnet-5"], undefined);
  assert.equal(Object.keys(models).length, 3);
  assert.match(skipped[0]!, /Claude Sonnet 5.*input/);
});

test("a changed page format is an error, never a partial table", () => {
  assert.throws(() => parsePricingMarkdown("# Pricing\n\nnothing here"), /Model pricing" not found/);
  assert.throws(() => parsePricingMarkdown(PAGE.replace("5m cache writes", "Short-lived writes")), /cache_write_5m/);
  const onlyOne = PAGE.split("\n").filter((l) => !/Mythos|Sonnet|Haiku/.test(l)).join("\n");
  assert.throws(() => parsePricingMarkdown(onlyOne), /only 1 model/);
});

test("the bundled snapshots pass the same checks as a fetched table", () => {
  for (const t of Object.values(SNAPSHOTS)) assert.doesNotThrow(() => validateTable(t), t.provider);
  assert.ok(Object.keys(SNAPSHOT.models).length >= 10);
  assert.ok(SNAPSHOT.models["claude-opus-5-5"], "current models are listed");
  assert.ok(SNAPSHOTS.openai.models["gpt-5.5"], "Codex's default model");
  assert.ok(SNAPSHOTS.google.models["gemini-2.5-pro"]);
  const ids = Object.values(SNAPSHOTS).flatMap((t) => Object.keys(t.models));
  assert.equal(new Set(ids).size, ids.length, "no model ID in two lists");
});

const table = (fetchedAt: string, models: PriceTable["models"]): PriceTable => ({ source: "test", fetchedAt, models });
const entry = (input: number) => ({ name: "x", input, cache_write_5m: input * 1.25, cache_write_1h: input * 2, cache_read: input / 10, output: input * 5 });

test("merge: per model, the newer table wins; models only one lists are kept", () => {
  const bundled = table("2026-09-01T00:00:00Z", { a: entry(1), b: entry(2) });
  const newer = table("2026-10-01T00:00:00Z", { b: entry(3), c: entry(4) });
  const older = table("2026-08-01T00:00:00Z", { b: entry(3), c: entry(4) });

  const m1 = mergeTables(bundled, newer);
  assert.deepEqual([m1.a!.input, m1.b!.input, m1.c!.input], [1, 3, 4]);

  // A newer release beats an old `pricing update`, but keeps what only the
  // update knows.
  const m2 = mergeTables(bundled, older);
  assert.deepEqual([m2.a!.input, m2.b!.input, m2.c!.input], [1, 2, 4]);
});

test("an invalid price file is ignored with a reason; the bundled list is used", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-pricing-"));
  const file = path.join(dir, "pricing.json");
  fs.writeFileSync(file, JSON.stringify({ source: "x", fetchedAt: "2099-01-01T00:00:00Z", models: { m: { input: 5, output: 1 } } }));
  const p = loadActivePrices(SNAPSHOT, file, {});
  assert.equal(p.cached, null);
  assert.match(p.cacheError ?? "", /m: /);
  assert.deepEqual(p.models, SNAPSHOT.models, "the bundled list, unchanged");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hints: update for unknown models of listed makers, a plain note for others, age", () => {
  const p = loadActivePrices(table("2026-09-01T00:00:00Z", { a: entry(1) }), "/nonexistent/pricing.json", {});
  const now = Date.parse("2026-09-10T00:00:00Z");
  assert.deepEqual(pricingHints([], p, now), []);
  const hints = pricingHints(["claude-opus-9", "gpt-7", "gemini-9-pro", "some-gateway-model"], p, now);
  assert.match(hints[0]!, /claude-opus-9, gpt-7, gemini-9-pro .*vantage pricing update/);
  assert.match(hints[1]!, /some-gateway-model.*not on the Anthropic, OpenAI or Google price lists/);
  assert.match(pricingHints([], p, Date.parse("2026-12-01T00:00:00Z"))[0]!, /91 days old/);
});

test("diff reports new and changed models as drift", () => {
  const d = diffPrices({ a: entry(1), b: entry(2) }, { a: entry(1), b: entry(3), c: entry(4) });
  assert.deepEqual(d.added, ["c"]);
  assert.deepEqual(d.changed.map((c) => c.id), ["b"]);
  assert.ok(hasDrift(d));
  assert.ok(!hasDrift(diffPrices({ a: entry(1) }, { a: entry(1) })));
});

// ---------------------------------------------------------------------------
// Fetch and CLI against a local server.

async function serve(routes: Record<string, (res: http.ServerResponse) => void>) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url ?? ""];
    if (route) route(res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function vantage(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, ...args], {
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (out += c));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

test("fetchText follows redirects and reports HTTP errors", async () => {
  const s = await serve({
    "/old": (res) => res.writeHead(307, { location: "/pricing.md" }).end(),
    "/pricing.md": (res) => res.writeHead(200, { "content-type": "text/markdown" }).end(PAGE),
  });
  assert.equal(await fetchText(`${s.base}/old`), PAGE);
  await assert.rejects(fetchText(`${s.base}/missing`), /answered 404/);
  await s.close();
});

test("`vantage pricing update` saves the official list; a broken page changes nothing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-home-"));
  const newModel = PAGE.replace("| Claude Sonnet 5 |", "| Claude Sonnet 6 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |\n| Claude Sonnet 5 |");
  const s = await serve({
    "/pricing.md": (res) => res.writeHead(200).end(newModel),
    "/broken.md": (res) => res.writeHead(200).end("<html>maintenance</html>"),
  });

  const ok = await vantage(["pricing", "update", "anthropic"], { VANTAGE_HOME: home, VANTAGE_PRICING_URL: `${s.base}/pricing.md` });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /new: claude-sonnet-6/);
  const saved = JSON.parse(fs.readFileSync(path.join(home, "pricing.json"), "utf8")) as PriceTable;
  assert.equal(saved.models["claude-sonnet-6"]!.output, 10);

  const shown = await vantage(["pricing"], { VANTAGE_HOME: home });
  assert.match(shown.out, /from `vantage pricing update`/);
  assert.match(shown.out, /claude-sonnet-6/);
  assert.match(shown.out, /claude-fable-5-1/); // bundled models stay priced

  const broken = await vantage(["pricing", "update", "anthropic"], { VANTAGE_HOME: home, VANTAGE_PRICING_URL: `${s.base}/broken.md` });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /update failed, prices unchanged/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "pricing.json"), "utf8")), saved);

  await s.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("automatic updates: a price that moved more than 10x is held for a person", () => {
  const before = { a: entry(1), b: entry(2) };
  assert.deepEqual(implausibleChanges(diffPrices(before, { a: entry(3), b: entry(0.5) })), [], "3x up, 4x down: plausible");
  const wild = implausibleChanges(diffPrices(before, { a: entry(15), b: entry(2) }));
  assert.equal(wild.length, 5, "every field of a");
  assert.match(wild[0]!, /^a: input \$1 → \$15$/);
  assert.equal(implausibleChanges(diffPrices(before, { a: { ...entry(1), output: 0.4 }, b: entry(2) })).length, 1, "a 12.5x drop");
});

test("automatic updates keep models the page no longer lists", () => {
  const current = table("2026-09-01T00:00:00Z", { old: entry(1), a: entry(2) });
  const fetched = table("2026-09-20T00:00:00Z", { a: entry(3), fresh: entry(4) });
  const next = nextSnapshot(current, fetched);
  assert.equal(next.fetchedAt, "2026-09-20T00:00:00Z");
  assert.deepEqual(Object.keys(next.models).sort(), ["a", "fresh", "old"]);
  assert.equal(next.models.a!.input, 3, "the fetched price wins");
});

// ---------------------------------------------------------------------------
// OpenAI and Google: excerpts of the real pages, in their real shape.

const OPENAI_ROW = (id: string, i: string, c: string, o: string) => `| ${id} | ${i} | ${c} | - | ${o} | - | - | - | - |`;
const OPENAI_PAGE = `# Pricing

Our latest models

Prices per 1M tokens.

Standard

### Standard pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00 |
| gpt-5.5 (<272K context length) | $5.00 | $0.50 | - | $30.00 | $10.00 | $1.00 | - | $45.00 |
| gpt-5.5-pro (<272K context length) | $30.00 | - | - | $180.00 | $60.00 | - | - | $270.00 |
${OPENAI_ROW("gpt-5.4-mini", "$0.75", "$0.075", "$4.50")}
${OPENAI_ROW("gpt-5", "$1.25", "$0.125", "$10.00")}
${OPENAI_ROW("gpt-5-mini", "$0.25", "$0.025", "$2.00")}
${OPENAI_ROW("gpt-4.1", "$2.00", "$0.50", "$8.00")}
${OPENAI_ROW("gpt-4o", "$2.50", "$1.25", "$10.00")}
${OPENAI_ROW("gpt-4o-2024-05-13", "$5.00", "-", "$15.00")}
${OPENAI_ROW("o3", "$2.00", "$0.50", "$8.00")}
${OPENAI_ROW("o4-mini", "$1.10", "$0.275", "$4.40")}

Batch

### Batch pricing data

| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $5.00 | $0.50 | $6.25 | $25.00 | $10.00 | $1.00 | $12.50 | $37.50 |
| gpt-5.3-codex | $0.875 | $0.0875 | - | $7.00 | - | - | - | - |

Prices per 1M tokens unless noted.

### Grouped Pricing Table data

| Model | Modality | Input | Cached input | Output / cost |
| --- | --- | --- | --- | --- |
| gpt-realtime-2.1 | Audio | $32.00 | $0.40 | $64.00 |

Prices per 1M tokens.

Standard

### Grouped Pricing Table data

| Model | Input | Cached input | Output |
| --- | --- | --- | --- |
| gpt-5.3-codex | $1.75 | $0.175 | $14.00 |
| text-embedding-3-small | $0.02 | - | - |
`;

test("OpenAI: Standard prices only, long context where the page names the limit", () => {
  const { models, skipped } = parseOpenAiPricing(OPENAI_PAGE);
  assert.deepEqual(models["gpt-6-astra"], { name: "gpt-6-astra", input: 10, cache_write_5m: 12.5, cache_write_1h: 12.5, cache_read: 1, output: 50 }, "no limit named: no long-context price");
  assert.deepEqual(models["gpt-5.5"]!.long, { above: 272_000, input: 10, cache_write_5m: 10, cache_write_1h: 10, cache_read: 1, output: 45 });
  assert.equal(models["gpt-5.5-pro"]!.cache_read, 30, "no cached price: cached input costs full input");
  assert.equal(models["gpt-5.3-codex"]!.input, 1.75, "the Batch table is not read");
  assert.equal(models["gpt-realtime-2.1"], undefined, "tables split by modality are passed over");
  assert.deepEqual(skipped, ['"text-embedding-3-small": no input and output price']);
});

test("OpenAI: a page that no longer reads is an error", () => {
  assert.throws(() => parseOpenAiPricing(OPENAI_PAGE.replaceAll("Short context input", "Input (short)")), /only \d+ model/);
  assert.throws(() => parseOpenAiPricing("<html>maintenance</html>"), PricingFormatError);
});

const GOOGLE_PAGE = `Start building free of charge with generous limits, then scale up with pay-as-you-go pricing.

## Gemini 3.8 Flash

*[\`gemini-3.8-flash\`](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)*

[Try it in Google AI Studio](https://aistudio.google.com/prompts/new_chat?model=gemini-3.8-flash)

### Standard

|   | Free Tier | Paid Tier, per 1M tokens in USD |
|---|---|---|
| Input price | Free of charge | $0.75 through December 31, 2026. $1.50 starting January 1, 2027. |
| Output price (including thinking tokens) | Free of charge | $3.75 through December 31, 2026. $7.50 starting January 1, 2027. |
| Context caching price | Free of charge | $0.075 through December 31, 2026. $0.15 starting January 1, 2027. $0.50 / 1,000,000 tokens per hour (storage price) through December 31, 2026. $1.00 / 1,000,000 tokens per hour (storage price) starting January 1, 2027. |
| Grounding with Google Search^\\*^ | Not available | 5,000 free search requests per month (shared across all Gemini 3.x models), then $14 per 1,000 requests. |

### Batch

|   | Free Tier | Paid Tier, per 1M tokens in USD |
|---|---|---|
| Input price | Not available | $0.375 through December 31, 2026. $0.75 starting January 1, 2027. |
| Output price (including thinking tokens) | Not available | $1.875 through December 31, 2026. $3.75 starting January 1, 2027. |

## Gemini 3.8 Live, Gemini 3.8 Live Extended Thinking, and Gemini 3.1 Flash Live Preview

*[\`gemini-3.8-live\`](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live), [\`gemini-3.8-live-extended-thinking\`](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live-extended-thinking), and [\`gemini-3.1-flash-live-preview\`](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-live-preview)*

### Standard

|   | Free Tier | Paid Tier, per 1M tokens in USD |
|---|---|---|
| Input price | Free of charge | $0.75 (text) $3.00 or $0.005/min (audio) $1.00 or $0.002/min (image/video) |
| Output price (including thinking tokens) | Free of charge | $4.50 (text) $12.00 or $0.018/min (audio) |

## Gemini 2.5 Pro

*[\`gemini-2.5-pro\`](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro)*

### Standard

|   | Free Tier | Paid Tier, per 1M tokens in USD |
|---|---|---|
| Input price | Free of charge | $1.25, prompts \\<= 200k tokens $2.50, prompts \\> 200k tokens |
| Output price (including thinking tokens) | Free of charge | $10.00, prompts \\<= 200k tokens $15.00, prompts \\> 200k |
| Context caching price | Not available | $0.125, prompts \\<= 200k tokens $0.25, prompts \\> 200k $4.50 / 1,000,000 tokens per hour (storage price) |

## Gemini 3.8 Flash TTS

*[\`gemini-3.8-flash-tts\`](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts)*

### Standard

|   | Free Tier | Paid Tier, per 1M tokens in USD |
|---|---|---|
| Input price | Free of charge | $0.50 (text) through December 31, 2026. $1.00 (text) starting January 1, 2027. |
| Output price | Free of charge | $9.00 (audio) through December 31, 2026. $18.00 (audio) starting January 1, 2027. |
`;

test("Google: the Standard paid tier, long prompts, announced prices, every ID of a section", () => {
  const { models } = parseGooglePricing(GOOGLE_PAGE, new Date("2026-09-25T00:00:00Z"));
  assert.deepEqual(Object.keys(models).sort(), [
    "gemini-2.5-pro",
    "gemini-3.1-flash-live-preview",
    "gemini-3.8-flash",
    "gemini-3.8-live",
    "gemini-3.8-live-extended-thinking",
  ], "a model without text output (TTS) is left out");
  const flash = models["gemini-3.8-flash"]!;
  assert.deepEqual([flash.input, flash.cache_read, flash.output], [0.75, 0.075, 3.75], "Standard, not Batch; storage is not a token price");
  assert.deepEqual(flash.next, { from: "2027-01-01", input: 1.5, cache_write_5m: 1.5, cache_write_1h: 1.5, cache_read: 0.15, output: 7.5 });
  assert.deepEqual(models["gemini-2.5-pro"]!.long, { above: 200_000, input: 2.5, cache_write_5m: 2.5, cache_write_1h: 2.5, cache_read: 0.25, output: 15 });
  assert.deepEqual([models["gemini-3.8-live"]!.input, models["gemini-3.8-live"]!.output], [0.75, 4.5], "the text price of a split cell");

  // Read after the announced day, the new price is the price.
  const later = parseGooglePricing(GOOGLE_PAGE, new Date("2027-01-02T00:00:00Z")).models["gemini-3.8-flash"]!;
  assert.deepEqual([later.input, later.output, later.next], [1.5, 7.5, undefined]);
});

test("Google: cells that are not token prices read as none", () => {
  assert.equal(parseGoogleCell("Free of charge"), null);
  assert.equal(parseGoogleCell("5,000 free search requests per month, then $14 per 1,000 requests."), null);
  assert.deepEqual(parseGoogleCell("$0.30 (text / image / video) $1.00 (audio)"), { now: 0.3 });
  assert.throws(() => parseGooglePricing("## Pricing\n\nmoved"), PricingFormatError);
});
