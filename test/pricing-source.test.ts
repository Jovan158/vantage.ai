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
} from "../src/pricing-source.ts";
import { mergeTables, loadActivePrices, validateTable, pricingHints, type PriceTable } from "../src/pricing.ts";
import { SNAPSHOT } from "../src/pricing-snapshot.ts";

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

test("the bundled snapshot passes the same checks as a fetched table", () => {
  assert.doesNotThrow(() => validateTable(SNAPSHOT));
  assert.ok(Object.keys(SNAPSHOT.models).length >= 10);
  assert.equal(SNAPSHOT.models["claude-opus-5-5"]!.input, 4);
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
  const p = loadActivePrices(SNAPSHOT, file);
  assert.equal(p.cached, null);
  assert.match(p.cacheError ?? "", /m: /);
  assert.equal(p.models["claude-opus-5-5"]!.input, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("hints: update for unknown Claude models, a plain note for others, age", () => {
  const p = loadActivePrices(table("2026-09-01T00:00:00Z", { a: entry(1) }), "/nonexistent/pricing.json");
  const now = Date.parse("2026-09-10T00:00:00Z");
  assert.deepEqual(pricingHints([], p, now), []);
  const hints = pricingHints(["claude-opus-9", "some-gateway-model"], p, now);
  assert.match(hints[0]!, /claude-opus-9.*vantage pricing update/);
  assert.match(hints[1]!, /some-gateway-model.*not on Anthropic's price list/);
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

  const ok = await vantage(["pricing", "update"], { VANTAGE_HOME: home, VANTAGE_PRICING_URL: `${s.base}/pricing.md` });
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /new: claude-sonnet-6/);
  const saved = JSON.parse(fs.readFileSync(path.join(home, "pricing.json"), "utf8")) as PriceTable;
  assert.equal(saved.models["claude-sonnet-6"]!.output, 10);

  const shown = await vantage(["pricing"], { VANTAGE_HOME: home });
  assert.match(shown.out, /from `vantage pricing update`/);
  assert.match(shown.out, /claude-sonnet-6/);
  assert.match(shown.out, /claude-fable-5-1/); // bundled models stay priced

  const broken = await vantage(["pricing", "update"], { VANTAGE_HOME: home, VANTAGE_PRICING_URL: `${s.base}/broken.md` });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /update failed, prices unchanged/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "pricing.json"), "utf8")), saved);

  await s.close();
  fs.rmSync(home, { recursive: true, force: true });
});
