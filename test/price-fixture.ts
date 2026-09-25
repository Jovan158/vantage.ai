// A fixed price list for tests that check the arithmetic — cost, cache
// splits, budgets — so they do not depend on today's official prices: the
// bundled list is updated automatically when those change.
//
// It is written as the user's `vantage pricing update` file, dated far in the
// future, so it wins over the bundled list for every model it names.

import fs from "node:fs";
import path from "node:path";

const m = (input: number, cache_write_5m: number, cache_write_1h: number, cache_read: number, output: number) => ({
  name: "fixture",
  input,
  cache_write_5m,
  cache_write_1h,
  cache_read,
  output,
});

export const FIXTURE_MODELS = {
  "claude-opus-5-5": m(4, 5, 8, 0.2, 20),
  "claude-opus-5": m(5, 6.25, 10, 0.5, 25),
  "claude-fable-5-1": m(10, 12.5, 20, 0.25, 50),
  "claude-fable-5": m(10, 12.5, 20, 1, 50),
  "claude-sonnet-5": m(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": m(3, 3.75, 6, 0.3, 15),
  "claude-opus-4-8": m(5, 6.25, 10, 0.5, 25),
  "claude-opus-4": m(15, 18.75, 30, 1.5, 75),
  "claude-haiku-4-5": m(1, 1.25, 2, 0.1, 5),
  "claude-3-5-haiku": m(0.8, 1, 1.6, 0.08, 4),
};

// OpenAI and Google leave prices out (no cache writes, no cache discount),
// price long prompts apart, and announce prices ahead.
const flat = (input: number, cache_read: number, output: number) => m(input, input, input, cache_read, output);

export const FIXTURE_OPENAI = {
  "gpt-5.5": { ...flat(5, 0.5, 30), long: { above: 272_000, ...flat(10, 1, 45) } },
  "gpt-5.4-mini": flat(0.75, 0.075, 4.5),
  "gpt-4o-2024-05-13": flat(5, 5, 15),
  "gpt-4o": flat(2.5, 1.25, 10),
};

export const FIXTURE_GOOGLE = {
  "gemini-3.8-flash": { ...flat(0.75, 0.075, 3.75), next: { from: "2027-01-01", ...flat(1.5, 0.15, 7.5) } },
  "gemini-2.5-pro": { ...flat(1.25, 0.125, 10), long: { above: 200_000, ...flat(2.5, 0.25, 15) } },
};

export function usePriceFixture(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  const write = (file: string, provider: string, models: object) =>
    fs.writeFileSync(
      path.join(home, file),
      JSON.stringify({ provider, source: "test fixture", fetchedAt: "2999-01-01T00:00:00.000Z", models })
    );
  write("pricing.json", "anthropic", FIXTURE_MODELS);
  write("pricing-openai.json", "openai", FIXTURE_OPENAI);
  write("pricing-google.json", "google", FIXTURE_GOOGLE);
}
