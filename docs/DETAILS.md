# Vantage — Details and background

Adds example output and the reasons behind the design decisions to the
[README](../README.md). The original concept is in [`CONCEPT.md`](CONCEPT.md).
The example output comes from real runs; amounts in it are illustrative.

## ① Tokens, cost, limits

`vantage run claude` wraps the real Claude Code CLI, passes its traffic through
to `api.anthropic.com` (the proxy honors `HTTPS_PROXY`/`NO_PROXY`) and extracts
the real usage — decompressing gzip/br on the observed copy, and metering both
streaming *and* JSON responses. The proxy also reads the **rate-limit headers**
and shows a real forecast of your limits:

```
[vantage] session end · 2 request(s) · in 66 · out 45 · cache 66414 · ~$0.0208
[vantage] quota 5h 53% used reset 1h50m · 7d 6% used reset 156h50m
```

The quota line covers both forms the API uses: **unified windows**
(subscription/Pro/Max, what Claude Code actually gets back — 5-hour and 7-day
utilization plus reset) and the **classic per-key buckets** (API-key billing —
requests/tokens remaining). That subscription quota is exactly what counting
tokens alone cannot show.

**Cost is an estimate at API list prices:** an exact lookup per model ID, cache
writes split by 5-minute and 1-hour TTL. Unknown models are shown as `price
unknown` instead of guessed — their tokens are still counted. On a
subscription, the dollar amount is only an API equivalent; the real signal is
the quota line.

**Where the prices come from.** No number is typed by hand. The only sources
are the official pricing pages of Anthropic, OpenAI and Google in their
Markdown form (`…/pricing.md`, Google's `…/pricing.md.txt`), each read by a
parser of its own (`src/pricing-source.ts`):

```
official pricing pages ─► parsers ─┬─► src/pricing-snapshot.ts        generated, ships with Vantage
                                   └─► ~/.vantage/pricing*.json       `vantage pricing update`
```

Only Standard prices are read (no batch, flex or priority rates). OpenAI's
long-context rates count where the page names the limit (`gpt-5.5 (<272K
context length)`), Google's where a cell reads `prompts <= 200k`; a request is
priced by its own prompt size. A price a page announces for a later day
(`$0.75 through December 31, 2026. $1.50 starting January 1, 2027.`) is kept
with its date and applies from that day on. OpenAI and Google list no separate
cache-write price (writes cost input) and leave out some cached-input prices
(full input then), so their plausibility check only requires the order loosely.

- `vantage pricing` shows the prices in use, their date and their source.
- `vantage pricing update` fetches the current lists — **only when you run it**.
  Vantage never downloads anything on its own; a meter that creates traffic
  unasked would defeat its purpose.
- When both are present, the **newer** source wins per model: a fresh update
  beats an old release, a new release beats an old update.
- The parser is strict: columns are found by heading, not position, every price
  must read `$X / MTok`, and every row must pass a plausibility check (cache
  read < input < 5m write < 1h write, output > input — which catches swapped
  columns; for OpenAI and Google only loosely, see above). If a page format
  changes, it fails and writes nothing — never wrong numbers in the meter.
- When a model without a price shows up, or the list is older than 60 days, the
  end of the session says so in one line.
- A weekly CI job (`Pricing`, on Mondays) keeps the bundled list current with no
  one involved: when a price changed or a model was added, it regenerates the
  list, runs the type check and the tests, and commits straight to the default
  branch. Models the page no longer lists stay in, so old sessions keep their
  prices. It changes nothing and fails (GitHub sends a mail) when the page no
  longer parses, a price moves by more than 10x, or the tests fail — those
  need a person. For this, the tests price against a fixed test list
  (`test/price-fixture.ts`), not the real prices.

Close to a limit, Vantage warns clearly — **once** when the threshold is crossed
(no spam), re-armed after the reset — and reports acute cases (`rejected`,
`retry-after`) right away:

```
[vantage] warning: 5-hour limit 92% used — getting close (resets in 18m)
```

The threshold is set with `VANTAGE_QUOTA_WARN` (percent `80` or fraction `0.8`,
default 90%). For diagnosis, `VANTAGE_DEBUG=1` logs the upstream status,
content type, encoding and all rate-limit headers.

## Budget

A warning alone does not stop a session. With a budget, Vantage steps in:

```
vantage run --max-cost 2 claude       # from ~$2 estimated session cost
vantage run --max-quota 80 claude     # from 80% of a subscription window (5h or 7d)
```

Once the budget is reached, **every action needs your approval** — Claude Code
asks before the next tool call. Deliberately not a hard stop: an agent killed in
the middle of a change leaves half-written files behind. `deny` from the policy
stays `deny`. A cost budget stays reached for the session (cost never goes
down); a quota budget lifts again once the window has reset.

```
[vantage] ALERT: budget reached — session cost ~$2.03 reached the $2.00 budget. Every action now needs your approval.
```

How it works: Claude Code runs the hook as a separate process for each tool call,
sharing no memory with `vantage run`. So Vantage writes a small state file into
the session folder when the budget is reached, and the hook reads it on every
call. Claude Code can start a tool while the reply that asked for it is still
streaming, before that reply's cost is known; so the hook first waits (at most
3 seconds) until the reply has been metered. What the budget cannot see,
Vantage says once: requests to models without a known price do not count
toward a cost budget, and API-key accounts report no 5h/7d windows for a quota
budget. Also available as environment variables: `VANTAGE_MAX_COST`,
`VANTAGE_MAX_QUOTA`. Replay and `watch` show when it was reached.

