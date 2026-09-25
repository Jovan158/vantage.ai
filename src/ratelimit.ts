// Rate-limit extraction from provider response headers.
//
// Reading these turns the meter from "how much have I used" into "how much is
// left" — the real answer to problem ① (CONCEPT.md §6a). We capture every
// rate-limit header generically (rather than hardcoding a list) and parse the
// two shapes Anthropic emits:
//
//   1. Classic per-key buckets (API-key billing):
//        anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}
//   2. Unified quota windows (subscription / Pro-Max accounts), which is what
//      Claude Code returns in practice:
//        anthropic-ratelimit-unified-{5h,7d}-{status,utilization,reset}
//        anthropic-ratelimit-unified-{status,representative-claim,overage-status,reset}
//
// The unified window's `utilization` (0..1) is the fraction of the window used,
// and `reset` is a Unix timestamp (seconds) — no per-token dollar cost exists on
// a subscription, so this utilization IS the limit prognosis.

export interface RateLimitField {
  limit: number | null;
  remaining: number | null;
  reset: string | null; // RFC3339 timestamp when the bucket refills
}

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
  unified?: UnifiedRateLimit;
  requests?: RateLimitField;
  tokens?: RateLimitField;
  inputTokens?: RateLimitField;
  outputTokens?: RateLimitField;
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

function classicField(raw: Record<string, string>, bucket: string): RateLimitField | undefined {
  const limit = raw[`anthropic-ratelimit-${bucket}-limit`];
  const remaining = raw[`anthropic-ratelimit-${bucket}-remaining`];
  const reset = raw[`anthropic-ratelimit-${bucket}-reset`];
  if (limit == null && remaining == null && reset == null) return undefined;
  return { limit: num(limit), remaining: num(remaining), reset: reset ?? null };
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

// Returns null when the response carries no rate-limit information at all.
export function extractRateLimit(headers: Headers): RateLimitSnapshot | null {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key.startsWith("anthropic-ratelimit-") || /^x-codex-(?:primary|secondary)-/.test(key) || key === "retry-after") {
      raw[key] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
    }
  }
  if (Object.keys(raw).length === 0) return null;

  return {
    unified: parseUnified(raw) ?? parseCodex(raw),
    requests: classicField(raw, "requests"),
    tokens: classicField(raw, "tokens"),
    inputTokens: classicField(raw, "input-tokens"),
    outputTokens: classicField(raw, "output-tokens"),
    retryAfterSec: num(raw["retry-after"]),
    raw,
  };
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

// A short human hint like "quota 5h 50% used, reset 1h23m · 7d 6%" (unified) or
// "req 4999/5000 · tok 78% left · reset 42s" (classic), or null if nothing useful.
export function formatRateLimit(s: RateLimitSnapshot, now = Date.now()): string | null {
  // Prefer the unified windows — that's what subscription accounts return.
  if (s.unified && s.unified.windows.length > 0) {
    const order = (w: UnifiedWindow): number =>
      s.unified?.representativeClaim?.startsWith(w.key === "5h" ? "five" : "seven") ? 0 : 1;
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

  // Classic per-key buckets.
  const parts: string[] = [];
  if (s.requests?.remaining != null && s.requests.limit != null) {
    parts.push(`req ${s.requests.remaining}/${s.requests.limit}`);
  }
  const tokenBuckets = [s.tokens, s.inputTokens, s.outputTokens].filter(
    (b): b is RateLimitField => !!b
  );
  const tightest = tokenBuckets
    .map((b) => ({ b, pct: b.limit && b.remaining != null ? b.remaining / b.limit : null }))
    .filter((x): x is { b: RateLimitField; pct: number } => x.pct != null)
    .sort((a, z) => a.pct - z.pct)[0];
  if (tightest) parts.push(`tok ${Math.round(tightest.pct * 100)}% left`);
  for (const f of [s.tokens, s.requests]) {
    if (f?.reset) {
      const secs = (Date.parse(f.reset) - now) / 1000;
      if (Number.isFinite(secs)) parts.push(`reset ${relFromSeconds(secs)}`);
      break;
    }
  }
  if (s.retryAfterSec != null) parts.push(`retry-after ${s.retryAfterSec}s`);
  return parts.length ? parts.join(" · ") : null;
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

    if (s.unified) {
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
    }

    // Classic per-key buckets: warn when a bucket is nearly drained.
    const classic: Array<[string, RateLimitField | undefined]> = [
      ["tokens", s.tokens],
      ["input-tokens", s.inputTokens],
      ["output-tokens", s.outputTokens],
      ["requests", s.requests],
    ];
    for (const [name, f] of classic) {
      if (!f || f.limit == null || f.remaining == null || f.limit === 0) {
        continue;
      }
      const used = 1 - f.remaining / f.limit;
      if (used >= this.threshold) {
        once(`classic:${name}`, () => ({
          key: name,
          level: "warn",
          message: `${name} ${Math.round(used * 100)}% used — ${f.remaining}/${f.limit} left`,
        }));
      } else {
        clear(`classic:${name}`);
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
