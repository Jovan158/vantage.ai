// Running meter: aggregates per-request usage events into session totals and a
// short-window output-token rate, and formats a compact status line.
//
// Honesty rule (CONCEPT.md §6a): tokens are always exact; the dollar figure is
// an estimate and is labelled as such — under a subscription plan there is no
// real per-token cost, only quota consumption.

import type { UsageEvent } from "./events.ts";
import { formatRateLimit } from "./ratelimit.ts";
import type { RateLimitSnapshot } from "./ratelimit.ts";

export interface MeterTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export class Meter {
  private totals: MeterTotals = {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
  };
  // (timestampMs, cumulativeOutput) samples for a rolling rate.
  private samples: Array<[number, number]> = [];
  private readonly windowMs = 60_000;
  private rateLimit: RateLimitSnapshot | null = null;

  setRateLimit(snapshot: RateLimitSnapshot): void {
    this.rateLimit = snapshot;
  }

  rateLimitLine(nowMs = Date.now()): string | null {
    return this.rateLimit ? formatRateLimit(this.rateLimit, nowMs) : null;
  }

  add(e: UsageEvent, nowMs = Date.now()): void {
    this.totals.requests += 1;
    this.totals.input += e.in;
    this.totals.output += e.out;
    this.totals.cacheRead += e.cache_read;
    this.totals.cacheWrite += e.cache_write;
    this.totals.costUsd += e.cost_usd;

    this.samples.push([nowMs, this.totals.output]);
    const cutoff = nowMs - this.windowMs;
    while (this.samples.length > 1 && this.samples[0]![0] < cutoff) {
      this.samples.shift();
    }
  }

  snapshot(): MeterTotals {
    return { ...this.totals };
  }

  // Output tokens per minute over the trailing window.
  outputTokensPerMin(nowMs = Date.now()): number {
    if (this.samples.length < 2) return 0;
    const [t0, o0] = this.samples[0]!;
    const spanMs = Math.max(1, nowMs - t0);
    const deltaOut = this.totals.output - o0;
    return (deltaOut / spanMs) * 60_000;
  }

  // Compact one-line status, e.g.:
  //   Σ in 2.0k · out 174 · cache 512 · ~$0.009 (est.) · 348 out/min
  statusLine(nowMs = Date.now()): string {
    const t = this.totals;
    const rate = Math.round(this.outputTokensPerMin(nowMs));
    const parts = [
      `Σ in ${fmt(t.input)}`,
      `out ${fmt(t.output)}`,
      // Cache writes cost ~1.25x input, so hiding them makes the cost look
      // inexplicable. Show them whenever they occur.
      t.cacheWrite > 0
        ? `cache ${fmt(t.cacheRead)}r/${fmt(t.cacheWrite)}w`
        : `cache ${fmt(t.cacheRead)}`,
      `~$${t.costUsd.toFixed(4)} (est.)`,
    ];
    if (rate > 0) parts.push(`${fmt(rate)} out/min`);
    return parts.join(" · ");
  }
}

function fmt(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}