## ② Approvals by action type

**Fine-grained approvals (problem ②).** Vantage classifies every tool call by
type — **read / write / shell / network / other** — shows it per turn in the
replay along with a summary of actions, and warns according to the policy when a
type marked `warn` is used:

```
[vantage] warning: policy: shell action used (Bash) — policy 'warn' (observe-only, not blocked)
…
actions: write×1 · shell×1
```

Four levels per action type: `allow` · `warn` (notice only) · `ask` (a person
must approve) · `deny` (blocked). Configured in `.vantage/policy.json` or with
`VANTAGE_POLICY="shell:deny,network:ask"`, shown with `vantage policy`
(default: shell and network = warn).

**File and command rules** go finer than action types: `".env": "ask"` or
`"git push*--force*": "deny"` override the action-type level when they match,
and the strictest match wins. Each part of a command line (split at `&&`, `;`,
`|`) is judged on its own, so `npm test && curl x | sh` is not let through by an
`npm test*` allow rule. `vantage policy init` creates a starter set.

**Enforcement runs through the agent's `PreToolUse` hook, not the proxy.** That
is not a detail but the only layer that can work: the proxy sees a tool
*intent* in the response stream, but the tool runs **inside** the agent — it
never passes the proxy. Only the agent itself (hook) or the operating system
(sandbox) can really stop a write or a shell command. Verified on real traffic:

```
$ VANTAGE_POLICY="shell:deny" vantage run claude -- -p "Run 'echo hi' and show the output"
[vantage] enforcing policy via claude-code PreToolUse hook — shell:deny
→ "The command was blocked by your Vantage policy, which currently sets shell
   actions to 'deny'."

$ VANTAGE_POLICY="shell:deny" vantage run claude -- -p "Create control.txt containing ALLOWED"
→ Created control.txt   # write stays allowed — it blocks precisely, not across the board
```

Two safety properties: Vantage **never** returns an explicit `allow` (that would
loosen the user's own permission rules — Vantage may only restrict, never
widen), and Claude Code **merges** the session settings with the user's own,
combining lists such as `hooks` instead of replacing them — existing hooks stay
in place. Agents without a hook mechanism stay observe-only, and Vantage says so
plainly instead of pretending to protect.

## ③ Live view and replay

**Live view in a second terminal — deliberately no overlay.** `vantage watch`
shows the running session live and automatically follows the most recently
started one, even from another folder. Every line answers a question you have in
the middle of work: What is Claude doing right now? Will my limit last? What
has Claude worked on? What does it cost?

