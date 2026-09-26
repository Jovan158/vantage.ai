# Changelog

## 0.2.0 — 2026-09-25

### Four more agents
`vantage run` now starts Codex, GitHub Copilot CLI, OpenCode and pi as well as Claude Code — `vantage run codex`, `vantage run copilot`, and so on. What works with each is in the README under *Supported agents*.

- **Tokens and activity** for every agent. The proxy now reads the OpenAI Responses and Chat Completions APIs and the Gemini API besides Anthropic's, serves several providers in one session, and passes Codex's WebSocket through while reading it.
- **Usage limits of a ChatGPT plan**: Codex's 5-hour and weekly windows appear in `vantage watch`, warn before they run out, and work with `--max-quota`.
- **Rules and budgets** for all five agents, through each one's own hooks. Codex and OpenCode can block but not ask from a hook: there an `ask` rule blocks and tells the agent to leave the action to you.
- **Project memory** reaches Codex, Copilot CLI, OpenCode and pi too. Settings files stay untouched: hooks and memory are passed to each session on its own.
- **`vantage doctor`** lists every agent it knows and whether it is installed; `vantage doctor <agent>` checks one.
- Secret warnings, `watch`, `replay` and `search` name the agent that ran the session.

### Prices for GPT and Gemini models
- The cost estimate now covers GPT and Gemini models as well as Claude, at OpenAI's and Google's official list prices, whichever agent calls them. Like Anthropic's, both lists are read from the official pages by a parser that checks every price; a copy ships with Vantage and the weekly price workflow keeps it current.
- Prices that depend on the prompt size (OpenAI's long-context rates, Google's above 200K tokens) are applied per request, and a price change a page announces for a later day applies from that day on.
- Model names as other agents write them find their price: `claude-sonnet-4.6` (Copilot), `anthropic/claude-opus-5` (OpenCode), dated snapshots like `gpt-5.4-mini-2026-03-17`.
- `vantage pricing [show|update|check] [anthropic|openai|google]` works with all three lists; `vantage pricing openai` shows one.
- Models on none of the lists (DeepSeek, Mistral, local models) are still metered, with the cost shown as unknown.

### Changed
- Only the usage limits of a subscription are shown and warned about (the 5-hour and weekly windows). The per-minute limits of an Anthropic API key are no longer read: they refill within seconds, the agent waits them out by itself, and the warning fired often on small API tiers. With a quota budget on an API key, Vantage now says after two requests that there are no windows to watch, for every provider.

## 0.1.3 — 2026-09-25

### Security
- Text from outside — file names, commands, prompts, replies, tool output — could carry terminal control sequences, and `vantage watch`, `replay`, `search`, `stats` and the session summary printed them as they were. A file with such a sequence in its name could change the terminal window's title, clear the screen, hide or fake lines, and in terminals that allow it write to the clipboard. Vantage now removes control sequences from everything it prints that it did not write itself, as Claude Code does in its own UI.

### Package
- About half the size: the package no longer ships source maps, type declarations or the design documents (54 files instead of 149). Vantage is a command, not a library, so nothing used them.

## 0.1.2 — 2026-09-25

No changes to how Vantage works. 0.1.1 was published from a checkout that did not have its changes yet; 0.1.2 carries them:

- The new README: what Vantage does for you, a screenshot of `vantage watch`, a FAQ, and how to contribute.
- Files in the package use Unix line endings, also when the package is built on Windows.

## 0.1.1 — 2026-09-25

No changes to how Vantage works. The published package missed the README and line-ending changes below; they arrived in 0.1.2.

- A new README: what Vantage does for you, a screenshot of `vantage watch`, a FAQ, and how to contribute.
- The package description is the slogan alone: "See and control what your coding agent does".
- Files in the package use Unix line endings, also when the package is built on Windows.

## 0.1.0 — 2026-09-25

First public release. Vantage runs Claude Code through a local proxy and its own
hooks, without changing it.

### Cost and limits
- Live token count and estimated cost at Anthropic's official list prices, with
  cache reads and 5-minute/1-hour cache writes priced separately.
- Your subscription's 5-hour and weekly quota, a forecast of whether the current
  pace lasts until the reset, and a warning before you hit the limit.
- Budgets: `--max-cost` and `--max-quota` make every action need your approval
  once reached.
- Prices come from the official pricing page: a copy ships with Vantage, and
  `vantage pricing update` fetches the current one.

### Approvals
- Allow, warn, ask or deny by action type: read, write, shell, network.
- Rules for specific files and commands in `.vantage/policy.json`, such as
  `".env": "ask"` or `"git push*--force*": "deny"`; `vantage policy init`
  creates a starter set.

### Seeing what happened
- `vantage watch`: live view in a second terminal — what Claude is doing, limits,
  cost, recent tool calls; several running sessions side by side.
- Alerts (secrets, quota, budget) appear in Claude Code's chat right after the
  reply.
- Secret warnings: API keys, private keys and passwords sent to the API are
  reported with where they came from. Only a masked prefix is kept.
- `vantage replay`, `vantage stats`, `vantage search` and `vantage sessions`
  (with `prune` for old sessions).

### Changes and memory
- In a git repository, every session ends with the files it changed;
  `vantage review` shows them or the full diff.
- `--isolate` runs Claude Code in a separate git worktree and branch;
  `vantage discard` drops it.
- Project memory in `.vantage/memory/`, given to Claude Code at every start;
  `vantage harvest` suggests what to record.

### Setup
- `vantage doctor` checks Node.js, Claude Code, the approval hook, git, the rules
  file and the price list.
- Tested on Windows and Linux, including npm's `claude.cmd` shim on Windows.
- Session logs stay out of git through `.vantage/.gitignore`.
