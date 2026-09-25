# Spike: transparent streaming proxy + usage extraction

> **Throwaway spike, not production code.** Purpose: prove the riskiest assumption
> of the Vantage MVP in isolation before building on it. Deliberately free of
> dependencies (plain Node ESM, no build) and with a mock upstream, so it runs
> reproducibly without an API key and without network egress. The real
> implementation is TypeScript (see `docs/CONCEPT.md` §3).

## The assumption tested

> Can a local reverse proxy pass Anthropic's SSE through to the agent
> **byte for byte** and **at the same time** read the `usage` tokens, without
> disturbing the stream?

That is the load-bearing pillar of "layer B" (LLM proxy) from the concept — it
feeds cost (①), the event log and replay (③) and later the network gate (②).

## Running it

```bash
node spike/proxy-passthrough/run-spike.mjs
```

Chain: `client → vantage proxy → mock anthropic (SSE)`. The runner asserts:

1. **Transparency** — the bytes at the client are **identical** to what the
   upstream sent (the proxy is invisible).
2. **Usage** — input, output and cache tokens are extracted correctly from the
   SSE frames (`message_start` + `message_delta`).
3. **Cost** — an estimate from the price table.
4. **Event log** — a `usage` event is written to `events.jsonl`.

Result: **9/9 checks green**, time to first byte through the proxy ~11 ms (no
buffering → the stream stays live).

## Files

| File | Role |
|-------|-------|
| `proxy.mjs` | Transparent streaming reverse proxy; forwards bytes, tees a copy into the extractor |
| `usage.mjs` | SSE parser: pulls token counts from the frames without changing the stream |
| `pricing.mjs` | Placeholder price table and cost calculation (real: an updatable config) |
| `mock-anthropic.mjs` | Emulates `POST /v1/messages` (streaming) with a realistic SSE sequence |
| `run-spike.mjs` | Starts mock and proxy, sends one request through, asserts 1–4 |

## Deliberately NOT tested yet (the next unknowns)

- **The real endpoint** `api.anthropic.com` through the environment's HTTPS proxy
  (undici `ProxyAgent`/CA trust) instead of the mock.
- **A real Claude Code process** in a PTY with a redirected `ANTHROPIC_BASE_URL` —
  does the CLI accept the base URL and run interactively unchanged?
- **Subscription auth** (OAuth instead of an API key): tokens can be counted, but
  cost is not exact → the display must separate "tokens exact" from "cost
  estimated".
- **Rate-limit headers** (`anthropic-ratelimit-*`) for a real instead of an
  estimated limit forecast.

Those belong in the next step (`vantage run claude` against the real endpoint),
not in this spike.