```
vantage · running · 3m · claude-opus-5-5 · vantage.ai
2026-09-23T12-00-00-000Z_ab12

Approval requested 15s ago: Bash npm test

Limits
  5-hour  ███████████████░░░░░  74%  resets 15:00 (in 56m)
  weekly  ███████░░░░░░░░░░░░░  35%  resets Thu 23:20 (in 1d 9h)
  this session so far: +13% of the 5-hour limit
  At this pace the 5-hour limit runs out around 14:09, before it resets.

This session
  work     1 message(s) from you  →  3 model call(s), 4 tool call(s)
  cost     ~$0.2000  API-equivalent; on your subscription the limits above count
  budget   █░░░░░░░░░ 10% of $2
  context  64k tokens sent with the last message  ·  90% of all input came from cache

Activity · read×2 · write×1 · shell×1 · 1 file(s) edited
  14:00:09          Read      src/net/fetch.ts
  14:00:09          Grep      fetchWithRetry
  14:00:40          Edit      src/net/fetch.ts
  14:03:20  asked   Bash      npm test
```

- **Status:** "Claude is thinking…" (a request is in flight), "Claude is
  working: Edit src/app.ts" (running tools), "Approval requested 15s ago" (an
  `ask` rule or a budget asked you), "Claude replied".
- **Limits:** bars in green/yellow/red, the reset as a time of day, this
  session's share, and a forecast: does the current pace last until the reset?
  The windows apply to the whole account, so other Claude use counts too.
- **work:** your messages against model calls — Claude calls the model again
  after every tool. Claude Code's own background calls (such as "is the agent
  done?") count toward cost, not as a turn.
- **context:** how many tokens were sent with the last message, and how much of
  all input came from the cache (cheap).
- **Several sessions:** when several run at once, `vantage watch` shows an
  overview — the limits once (they apply to the whole account), below them each
  session with status, cost and messages. `vantage watch <id>` shows one of them
  in detail, from any folder. Running means: no session end in the log and the
  `vantage run` process is still alive — so crashed sessions do not show as
  running.
- **Activity:** the latest tool calls with file, command or URL — relative to the
  project — marked when Vantage blocked (`blocked`) or asked (`asked`).

