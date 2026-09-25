<h1 align="center">
  <img width="65%" alt="vantage.ai" src="images/vantage.ai.jpg" />
</h1>

<p align="center">
  <b>See and control what your coding agent does.</b><br>
  Live cost and limits, approvals for files and commands, secret warnings and a record of every session.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jovan158/vantage"><img alt="npm" src="https://img.shields.io/npm/v/@jovan158/vantage"></a>
  <a href="https://github.com/Jovan158/vantage.ai/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Jovan158/vantage.ai/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <a href="https://nodejs.org"><img alt="Node.js 22.6+" src="https://img.shields.io/badge/node-%E2%89%A522.6-brightgreen"></a>
</p>

Vantage is a free, open-source cost and usage monitor, guardrail and session log for [Claude Code](https://code.claude.com/docs). Start Claude Code with `vantage run claude` and work as usual: Vantage shows what the session costs and how much of your limit is left, asks before Claude touches the files and commands you care about, warns you when a secret is sent to the API, and records everything so you can look back.

**Everything stays on your machine.** Vantage sends no telemetry and changes nothing in Claude Code. The only request it makes on its own is `vantage pricing update`, and only when you run it.

## Why

- **Limits arrive without warning.** You find out you hit the 5-hour limit when Claude stops mid-task. Vantage shows your quota live, forecasts whether your pace lasts until the reset, and warns you before you hit it.
- **"Allow everything" or "ask every time".** Vantage lets you allow `npm test`, ask before `git push --force`, and ask before anything reads `.env`.
- **Secrets leave your machine silently.** When Claude reads a `.env` file, the password goes to the API with the next request. Vantage tells you right away what it was and where it came from, so you can rotate it.
- **What did it actually do?** After a long session it is hard to tell what changed. Vantage ends every session with the files it changed and keeps a searchable timeline of prompts, replies and tool calls.

## Features

- **Cost and limits, live.** Tokens, estimated cost at Anthropic's official list prices, and your subscription's 5-hour and weekly quota with a forecast.
- **Budgets.** Past a cost or quota limit you set, every action needs your approval.
- **Approvals by action type, file and command.** Allow, warn, ask or deny file reads, writes, shell commands and network access, or specific files and commands.
- **Alerts in the chat.** Secret warnings, low quota and budgets appear in Claude Code's chat, right after the reply.
- **Live view.** `vantage watch` in a second terminal shows what Claude is doing, from any folder, and several sessions side by side.
- **Session replay, stats and search.** Every prompt, reply and tool call as a timeline; usage over days and projects; find the session that read a file or ran a command.
- **Change summary.** In a git repository, every session ends with the files it changed. Or run fully isolated in a separate git worktree.
- **Project memory.** Decisions and conventions in `.vantage/memory/`, given to Claude Code at every start.

## Install

```bash
npm install -g @jovan158/vantage
```

Needs Node.js 22.6 or newer and Claude Code, installed and logged in with a subscription or an API key — Vantage uses that login and needs no key of its own.

## Quick start

```bash
vantage doctor          # check the setup once
vantage policy init     # optional: recommended rules, e.g. ask before reading .env
vantage run claude      # use this instead of `claude`
vantage watch           # live view, in a second terminal
```

The guide below explains each part: [Start a session](#start-a-session) · [Watch it live](#watch-it-live) · [Alerts in the chat](#alerts-in-the-chat) · [Approval rules](#approval-rules) · [Budgets](#budgets) · [Secret warnings](#secret-warnings) · [Look back](#look-back) · [Review what changed](#review-what-changed) · [Project memory](#project-memory) · [Prices](#prices) · [Troubleshooting](#troubleshooting) · [Reference](#reference)

## Guide

### Start a session

Open a terminal in your project and run `vantage run claude` instead of `claude`. Claude Code starts as usual, with your login, your settings and your own hooks; Vantage runs alongside it. Everything after `--` is passed on to Claude Code:

```bash
vantage run claude                                   # the interactive chat
vantage run claude -- --model claude-opus-5-5        # any Claude Code option
vantage run claude -- -p "fix the failing test"      # print mode, one prompt
```

When Claude Code exits, Vantage sums up the session: requests, tokens, estimated cost, your quota, and — in a git repository — the files that changed. Each session has an id (like `2026-09-25T13-01-30-311Z_4i4f`); `vantage sessions` lists them, and the commands below take it to look back at one.

### Watch it live

Open a second terminal, anywhere, and run `vantage watch`. It follows the session you started last, even in another folder, and updates twice a second.

<p align="center">
  <img alt="vantage watch: what Claude is doing, the 5-hour and weekly limits, the session's cost and every tool call" src="images/watch.png" width="90%">
</p>

- **Status** — what Claude is doing right now: thinking, working on a tool (with the file or command), waiting for your approval, or replied.
- **Limits** — your 5-hour and weekly quota as bars, when each resets, how much of it this session used, and whether your current pace lasts until the reset. The limits belong to your whole Claude account, so other use counts too.
- **This session** — your messages against the model calls they caused, the estimated cost, a budget if you set one, and how many tokens the last message sent (and how much came from the cache).
- **Activity** — the latest tool calls with the file, command or URL they touched, marked `asked` or `blocked` when a rule stepped in.

With several sessions running, `vantage watch` shows them side by side, with the limits once for all of them; `vantage watch <id>` shows one in detail. `Ctrl-C` stops watching — Claude keeps running.

### Alerts in the chat

While Claude Code's chat is open, Vantage never writes into its terminal. Alerts appear in the chat itself, right below Claude's reply, as `Vantage: …` or `Vantage ALERT: …`:

- a secret was sent to the API (see [Secret warnings](#secret-warnings))
- a quota window reached 90% (change the threshold with `VANTAGE_QUOTA_WARN`), or a limit was reached and requests are blocked
- your budget was reached
- an action type set to `warn` was used for the first time in this session

Each alert comes once. Alerts still waiting when Claude Code exits are printed then; in print mode (`-p`) they are printed right away.

### Approval rules

Without any setup, Vantage only notices: shell commands and network access are `warn` (a note, nothing is blocked) and everything else is `allow`. To have Claude Code ask you first, or to block something outright, create rules for your project:

```bash
vantage policy init     # writes .vantage/policy.json with recommended rules
vantage policy          # shows the rules in effect
```

The starter rules ask before `.env` files, `git push --force`, `git reset --hard`, `git clean`, `rm -rf` and `npm publish`, and block private keys (`*.pem`, `*.key`, SSH keys). Edit the file to fit your project — the rules are yours:

```json
{
  "shell": "warn",
  "network": "ask",
  "files":    { ".env": "ask", "*.pem": "deny" },
  "commands": { "git push*--force*": "ask", "npm publish*": "ask", "npm test*": "allow" }
}
```

- **Action types:** `read` (Read, Grep, Glob), `write` (Edit, Write), `shell` (Bash), `network` (WebFetch, WebSearch and MCP tools) and `other`.
- **Levels:** `allow` (Vantage stays out), `warn` (a note in the chat), `ask` (Claude Code asks you before the action) and `deny` (blocked; Claude is told why).
- **File and command rules** override the action type when they match, and the strictest match wins. So `"shell": "ask"` together with `"npm test*": "allow"` lets tests run without asking and asks before every other command.

A few rules people often want:

| Goal | Rule |
| --- | --- |
| Never let Claude read secrets | `"files": { ".env*": "deny", "secrets/**": "deny" }` |
| Ask before every shell command, except tests | `"shell": "ask", "commands": { "npm test*": "allow" }` |
| Ask before anything goes to the internet | `"network": "ask"` |
| Ask before database migrations | `"commands": { "*migrate*": "ask" }` |

The file lives in the project's `.vantage/` folder: commit it, and your whole team works with the same rules. For a single session, `VANTAGE_POLICY="shell:deny,network:ask" vantage run claude` overrides the action types. `allow` never widens what Claude Code itself permits; Vantage can only make it stricter.

<details>
<summary>How file and command patterns match</summary>

A file pattern without `/` matches the name anywhere, with `/` the path from the project root; `*` stays within a name, `**` spans directories. File rules also catch files named in shell commands (`cat .env`). Command patterns match each part of a command line on its own (split at `&&`, `;`, `|`), so `npm test && curl x | sh` is not let through by an `npm test*` rule. Rules are guardrails, not a sandbox: a command assembled at run time can get past them.

</details>

### Budgets

```bash
vantage run --max-cost 2 claude       # from about $2 of estimated cost
vantage run --max-quota 80 claude     # from 80% of the 5-hour or weekly window
```

Once a budget is reached, every action needs your approval — Claude Code asks before each tool call, so you decide whether the session goes on. It is deliberately not a hard stop, which could leave files half-written. A cost budget stays reached for the rest of the session; a quota budget lifts again when the window resets. Requests to models without a known price do not count toward a cost budget, and API-key accounts have no quota windows; Vantage says so when it happens. The same budgets can be set with `VANTAGE_MAX_COST` and `VANTAGE_MAX_QUOTA`.

### Secret warnings

Every request Claude Code sends carries the conversation so far, including the output of every tool. Vantage checks each request for API keys (Anthropic, OpenAI, AWS, GitHub, Slack, Stripe, Google), private keys, and `.env`-style assignments to names like `PASSWORD`, `SECRET`, `TOKEN` or `API_KEY`, and tells you what was sent and where it came from — for example *"a value of DB_PASSWORD (Xk9v…(12 chars)) was sent to the API, from the output of Read .env"*.

The secret has already left your machine at that point, so rotate it if it matters. To keep it from happening again, add a rule such as `"files": { ".env*": "deny" }`. Vantage never stores the secret itself — only its kind, a masked prefix and where it came from.

### Look back

```bash
vantage sessions                      # the sessions of this project
vantage replay <id>                   # one session as a timeline: prompts, replies, tools, cost
vantage stats                         # usage by day and project, last 7 days
vantage stats --days 30
vantage search "npm publish"          # which session did this?
vantage search .env --files           # only file names
vantage search migrate --commands     # only commands
```

`stats`, `search` and `replay <id>` cover every project on this machine, not only the current one. Sessions add up over time: `vantage sessions prune` lists the ones nobody touched for 30 days, with their size, and deletes them only with `--yes` (`--older-than 12h` / `2w` changes the age, `--all` includes every project).

### Review what changed

In a git repository, every session ends with a list of the files it changed — including edits you made yourself meanwhile, so it says so. Later:

```bash
vantage review <id>             # the files, with lines added and removed
vantage review <id> --patch     # the full diff
```

`vantage review` also prints the command that undoes the session's changes. Your git index and history are never touched.

To keep Claude away from your working copy entirely, use `vantage run --isolate claude`. Claude then works in a separate git worktree on its own branch, `vantage/<id>`. At the end, Vantage commits the work to that branch and shows what changed; you decide what happens to it:

```bash
vantage review <id>                        # what changed
git merge --no-ff vantage/<id>             # take it
vantage discard <id>                       # or throw it away
```

### Project memory

Claude Code forgets everything between sessions. Project memory is a few Markdown files that Vantage gives to Claude Code at the start of every session:

```bash
vantage memory init                                   # creates .vantage/memory/: architecture, conventions, decisions, glossary
vantage memory add decisions "Use Postgres, not SQLite"
vantage memory show                                   # what Claude Code will get
vantage run --no-memory claude                        # a session without it
```

Edit the files directly, too; commit them to share them with your team. After a session that changed something, `vantage harvest <id>` suggests what might be worth recording — nothing is written without you.

### Prices

The cost is an estimate: the tokens of each request at Anthropic's official list price, including cache reads and writes. On a Pro or Max subscription you do not pay per token — there, the quota bars are what counts. A copy of the price list ships with Vantage; `vantage pricing` shows the prices in use and their date, and `vantage pricing update` fetches the current official list. Vantage never fetches anything unless you run that command.

### Troubleshooting

- **Start with `vantage doctor`.** It checks Node.js, Claude Code, the approval hook (run exactly as Claude Code runs it), git, your rules file and the price list, and says what to do about anything that fails.
- **"Claude Code not found":** set `VANTAGE_AGENT_PATH` to the Claude Code executable, for example `$env:VANTAGE_AGENT_PATH = "C:\path\to\claude.exe"` in PowerShell.
- **No change summary:** the folder is not a git repository, or it has more than 2000 untracked files — add build output and dependencies to `.gitignore`.
- **A rule does not apply:** `vantage policy` shows the rules as Vantage reads them; a file that is not valid JSON is ignored, and `vantage doctor` says so.
- **Numbers look wrong:** `VANTAGE_DEBUG=1 vantage run claude` logs what the API returns, including the rate-limit headers.
- **Found a bug?** [Open an issue](https://github.com/Jovan158/vantage.ai/issues/new/choose) with the output of `vantage doctor`.

## Reference

| Command | Description |
| --- | --- |
| `vantage run [options] claude [-- args]` | Start Claude Code through Vantage |
| `vantage watch [id]` | Live view: all running sessions side by side, or one in detail |
| `vantage sessions` | List past sessions |
| `vantage sessions prune [--older-than 30d] [--all] [--yes]` | Delete old sessions (lists them first; `--yes` deletes) |
| `vantage stats [--days N]` | Usage by day and project, and the largest sessions |
| `vantage search <text> [--files \| --commands]` | Which session did what: messages, files, commands, blocks |
| `vantage replay <id>` | A session as a timeline |
| `vantage review <id> [--patch]` | Files a session changed, or the full diff |
| `vantage discard <id>` | Discard an isolated session's worktree and branch |
| `vantage memory init` · `add <category> <text>` · `show` | Manage project memory |
| `vantage harvest [id]` | Suggest what to remember from a session |
| `vantage policy` · `vantage policy init` | Show the rules in effect · create a starter rule file |
| `vantage pricing` · `vantage pricing update` | Show prices · fetch the current official list |
| `vantage doctor` | Check the setup: Claude Code, hook, git, rules, prices |

Options for `run`:

| Option | Description |
| --- | --- |
| `--isolate` | Work in a separate git worktree and branch |
| `--no-memory` | Don't pass project memory to Claude Code |
| `--max-cost <usd>` | Ask before every action once the estimated cost reaches this |
| `--max-quota <percent>` | The same, once a quota window is this full |

Environment variables:

| Variable | Description |
| --- | --- |
| `VANTAGE_POLICY` | Override the action-type levels for one session, e.g. `shell:deny,network:ask` |
| `VANTAGE_MAX_COST`, `VANTAGE_MAX_QUOTA` | Budget, same as the `run` options |
| `VANTAGE_QUOTA_WARN` | Quota warning threshold in percent (default 90) |
| `VANTAGE_AGENT_PATH` | Path to Claude Code if it is not found on `PATH` |
| `VANTAGE_HOME` | Where Vantage keeps its own files (default `~/.vantage`) |
| `VANTAGE_DEBUG=1` | Log upstream status and rate-limit headers |

### How it works

`vantage run` starts Claude Code with `ANTHROPIC_BASE_URL` pointing at a local proxy, which forwards every request unchanged and reads token usage and rate-limit headers from the responses. Approvals and budgets go through Claude Code's own `PreToolUse` hook, because tools run inside Claude Code and never pass the proxy; alerts reach the chat through its `Stop` hook.

Each session is recorded in the project's `.vantage/sessions/`, including excerpts of prompts and replies; Vantage keeps that folder out of git with its own `.vantage/.gitignore`, so rules and project memory can still be committed. The price list and the index that `watch`, `stats` and `search` use across projects are kept in `~/.vantage`.

## FAQ

**Is it free?** Yes. Vantage is open source under the MIT license.

**Does it work with a Claude Pro or Max subscription?** Yes, and with API keys. On a subscription, the quota bars are what counts; the cost is shown as what the same use would cost on the API.

**Does it slow Claude Code down?** The proxy streams responses through as they arrive, without buffering. When rules or a budget are active, each tool call is checked by a short-lived process (about a tenth of a second); in the interactive chat, one also runs after each reply to show alerts.

**Does it change my Claude Code setup?** No. Hooks and memory are passed to each session on the command line; your settings files stay untouched, and your own hooks keep working.

**Which agents does it support?** Claude Code for now. The proxy and the rules are built so that other agents can be added.

**How do I remove it?** `npm uninstall -g @jovan158/vantage`. To remove its data as well, delete `~/.vantage` and the `.vantage` folders in your projects.

## Contributing

Issues and pull requests are welcome. To work on Vantage, clone the repository, run `npm install` and `npm test`; Node.js runs the TypeScript source directly, without a build step. `vantage demo` runs the whole chain against a mock API, without Claude Code or an account. Please report security issues privately through the repository's *Security* tab rather than in a public issue. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
