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

// Returns null when the response carries no rate-limit information at all.
export function extractRateLimit(headers: Headers): RateLimitSnapshot | null {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (key.startsWith("anthropic-ratelimit-") || key === "retry-after") {
      raw[key] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
    }
  }
  if (Object.keys(raw).length === 0) return null;

  return {
    unified: parseUnified(raw),
    requests: classicField(raw, "requests"),
    tokens: classicField(raw, "tokens"),
    inputTokens: classicField(raw, "input-tokens"),
    outputTokens: classicField(raw, "output-tokens"),
    retryAfterSec: num(raw["retry-after"]),
    raw,
  };
}

function relFromSeconds(secs: number): string {
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