Why no overlay on top of the agent? The agent owns its terminal (`stdio:
"inherit"`) and brings its own TUI. An overlay would mean Vantage takes over and
redraws — exactly the breaking point from concept §6b ("observe, don't
re-render") that can wreck the wrapped tool's UI. So the live view runs in its
own terminal or tmux pane, fed from the append-only event log: **no risk to the
agent's terminal, no dependencies.**

Taken to its conclusion, that means: while Claude Code's chat UI is open,
`vantage run` writes **nothing** into that terminal. An earlier version printed
a status line after every reply; it landed somewhere in the UI, covered the
input box and vanished at the next redraw. Now routine lines are gone (they are
in `vantage watch`), and alerts — secrets, quota, budget, policy — appear **in
Claude Code's chat itself**, right after the reply:

```
● DONE
  ⎿  Stop says: Vantage ALERT: a value of DB_PASSWORD (Xk9v…(12 chars)) was sent
     to the API, from the output of Read .env — rotate it if it should not leave
     your machine
```

For this, `vantage run` registers a `Stop` hook in interactive mode, which
Claude Code starts after every finished reply. `vantage run` posts each alert to
an outbox in the session folder (`outbox.jsonl`); the hook takes them and
returns them as a `systemMessage` — Claude Code's official way of showing the
user something. Vantage itself never writes into the terminal. When rules or a
budget are enforced, the `PreToolUse` hook hands over waiting alerts too, so they
show before the next tool. Whatever is still in the outbox at exit is printed
then, under "during the session:". In print mode (`claude -p`) there is no UI,
and alerts go straight to the terminal as before (`src/terminal.ts`,
`src/outbox.ts`).

**Secret warnings.** Every request Claude Code sends carries the conversation so
far — including the output of every tool it ran. Vantage scans each request for
well-known key formats, private key blocks and `.env`-style assignments to names
like `PASSWORD` or `API_KEY`, and names where a find came from ("the output of
Read .env", "your message", "Claude's reply"). Only a masked prefix and the
length are kept, never the value. Parts of the conversation already scanned are
skipped, so long sessions stay cheap. UTF-16 files (as `>` and Out-File write
them in Windows PowerShell 5.1) are read like any other. Vantage warns; it does
not stop the request — holding it back would leave the secret in Claude's
history and break the session.

**Session replay (problem ③).** `vantage replay <id>` renders the event log as a
readable timeline — every turn with model/tokens/cost **and content** (last
prompt, reply text, tools called), quota history and a summary:

```
session start · agent claude-code
 +2.1s quota 5h 76% used reset 1h35m · 7d 9% used
 +3.4s turn 1 claude-sonnet-5 · in 2 · out 147 · cache 55k · $0.0385
         prompt: Create a file poem.txt with a two-line poem about the sea
         tools:  Write
 +4.3s turn 2 claude-sonnet-5 · in 2 · out 21 · cache 61k · $0.0193
         reply:  Created poem.txt with a two-line poem about the sea.
 +6.0s session end · 3 turn(s) · in 98 · out 232 · cache 122k · ~$0.0609 · exit 0
```

That shows **what** the agent intended across several steps. Prompt and reply
excerpts are stored shortened and pass a **redaction step** that removes obvious
secrets and personal data (email addresses, API keys, bearer tokens, JWTs)
before they are written to the event log (concept §6d).

`vantage stats` sums up usage by day and project across all sessions on this
machine; `vantage search` finds the session that read a file, ran a command or
was asked about something.

**Kept out of the repository.** The logs contain excerpts of prompts and
replies. On the first `vantage run`, Vantage therefore creates
`.vantage/.gitignore`, which excludes `sessions/` and `worktrees/`;
`policy.json` and `memory/` stay versionable. The project's own `.gitignore` is
not touched, and an existing `.vantage/.gitignore` is left as it is.

**Cleaning up.** Each session stays under `.vantage/sessions/` until you delete
it. `vantage sessions prune` lists the sessions of this project that nothing was
written to for 30 days, with their size — they are deleted only with `--yes`.
`--older-than 12h` / `2w` changes the age, `--all` includes every project on
this machine. Never deleted: running sessions, and isolated sessions whose
worktree still exists (their branch would otherwise be left without `vantage
discard`). The index in `~/.vantage/sessions.jsonl` drops the entries whose log
no longer exists.

## ④ Change summary and git isolation

**Change summary.** In a git repository, every session ends with the files it
changed, even without isolation: Vantage takes a snapshot of the working tree
at the start and at the end (through a temporary copy of the index, so your
index and history stay untouched) and compares the two. `vantage review <id>`
lists the files again, `--patch` shows the full diff. Edits you made yourself
in the meantime are included, and the summary says so.

**Git session isolation (problem ④).** With `--isolate`, the agent works in a
dedicated git worktree on the branch `vantage/<session>` — your working directory
stays untouched. At the end, Vantage commits the changes to that branch and
shows an **aggregated diff**; then you decide to merge or discard:

```
[vantage] isolated on branch vantage/…_y6rf (base bbb2b2fc) · worktree .vantage/worktrees/…
[vantage] isolation: 1 file(s) changed, +1/-0 on vantage/…_y6rf
[vantage]   greeting.txt (+1 -0)
[vantage] review:  vantage review …_y6rf
[vantage] merge:   git merge --no-ff vantage/…_y6rf
[vantage] discard: vantage discard …_y6rf
```

## ⑤ Project memory

**Project memory (problem ⑤).** File-based under `.vantage/memory/*.md`
(versioned in git), which Vantage compiles into the agent's context before every
run and injects **without touching any file** (Claude Code:
`--append-system-prompt`). So no session starts from zero. Verified end to end:

```
$ vantage memory add conventions "Preferred one-word greeting is 'Ahoy'."
$ vantage run claude -- -p "Greet me in one word"           → Ahoy
$ vantage run --no-memory claude -- -p "Greet me in one word" → Hello!
```

The canonical store is agent-agnostic — the same context can be compiled into
each agent's native format (memory across agents).

**Harvest — assisted, not automatic.** After a session that did something,
Vantage points to `vantage harvest <id>` in *one* line. It prepares the material
and suggests a ready-made command:

```
harvest · session 2026-09-18T11-31-28-722Z_0k4i
3 turn(s) · ~$0.0604 · write×1

  what the agent said it did
    Created notes.txt containing "HARVEST".

  files changed
    notes.txt

Nothing is written automatically. Record what is worth keeping:
  vantage memory add decisions "Created notes.txt containing \"HARVEST\"."
```

Deliberately **no** automatic LLM distillation at the end of a session: it would
silently burn quota on every session — exactly problem ①, which Vantage exists to
fight — and a wrongly distilled entry poisons every future session, because
memory is injected into the context. The best summary without an LLM comes from
the agent itself anyway: its final reply.

## How Vantage finds the agent

Vantage brings no agent and no API key of its own — it starts *your* installed
Claude Code, which signs in with its own login (subscription or
`ANTHROPIC_API_KEY`); Vantage only passes that through. It looks for `claude` on
the PATH. On Windows, npm installs agents as a `claude.cmd` helper that Node
cannot start without a shell; Vantage reads from it what it calls (the native
`claude.exe` of current versions, or a JS script) and starts that directly —
without a shell, so that prompt and memory text are not interpreted by cmd.exe.
If the agent lives elsewhere:

```powershell
$env:VANTAGE_AGENT_PATH = "C:\path\to\claude.exe"
vantage run claude
```

`vantage doctor` checks all of this once: Node.js, Claude Code, the approval
hook (run exactly as Claude Code starts it), git, the settings folder, the rules
file and the age of the price list.

## Architecture

`vantage demo` runs the whole chain: environment injection → agent spawn →
proxy → live meter → event log. Thanks to Node's type stripping it runs without
a build step; a `dist/` build (`npm run build`) is what gets distributed.

**Claude Code only for now — extensible.** Behind the proxy sits a provider
layer: a provider only says which paths carry a turn and how to parse its
streaming/JSON format. Everything above it (meter, event log, replay, policy,
quota) works on a normalized form. Only `anthropic` is active (`/v1/messages`,
SSE `message_start`/`message_delta`), verified against real
`api.anthropic.com` traffic. Adapters for Codex CLI and Aider existed; but they
could only measure, were never tested against the real tools, and were removed
rather than shipped half-done (see the git history). Another agent is an
addition — no change to the core.

### Layout

| Path | Role |
|------|------|
| `src/proxy.ts` | Transparent streaming reverse proxy (layer B) |
| `src/usage.ts` | The token usage of one model call |
| `src/meter.ts` | Aggregated totals, rate and status line |
| `src/ratelimit.ts` | Rate-limit headers → limit forecast (unified and classic) |
| `src/upstream.ts` | Egress connector (`HTTPS_PROXY`/`NO_PROXY`, CONNECT tunnel) |
| `src/events.ts` | Append-only event log (JSONL) |
| `src/git.ts` | Git session isolation (worktree/branch, aggregated diff) and working-tree snapshots |
| `src/replay.ts` | Session replay: event log → timeline, and the session list |
| `src/watch.ts` | Live view for the second terminal (follows the event log) |
| `src/turn.ts` | Reads each response — tokens, reply, tools — and the prompt, with redaction |
| `src/memory.ts` | Project memory (`.vantage/memory/`, compiling and injecting it) |
| `src/harvest.ts` | Assisted harvest: session material → memory suggestion |
| `src/policy.ts` | Action-type classification and policy levels (②) |
| `src/hook.ts` | PreToolUse enforcement (ask/deny) through the agent's hook |
| `src/budget.ts` | Budget guard (`--max-cost` / `--max-quota`) |
| `src/rules.ts` | Rules for specific files and commands (`.vantage/policy.json`) |
| `src/secrets.ts` | Detection of secrets sent to the API, with their source |
| `src/home.ts` | `~/.vantage`: session index, last session, is a session still running? |
| `src/stats.ts`, `src/search.ts` | `vantage stats` and `vantage search` across all sessions |
| `src/doctor.ts` | `vantage doctor`: checks the setup |
| `src/banner.ts` | The logo shown by `vantage`, `--help` and `doctor` |
| `src/terminal.ts` | Holds output back while Claude Code's chat UI is open |
| `src/outbox.ts` | Outbox for alerts that the Stop hook shows in Claude Code's chat |
| `src/resolve.ts` | Finds the agent's executable (including npm `.cmd` shims on Windows) |
| `src/pricing.ts`, `src/pricing-source.ts`, `src/pricing-snapshot.ts` | Prices: lookup, parsers of the official lists, generated snapshot |
| `src/providers/` | Provider layer (Anthropic only for now) behind an interface |
| `src/agents/` | Agent adapters (Claude Code only for now) |
| `src/cli.ts` | Entry point: help and dispatch to the commands |
| `src/commands/` | One module per command (`run`, `watch`, `sessions`, `pricing`, …) and the shared terminal output |
| `src/session-meta.ts` | A session's metadata (isolation, working-tree snapshots) |
| `src/prune.ts` | `vantage sessions prune`: what is deleted, what stays |
