// Rate-limit extraction from provider response headers.
//
// Reading these turns the meter from "how much have I used" into "how much is
// left" — the real answer to problem ① (CONCEPT.md §6a). Only the usage
// limits of a subscription are read: the 5-hour and weekly windows.
//
//   Claude Pro / Max (unified quota windows):
//        anthropic-ratelimit-unified-{5h,7d}-{status,utilization,reset}
//        anthropic-ratelimit-unified-{status,representative-claim,overage-status,reset}
//   ChatGPT plans (Codex): see parseCodex below.
//
// An API key has no such windows, only limits per minute that refill within
// seconds and that the agent waits out by itself; they are not read.
//
// The unified window's `utilization` (0..1) is the fraction of the window used,
// and `reset` is a Unix timestamp (seconds) — no per-token dollar cost exists on
// a subscription, so this utilization IS the limit prognosis.

export interface UnifiedWindow {
  key: string; // "5h" | "7d"
  status: string | null;
  utilization: number | null; // fraction used, 0..1
  resetUnix: number | null; // epoch seconds
}

export interface UnifiedRateLimit {
  status: string | null;
  representativeClaim: string | null; // which window is the binding one
  overageStatus: string | null;
  windows: UnifiedWindow[];
}

export interface RateLimitSnapshot {
  unified: UnifiedRateLimit;
  retryAfterSec: number | null;
  /** Every rate-limit-related header seen, verbatim (for diagnostics). */
  raw: Record<string, string>;
}

type Headers = Record<string, string | string[] | undefined>;

const UNIFIED_WINDOWS = ["5h", "7d"] as const;

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseUnified(raw: Record<string, string>): UnifiedRateLimit | undefined {
  const windows: UnifiedWindow[] = [];
  for (const key of UNIFIED_WINDOWS) {
    const status = raw[`anthropic-ratelimit-unified-${key}-status`];
    const util = raw[`anthropic-ratelimit-unified-${key}-utilization`];
    const reset = raw[`anthropic-ratelimit-unified-${key}-reset`];
    if (status == null && util == null && reset == null) continue;
    windows.push({
      key,
      status: status ?? null,
      utilization: num(util),
      resetUnix: num(reset),
    });
  }
  const top = raw["anthropic-ratelimit-unified-status"];
  if (windows.length === 0 && top == null) return undefined;
  return {
    status: top ?? null,
    representativeClaim: raw["anthropic-ratelimit-unified-representative-claim"] ?? null,
    overageStatus: raw["anthropic-ratelimit-unified-overage-status"] ?? null,
    windows,
  };
}

// Codex on a ChatGPT plan reports its usage limits the same way in spirit:
//   x-codex-{primary,secondary}-{used-percent,window-minutes,reset-at}
// primary is the 5-hour window and secondary the weekly one; used-percent is
// 0..100 and reset-at epoch seconds. Over a WebSocket the same numbers come
// as a "codex.rate_limits" event (see rateLimitFromEvent).
function windowKey(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "7d";
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes ? `${minutes}m` : fallback;
}

function parseCodex(raw: Record<string, string>): UnifiedRateLimit | undefined {
  const windows: UnifiedWindow[] = [];
  for (const [slot, fallback] of [["primary", "5h"], ["secondary", "7d"]] as const) {
    const used = num(raw[`x-codex-${slot}-used-percent`]);
    if (used == null) continue;
    const minutes = num(raw[`x-codex-${slot}-window-minutes`]);
    windows.push({
      key: windowKey(minutes, fallback),
      status: used >= 100 ? "rejected" : null,
      utilization: used / 100,
      resetUnix: num(raw[`x-codex-${slot}-reset-at`]),
    });
  }
  if (windows.length === 0) return undefined;
  return { status: null, representativeClaim: null, overageStatus: null, windows };
}

// A "codex.rate_limits" WebSocket event, as the same snapshot the headers
// give (with the header names, so the event log reads back the same way).
export function rateLimitFromEvent(event: unknown): RateLimitSnapshot | null {
  const e = event as { type?: string; rate_limits?: Record<string, { used_percent?: number; window_minutes?: number; reset_at?: number } | null> };
  if (!e || e.type !== "codex.rate_limits" || !e.rate_limits) return null;
  const headers: Record<string, string> = {};
  for (const slot of ["primary", "secondary"]) {
    const w = e.rate_limits[slot];
    if (!w || typeof w.used_percent !== "number") continue;
    headers[`x-codex-${slot}-used-percent`] = String(w.used_percent);
    if (w.window_minutes != null) headers[`x-codex-${slot}-window-minutes`] = String(w.window_minutes);
    if (w.reset_at != null) headers[`x-codex-${slot}-reset-at`] = String(w.reset_at);
  }
  return extractRateLimit(headers);
}

