# Vantage — concept: a control and transparency layer for AI coding CLIs

> **Vantage** = the raised point of observation. Not another coding agent, but the
> vantage point from which you see and steer existing CLI agents (Claude Code,
> Codex CLI, Aider, Gemini CLI …). Invoked below as `vantage run <agent>`.

Status: **implemented** — all five problems have working features, verified on
real traffic. **Only Claude Code is supported for now**; Codex CLI, Aider and
Gemini CLI remain concept (see below). Implementation status, deliberate
departures from the concept and open points: [§7](#7-next-steps--prototype).
Usage: [README](../README.md).

> Sections §1–§6 are the original concept and stay as the basis for the
> decisions — including where the implementation deliberately departed from it
> (§7 names the departures and their reasons).

---

## The five problems addressed

1. No real-time view of token use and cost → unexpected limits in the middle of work.
2. Approval levels that are too coarse ("allow everything" vs. "ask at every step") instead of fine-grained per action type (read / write / shell / network).
3. No way to follow what happened across several steps (What did the agent intend? Why?).
4. No protection against risky changes (no branch isolation by default, multi-file diffs that are hard to review).
5. No memory across sessions: every session starts from zero.

---

## 1. Architecture: a wrapper, not a rebuild

The core conflict: **observe and steer** agents without access to their internal
state. The answer: a **multi-layer interception model**. Each layer solves a
different problem; for each agent, Vantage uses the best layer available.

```
        ┌──────────────────────────────────────────────┐
        │                vantage (core)                │
        │  session orchestrator · event bus · store    │
        └──────────────────────────────────────────────┘
             │            │             │           │
     ┌───────┴──┐  ┌──────┴─────┐ ┌─────┴────┐ ┌────┴──────┐
     │ PTY layer│  │ LLM proxy  │ │ native   │ │ git/FS    │
     │ (stdio)  │  │ (HTTP)     │ │ hooks    │ │ layer     │
     └──────────┘  └────────────┘ └──────────┘ └───────────┘
        universal     tokens/cost   clean,       isolation/
        but "blind"   + gate        per agent    diffs
```

**Layer A — process wrapping (PTY).** Vantage starts the real agent as a child
process in a pseudo-terminal (`node-pty`). The agent runs interactively as
always; Vantage sees the rendered I/O. Universal for any CLI agent, but only
rendered text — no structured knowledge. The fallback layer.

**Layer B — LLM proxy (the key).** Almost all agents let an environment variable
redirect their base URL (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`,
`OPENAI_API_BASE` …). Vantage starts a local reverse proxy, sets these variables
in the child process and forwards transparently to the real provider. That way
Vantage sees the real API traffic: exact tokens from the `usage` fields, the
model, every tool call *before* it runs. The data source for cost (①) and replay
(③), and the natural place for an approval gate at the network level (②). The
heart of it.

**Layer C — native hooks/telemetry.** Where an agent offers better integration,
Vantage uses it: Claude Code's `PreToolUse`/`PostToolUse` hooks and
OpenTelemetry, Aider's `--llm-history-file`, and so on. The adapter picks the
cleanest source.

**Layer D — git/FS layer.** Independent of the agent. The session in its own git
worktree/branch, file system watching (`chokidar`). Solves isolation and diff
aggregation (④) without agent internals.

### The glue: the adapter interface

The core only knows a normalized event schema. One adapter per agent, declaring
*which layers it supports*:

```ts
interface AgentAdapter {
  id: "claude-code" | "codex" | "aider" | "gemini"
  spawn(ctx): ChildHandle               // how to start the real agent
  proxyEnv(port): Record<string,string> // which environment variables to redirect
  parseUsage(res): TokenUsage | null    // how to read tokens from responses
  pricing: ModelPricingTable
  capabilities: { proxy: bool, hooks: bool, pty: bool }
}
```

The core stays stable; a new agent is "just" an adapter — no rebuild, no fork.
**Degradation path:** when a layer cannot do something, Vantage falls back (for
example to PTY only) and **says so openly** instead of showing wrong numbers.

---

## 2. MVP feature set by effort and value

Sorted by value ÷ effort (top = first).

| # | Feature | Problem | Effort | Value | Layer |
|---|---------|---------|--------|-------|-------|
| 1 | **Live token/cost meter** — status line: tokens, cost, rate, "about X left until the limit" | ① | M | Very high | B |
| 2 | **Git session isolation** — automatic worktree/branch, one command to merge or discard | ④ | S | High | D |
| 3 | **Aggregated diff review** — `vantage diff` bundles all changes of a session | ④ | S | High | D |
| 4 | **Fine-grained approval gate** — rules per action type (`read`/`write`/`shell`/`network`) | ② | M–L | High | B/C |
| 5 | **Structured event log** — the session as append-only JSONL | ③ | S | Medium (enabler!) | B/C |
| 6 | **Session replay / timeline** — TUI or local web dashboard over the log | ③ | M | High | — |
| 7 | **Project memory `.vantage/`** — file-based, versioned, compiled per agent | ⑤ | M | Medium to high | D |

**Key dependency:** feature 5 (event log) enables 1, 4 and 6 — a shared data
store. Build 5 as a by-product of the proxy (B) and get meter, gate and replay
on top of it.

---

## 3. Technology stack

**Recommendation: TypeScript / Node.js ≥ 20.** Reasons: close to the target
audience's ecosystem (`npx vantage` as the natural distribution), and the
critical building blocks are first-class in Node (`node-pty`, HTTP proxy, Ink
TUI).

| Building block | Choice | Why |
|----------|------|-------|
| Language/runtime | TypeScript, Node ≥ 20 | ecosystem, native `fetch`/streams |
| CLI framework | `clipanion` / `commander` | light, typed |
| Process wrapping | `node-pty` | the only robust PTY route in Node |
| Proxy | `fastify` + `undici` (streaming pass-through) | fast, handles SSE |
| TUI | `ink` (+ `ink-ui`) | live status line and replay, React style |
| Web dashboard (optional) | static Fastify + SolidJS/Svelte, SSE for live updates | minimal |
| Persistence | **JSONL** (log) + **SQLite** (`better-sqlite3`) for aggregates | JSONL = readable and git-friendly, SQLite = fast queries |
| Git | `simple-git` | worktrees, diffs |
| FS watching | `chokidar` | diff trigger |
| Config | `.vantage/config.toml` + Zod validation | type-safe |

**Alternative Go/Rust:** a static binary would be nicer to distribute and the
proxy faster — but the distribution advantage is small for a Node-savvy
audience, the TUI ecosystem is weaker, and iteration is faster in TS. → **TS for
the MVP.** Should the proxy ever become the bottleneck, *only* that part can
move to Go/Rust later.

---

## 4. Session replay / log view

**Data basis:** append-only JSONL per session (`.vantage/sessions/<id>/events.jsonl`).
Each line is a normalized event:

```jsonc
{ "ts": …, "type": "prompt",    "text": … }
{ "ts": …, "type": "tool_call", "tool": "write_file", "path": …, "preview": …, "approved": true }
{ "ts": …, "type": "usage",     "model": …, "in": …, "out": …, "cache": …, "cost_eur": … }
{ "ts": …, "type": "diff",      "path": …, "added": …, "removed": … }
{ "ts": …, "type": "decision",  "summary": … }   // "the agent wanted X because of Y"
```

The proxy (B) feeds `prompt`/`tool_call`/`usage`; the FS/git layer the `diff`
events. One source, two views:

- **TUI (`vantage replay <id>`):** an Ink app renders a collapsible timeline. Live
  mode (`--follow`) attaches to the running session through a watcher. Stays in
  the terminal workflow, no port.
- **Web dashboard (`vantage dashboard`):** Fastify serves a small SPA; live
  updates via SSE. SQLite allows aggregates across all sessions ("spent 4.20 this
  week"). Real diff viewers (Monaco), shareable.

**Recommendation:** TUI first (closer to the workflow), dashboard on top — both
read the same JSONL. "What did the agent intend": the tool calls of one
assistant turn = the concrete steps of one intention, optionally condensed by a
cheap LLM call.

---

## 5. Persistent, file-based project memory

**Principle: git is the database.** Memory as versioned files in the repo —
readable, shareable with the team, reviewable in a PR, consistent with the state
of the code.

```
.vantage/
  memory/
    decisions.md      # architecture decisions (ADR-like, append-only)
    architecture.md   # structure/modules, current state
    glossary.md       # domain terms
    conventions.md    # "this is how we do it here"
    index.json        # embeddings/metadata for retrieval (optional)
  sessions/<id>/events.jsonl
```

**Core mechanism — compiling into each agent's native format.** Every agent has
its own context format (Claude Code `CLAUDE.md`; others `AGENTS.md`, a system
prompt prepend …). Vantage keeps *one* canonical source and compiles it per
session:

```
.vantage/memory/*  ──(vantage compiles)──▶  CLAUDE.md / --system-prompt / prepend
        ↑                                              │
        └────── (after the session: distill) ◀─────────┘
```

- **Before the session (inject):** the adapter renders the relevant subset into
  the native format. Every agent gets the same context.
- **After the session (harvest):** distill new decisions/facts from the event
  log (cheap LLM call) and write them as a **suggestion** into `decisions.md` —
  always with confirmation, never silent overwriting.
- **Cross-agent by design:** one canonical source → Claude Code and Aider share
  the same project knowledge.

For large projects: `index.json` with embeddings, so only relevant parts are
injected (sparing the context window).

---

## 6. Risks and technical limits (honestly)

**a) Reading tokens and cost live.**
- Through the proxy **very reliable** — the `usage` fields come from real
  provider responses (with streaming, in the final SSE event). The provider's
  ground truth.
- Limits: (1) the agent must allow redirecting its base URL — Claude
  Code/Codex/Aider do, otherwise only a PTY estimate. (2) **Cost ≠ tokens:** prompt
  caching (cache writes and reads priced differently), batch discounts, and above
  all **subscriptions** (Claude subscription instead of an API key) make "exact
  cost" hard. The honest message: with API keys, tokens are *exact* and cost
  *very close*; with subscriptions, show **tokens and rate as a limit forecast**,
  not money. (3) Price tables go stale → an updatable config, not hard-coded.
- **Rate-limit forecast** (what ① really needs): providers partly send
  `*-ratelimit-*` headers — the proxy reads them → a real instead of an estimated
  forecast.

**b) Hooking into other CLI processes without breaking them.**
- PTY wrapping is safe as long as Vantage passes everything through
  transparently (resize signals, raw mode, Ctrl-C, alternate screen) — observe,
  don't re-render.
- Intervening in the proxy is the most delicate part: if Vantage blocks a tool
  call (gate), it must return a **well-formed deny response** in the expected
  schema, or the agent hangs or crashes. Different per provider → belongs in the
  adapter, needs tests. Passing **SSE streaming** through correctly (no
  buffering, clean aborts) is the main source of bugs.
- Version drift: when an agent changes its CLI or format, an adapter can break →
  adapters declare tested version ranges, and the degradation path takes over.

**c) Approval gate — granularity vs. reality.** "Forbid network" at the proxy
level only covers *LLM* calls; if the agent runs `curl` in a shell, it does not
apply — that would need a gate at the shell level (harder). MVP limit: the gate
is reliable for LLM calls and reported tool calls; real shell sandboxing is a
later, bigger topic (OS sandbox/container).

**d) Security and trust.** Vantage sits between agent and provider and sees all
prompts, keys and code. It must stay local, only pass keys through (never log
them), and redact the event log (no secrets). A precondition for trust, not a
nice-to-have.

---

## 7. Next steps — prototype

**The chosen starting point was: a token/cost meter based on the proxy (features 1 + 5).**

Reasons: it addresses the most painful problem (①) with the most immediately
noticeable value, forces us to build the load-bearing pillar first (proxy +
event log, the foundation for gate/replay/memory), and tests the project's
riskiest assumption first (redirecting the base URL and passing SSE through
cleanly).

### Implementation status

All five problems now have working features, verified on real
`api.anthropic.com` traffic (not only against mocks):

| Problem | Implemented | Status |
|---|---|---|
| ① Cost/limits | Meter (stream + JSON, decompressed), limit forecast from rate-limit headers, threshold warning, budgets | done |
| ② Fine-grained approvals | Classification (read/write/shell/network) + 4 levels (allow/warn/ask/deny), file and command rules, enforced via the `PreToolUse` hook | done |
| ③ Traceability | Event log, `replay` timeline with prompt/reply/tools, `watch` live view, `stats`, `search`, secret warnings, redaction | done |
| ④ Risky changes | Change summary for every session, `--isolate` (git worktree/branch), aggregated diff, `review`/`discard` | done |
| ⑤ Project memory | `.vantage/memory/` compiled and injected (`--append-system-prompt`), assisted `harvest` | done |

### Departures from the original concept — and why

Three decisions deliberately went differently from the sketch above:

1. **No Fastify/undici, no runtime dependencies.** Node's built-ins (`http`,
   `zlib`, `fetch`) are fully sufficient. That keeps a tool that wraps *other*
   tools light and exposed to few supply-chain risks.
2. **No PTY.** `stdio: "inherit"` is enough and far less risky — the agent keeps
   its terminal unchanged.
3. **No Ink status line on top of the agent's output.** An overlay would mean
   Vantage takes over the terminal and redraws — exactly the breaking point from
   §6b. The live view runs instead as `vantage watch` in a second terminal, fed
   from the append-only event log. Same value, no risk to the agent's UI, no
   dependencies. Alerts reach Claude Code's own chat through its `Stop` hook.

Beyond the original concept: a **provider layer** behind an interface, so more
agents can be added. An OpenAI integration for Codex CLI and Aider was built but
removed again: it could only measure (no approvals, no memory, no prices) and was
never tested against the real tools. The focus is fully on Claude Code for now.

### Enforcement: why native hooks and not the proxy

§6b/c left three routes open. The implementation chose **native agent hooks**,
because the alternatives fail on one fact: **the proxy sees tool intentions but
cannot stop them.** A file write or shell command runs *inside* the agent and
never passes the proxy — a proxy deny could only block the LLM network calls,
which is exactly not read/write/shell. An OS sandbox could, but is many times the
effort and platform-specific. Claude Code's `PreToolUse` hook runs *before*
execution and returns a decision — the only layer that both works and leaves the
proxy untouched, which ①③⑤ build on.

Two safety properties of the implementation: Vantage never returns an explicit
`allow` (it may only restrict, never widen), and Claude Code merges `--settings`
with the user's settings, combining lists such as `hooks` instead of replacing
them — existing hooks stay in place.

### Open
- **Memory harvest** is deliberately *assisted* rather than automatic
  (`vantage harvest`): an LLM call after every session would silently burn quota
  (problem ①), and a wrongly distilled entry would poison every future session,
  because memory is injected into the context. An optional `--llm` for deeper
  distillation remains possible, but must be explicit.
- **Publishing**: the npm names `vantage` and `vantage-ai` are not available; the
  package is published as `vantage-ai-cli` (the command stays `vantage`).
