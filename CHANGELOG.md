# Changelog

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