// Returns null when the response carries no subscription limits (an API
// key, or a provider that reports none).
export function extractRateLimit(headers: Headers): RateLimitSnapshot | null {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key.startsWith("anthropic-ratelimit-unified-") || /^x-codex-(?:primary|secondary)-/.test(key) || key === "retry-after") {
      raw[key] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
    }
  }
  const unified = parseUnified(raw) ?? parseCodex(raw);
  if (!unified) return null;
  return { unified, retryAfterSec: num(raw["retry-after"]), raw };
}

export function relFromSeconds(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${rem}m` : `${h}h`;
}

// A short human hint like "quota 5h 50% used, reset 1h23m · 7d 6%", or null
// when there are no windows to show.
export function formatRateLimit(s: RateLimitSnapshot, now = Date.now()): string | null {
  if (s.unified.windows.length === 0) return null;
  const order = (w: UnifiedWindow): number => (s.unified.representativeClaim?.startsWith(w.key === "5h" ? "five" : "seven") ? 0 : 1);
  const sorted = [...s.unified.windows].sort((a, z) => order(a) - order(z));
  const parts = sorted.map((w) => {
    const seg: string[] = [w.key];
    if (w.utilization != null) seg.push(`${Math.round(w.utilization * 100)}% used`);
    if (w.resetUnix != null) seg.push(`reset ${relFromSeconds(w.resetUnix - now / 1000)}`);
    return seg.join(" ");
  });
  let out = `quota ${parts.join(" · ")}`;
  if (s.unified.status && s.unified.status !== "allowed") out += ` [${s.unified.status}]`;
  if (s.retryAfterSec != null) out += ` · retry-after ${s.retryAfterSec}s`;
  return out;
}

// ---------------------------------------------------------------------------
// Threshold warnings (problem ①: never hit a limit mid-work by surprise).
//
// QuotaWatcher fires a warning the first time a quota window crosses the
// threshold, stays quiet on every following request while it remains over
// (no spam), and re-arms once utilization drops back below (e.g. after reset).
// A rejected window or a retry-after is acute and warned immediately.
// ---------------------------------------------------------------------------

export interface QuotaWarning {
  key: string;
  level: "warn" | "critical";
  message: string;
}

export class QuotaWatcher {
  private warned = new Set<string>();
  private readonly threshold: number;

  /** threshold is a fraction 0..1 of a window's utilization (default 0.9). */
  constructor(threshold = 0.9) {
    this.threshold = threshold;
  }

  update(s: RateLimitSnapshot, now = Date.now()): QuotaWarning[] {
    const out: QuotaWarning[] = [];
    const once = (key: string, make: () => QuotaWarning): void => {
      if (!this.warned.has(key)) {
        this.warned.add(key);
        out.push(make());
      }
    };
    const clear = (key: string): void => void this.warned.delete(key);
    const resetHint = (unix: number | null): string =>
      unix != null ? ` (resets in ${relFromSeconds(unix - now / 1000)})` : "";
    const label = (key: string): string => (key === "5h" ? "5-hour" : key === "7d" ? "weekly" : key);

    for (const w of s.unified.windows) {
      // Only "rejected" blocks requests; "allowed_warning" still lets them
      // through and is covered by the utilization warning below.
      if (w.status === "rejected") {
        once(`rej:${w.key}`, () => ({
          key: w.key,
          level: "critical",
          message: `${label(w.key)} limit reached (rejected) — requests are blocked${resetHint(w.resetUnix)}`,
        }));
      } else {
        clear(`rej:${w.key}`);
      }
      if (w.utilization != null) {
        if (w.utilization >= this.threshold) {
          once(`util:${w.key}`, () => ({
            key: w.key,
            level: "warn",
            message: `${label(w.key)} limit ${Math.round(w.utilization! * 100)}% used — getting close${resetHint(w.resetUnix)}`,
          }));
        } else {
          clear(`util:${w.key}`);
        }
      }
    }

    if (s.retryAfterSec != null) {
      once("retry", () => ({
        key: "retry-after",
        level: "critical",
        message: `rate limit hit — retry after ${s.retryAfterSec}s`,
      }));
    } else {
      clear("retry");
    }

    return out;
  }
}
