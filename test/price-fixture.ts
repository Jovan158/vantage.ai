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

export function usePriceFixture(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "pricing.json"),
    JSON.stringify({ source: "test fixture", fetchedAt: "2999-01-01T00:00:00.000Z", models: FIXTURE_MODELS })
  );
}
