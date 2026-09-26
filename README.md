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

Vantage is a free, open-source cost and usage monitor, guardrail and session log for coding agents. Start your agent with `vantage run <agent>` and work as usual: Vantage shows what the session costs and how much of your limit is left, asks before the agent touches the files and commands you care about, warns you when a secret is sent to the API, and records everything so you can look back.

**Everything stays on your machine.** Vantage sends no telemetry and changes nothing in your agent's setup. The only request it makes on its own is `vantage pricing update`, and only when you run it.

## Why

- **Limits arrive without warning.** You find out you hit the 5-hour limit when the agent stops mid-task. Vantage shows your quota live, forecasts whether your pace lasts until the reset, and warns you before you hit it.
- **"Allow everything" or "ask every time".** Vantage lets you allow `npm test`, ask before `git push --force`, and ask before anything reads `.env`.
- **Secrets leave your machine silently.** When the agent reads a `.env` file, the password goes to the API with the next request. Vantage tells you right away what it was and where it came from, so you can rotate it.
- **What did it actually do?** After a long session it is hard to tell what changed. Vantage ends every session with the files it changed and keeps a searchable timeline of prompts, replies and tool calls.

## Features

- **Cost and limits, live.** Tokens, estimated cost at the official list prices of Anthropic, OpenAI and Google, and the 5-hour and weekly quota of a Claude or ChatGPT subscription with a forecast.
- **Budgets.** Past a cost or quota limit you set, every action needs your approval.
- **Approvals by action type, file and command.** Allow, warn, ask or deny file reads, writes, shell commands and network access, or specific files and commands.
- **Alerts in the chat.** Secret warnings, low quota and budgets appear in the agent's chat, right after the reply.
- **Live view.** `vantage watch` in a second terminal shows what the agent is doing, from any folder, and several sessions side by side.
- **Session replay, stats and search.** Every prompt, reply and tool call as a timeline; usage over days and projects; find the session that read a file or ran a command.
- **Change summary.** In a git repository, every session ends with the files it changed. Or run fully isolated in a separate git worktree.
- **Project memory.** Decisions and conventions in `.vantage/memory/`, given to the agent at every start.

## Install

```bash
npm install -g @jovan158/vantage
```

Needs Node.js 22.6 or newer and at least one of the agents below, installed and logged in — Vantage uses that login and needs no key of its own.

## Quick start

```bash
vantage doctor          # check the setup once: which agents are there
vantage policy init     # optional: recommended rules, e.g. ask before reading .env
vantage run claude      # use this instead of `claude` — or codex, copilot, opencode, pi
vantage watch           # live view, in a second terminal
```

## Supported agents

| Agent | Start with | Tokens and cost | Usage limits | Rules that ask | Alerts in its chat |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `vantage run claude` | yes | 5-hour and weekly | ask | yes |
| Codex | `vantage run codex` | yes | 5-hour and weekly (ChatGPT plan) | block instead | yes |
| Copilot CLI | `vantage run copilot` | yes | – | ask | yes |
| OpenCode | `vantage run opencode` | yes | – | block instead | as a toast |
| pi | `vantage run pi` | yes | – | ask | as a notification |

- **Tokens and cost:** the cost is shown for Claude, GPT and Gemini models, whichever agent calls them; for other models (DeepSeek or Mistral through OpenCode, say) Vantage counts the tokens and says the price is unknown (see [Prices](#prices)).
- **Rules that ask:** Codex and OpenCode can block a tool call from a hook but not pause to ask. There a rule set to `ask` blocks the action, and the agent is told to leave it to you. `deny` works everywhere.

## Guide

How to use each part, step by step:

1. [Start a session](#start-a-session) — `vantage run`, passing options to the agent, the summary at the end
2. [Watch it live](#watch-it-live) — the live view, line by line
3. [Alerts in the chat](#alerts-in-the-chat) — what Vantage tells you while the agent works
4. [Approval rules](#approval-rules) — allow, warn, ask or deny by action type, file and command
5. [Budgets](#budgets) — ask before every action past a cost or quota limit
6. [Secret warnings](#secret-warnings) — what counts as a secret, and what to do
7. [Look back](#look-back) — sessions, replay, stats and search
8. [Review what changed](#review-what-changed) — the change summary, the full diff, isolated sessions
9. [Project memory](#project-memory) — decisions and conventions the agent gets at every start
10. [Prices](#prices) — where the cost estimate comes from
11. [Troubleshooting](#troubleshooting)

Also: [Reference](#reference) (commands, options, environment variables, how it works)

### Start a session

Open a terminal in your project and run `vantage run <agent>` instead of the agent itself. It starts as usual, with your login, your settings and your own hooks; Vantage runs alongside it. Everything after `--` is passed on to the agent:

```bash
vantage run claude                                   # the interactive chat
vantage run claude -- --model claude-opus-5-5        # any Claude Code option
vantage run claude -- -p "fix the failing test"      # print mode, one prompt
vantage run codex -- exec "fix the failing test"     # the same for any other agent
```

When the agent exits, Vantage sums up the session: requests, tokens, estimated cost, your quota, and — in a git repository — the files that changed. Each session has an id (like `2026-09-25T13-01-30-311Z_4i4f`); `vantage sessions` lists them, and the commands below take it to look back at one.

### Watch it live

Open a second terminal, anywhere, and run `vantage watch`. It follows the session you started last, even in another folder, and updates twice a second.

<p align="center">
  <img alt="vantage watch: what Claude is doing, the 5-hour and weekly limits, the session's cost and every tool call" src="images/watch.png" width="90%">
</p>

- **Status** — what the agent is doing right now: thinking, working on a tool (with the file or command), waiting for your approval, or replied.
- **Limits** — your 5-hour and weekly quota as bars, when each resets, how much of it this session used, and whether your current pace lasts until the reset. The limits belong to your whole Claude or ChatGPT account, so other use counts too.
- **This session** — your messages against the model calls they caused, the estimated cost, a budget if you set one, and how many tokens the last message sent (and how much came from the cache).
- **Activity** — the latest tool calls with the file, command or URL they touched, marked `asked` or `blocked` when a rule stepped in.

With several sessions running, `vantage watch` shows them side by side, with the limits once for all of them; `vantage watch <id>` shows one in detail. `Ctrl-C` stops watching — the agent keeps running.

### Alerts in the chat

While the agent's chat is open, Vantage never writes into its terminal. Alerts appear in the chat itself, right below the reply, as `Vantage: …` or `Vantage ALERT: …` — for the agents that can show them (see [Supported agents](#supported-agents)); for the others they wait until the session ends, and `vantage watch` shows them live:

- a secret was sent to the API (see [Secret warnings](#secret-warnings))
- a quota window reached 90% (change the threshold with `VANTAGE_QUOTA_WARN`), or a limit was reached and requests are blocked
- your budget was reached
- an action type set to `warn` was used for the first time in this session

Each alert comes once. Alerts still waiting when the agent exits are printed then; in print mode (`-p`) they are printed right away.

### Approval rules

Without any setup, Vantage only notices: shell commands and network access are `warn` (a note, nothing is blocked) and everything else is `allow`. To have the agent ask you first, or to block something outright, create rules for your project:

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

- **Action types:** `read` (reading and searching files), `write` (editing and creating them, patches), `shell` (commands), `network` (web fetches and searches, MCP tools) and `other`. Each agent's tools are sorted into these by name — Claude Code's `Bash`, Codex's `exec_command` and OpenCode's `bash` are all `shell`.
- **Levels:** `allow` (Vantage stays out), `warn` (a note in the chat), `ask` (the agent asks you before the action) and `deny` (blocked; the agent is told why). Where an agent cannot ask, `ask` blocks (see [Supported agents](#supported-agents)).
- **File and command rules** override the action type when they match, and the strictest match wins. So `"shell": "ask"` together with `"npm test*": "allow"` lets tests run without asking and asks before every other command.

A few rules people often want:

| Goal | Rule |
| --- | --- |
| Never let the agent read secrets | `"files": { ".env*": "deny", "secrets/**": "deny" }` |
| Ask before every shell command, except tests | `"shell": "ask", "commands": { "npm test*": "allow" }` |
| Ask before anything goes to the internet | `"network": "ask"` |
| Ask before database migrations | `"commands": { "*migrate*": "ask" }` |

The file lives in the project's `.vantage/` folder: commit it, and your whole team works with the same rules. For a single session, `VANTAGE_POLICY="shell:deny,network:ask" vantage run claude` overrides the action types. The rules are the same for every agent. `allow` never widens what the agent itself permits; Vantage can only make it stricter.

<details>
<summary>How file and command patterns match</summary>

A file pattern without `/` matches the name anywhere, with `/` the path from the project root; `*` stays within a name, `**` spans directories. File rules also catch files named in shell commands (`cat .env`). Command patterns match each part of a command line on its own (split at `&&`, `;`, `|`), so `npm test && curl x | sh` is not let through by an `npm test*` rule. Rules are guardrails, not a sandbox: a command assembled at run time can get past them.

</details>

### Budgets

```bash
vantage run --max-cost 2 claude       # from about $2 of estimated cost
vantage run --max-quota 80 claude     # from 80% of the 5-hour or weekly window
```

Once a budget is reached, every action needs your approval — the agent asks before each tool call, so you decide whether the session goes on (where an agent cannot ask, each action is blocked instead). It is deliberately not a hard stop, which could leave files half-written. A cost budget stays reached for the rest of the session; a quota budget lifts again when the window resets. Requests to models without a known price do not count toward a cost budget, and API-key accounts have no quota windows; Vantage says so when it happens. A quota budget works with Claude Code and Codex, which report their windows. The same budgets can be set with `VANTAGE_MAX_COST` and `VANTAGE_MAX_QUOTA`.

### Secret warnings

Every request an agent sends carries the conversation so far, including the output of every tool. Vantage checks each request for API keys (Anthropic, OpenAI, AWS, GitHub, Slack, Stripe, Google), private keys, and `.env`-style assignments to names like `PASSWORD`, `SECRET`, `TOKEN` or `API_KEY`, and tells you what was sent and where it came from — for example *"a value of DB_PASSWORD (Xk9v…(12 chars)) was sent to the API, from the output of Read .env"*.

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

To keep the agent away from your working copy entirely, use `vantage run --isolate claude` (or any other agent). It then works in a separate git worktree on its own branch, `vantage/<id>`. At the end, Vantage commits the work to that branch and shows what changed; you decide what happens to it:

```bash
vantage review <id>                        # what changed
git merge --no-ff vantage/<id>             # take it
vantage discard <id>                       # or throw it away
```

### Project memory

Agents forget everything between sessions. Project memory is a few Markdown files that Vantage gives to the agent at the start of every session — all five agents take it:

```bash
vantage memory init                                   # creates .vantage/memory/: architecture, conventions, decisions, glossary
vantage memory add decisions "Use Postgres, not SQLite"
vantage memory show                                   # what the agent will get
vantage run --no-memory claude                        # a session without it
```

Edit the files directly, too; commit them to share them with your team. After a session that changed something, `vantage harvest <id>` suggests what might be worth recording — nothing is written without you.

### Prices

The cost is an estimate: the tokens of each request at the model maker's official list price, including cache reads and writes.

- **Claude models** at [Anthropic's price list](https://platform.claude.com/docs/en/about-claude/pricing), **GPT models** at [OpenAI's](https://developers.openai.com/api/docs/pricing), **Gemini models** at [Google's](https://ai.google.dev/gemini-api/docs/pricing) — whichever agent calls them. Copilot's `claude-sonnet-4.6` and OpenCode's `anthropic/claude-sonnet-4-6` are the same model at the same price.
- **Standard prices**: batch, flex and priority rates are not used. Where a price depends on the prompt size (OpenAI's long-context rates above 272K tokens, Google's above 200K), the request is priced by its own size. A price change the page announces for a later day applies from that day on.
- **Other models** (DeepSeek, Mistral, local models, …): Vantage counts the tokens and shows the cost as unknown rather than guessing.
- **On a subscription** (Claude Pro or Max, ChatGPT, Copilot) you do not pay per token: the cost is what the same use would cost on the API, and the quota bars are what counts.

A copy of the three price lists ships with Vantage and is updated with each release. `vantage pricing` shows the prices in use and their date (`vantage pricing openai` one list), and `vantage pricing update` fetches the current official lists. Vantage never fetches anything unless you run that command.

### Troubleshooting

- **Start with `vantage doctor`.** It checks Node.js, every agent it knows (installed or not), the approval hook, git, your rules file and the price list, and says what to do about anything that fails. `vantage doctor codex` checks one agent.
- **"… not found":** set `VANTAGE_AGENT_PATH` to the agent's executable, for example `$env:VANTAGE_AGENT_PATH = "C:\path\to\claude.exe"` in PowerShell.
- **Copilot CLI fails under Vantage:** Vantage sends its requests to `https://api.githubcopilot.com`. If your plan uses another address, set it with `VANTAGE_UPSTREAM`.
- **No change summary:** the folder is not a git repository, or it has more than 2000 untracked files — add build output and dependencies to `.gitignore`.
- **A rule does not apply:** `vantage policy` shows the rules as Vantage reads them; a file that is not valid JSON is ignored, and `vantage doctor` says so.
- **Numbers look wrong:** `VANTAGE_DEBUG=1 vantage run claude` logs what the API returns, including the format it was read as and the rate-limit headers.
- **Found a bug?** [Open an issue](https://github.com/Jovan158/vantage.ai/issues/new/choose) with the output of `vantage doctor`.

## Reference

| Command | Description |
| --- | --- |
| `vantage run [options] <agent> [-- args]` | Start an agent through Vantage: `claude`, `codex`, `copilot`, `opencode`, `pi` |
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
| `vantage pricing [provider]` · `vantage pricing update [provider]` | Show prices · fetch the current official lists (`anthropic`, `openai`, `google`) |
| `vantage doctor [agent]` | Check the setup: agents, hook, git, rules, prices |

Options for `run`:

| Option | Description |
| --- | --- |
| `--isolate` | Work in a separate git worktree and branch |
| `--no-memory` | Don't pass project memory to the agent |
| `--max-cost <usd>` | Ask before every action once the estimated cost reaches this |
| `--max-quota <percent>` | The same, once a quota window is this full |

Environment variables:

| Variable | Description |
| --- | --- |
| `VANTAGE_POLICY` | Override the action-type levels for one session, e.g. `shell:deny,network:ask` |
| `VANTAGE_MAX_COST`, `VANTAGE_MAX_QUOTA` | Budget, same as the `run` options |
| `VANTAGE_QUOTA_WARN` | Quota warning threshold in percent (default 90) |
| `VANTAGE_AGENT_PATH` | Path to the agent if it is not found on `PATH` |
| `VANTAGE_UPSTREAM` | Send the agent's requests to this address instead of its provider's default (e.g. a company gateway) |
| `VANTAGE_HOME` | Where Vantage keeps its own files (default `~/.vantage`) |
| `VANTAGE_DEBUG=1` | Log upstream status and rate-limit headers |

### How it works

`vantage run` starts the agent with its provider's address pointing at a local proxy — `ANTHROPIC_BASE_URL` for Claude Code, `openai_base_url` for Codex, `COPILOT_API_URL` for Copilot CLI, and so on. The proxy forwards every request unchanged, WebSockets included, and reads token usage and rate-limit headers from the responses; it understands the Anthropic, OpenAI (Responses and Chat Completions) and Gemini APIs. Approvals and budgets go through each agent's own hooks, because tools run inside the agent and never pass the proxy; Vantage passes them for one session, on the command line or in the session's own folder. One `vantage hook` command speaks every agent's hook format; alerts reach the chat through the hook that runs after each reply.

Each session is recorded in the project's `.vantage/sessions/`, including excerpts of prompts and replies; Vantage keeps that folder out of git with its own `.vantage/.gitignore`, so rules and project memory can still be committed. The price list and the index that `watch`, `stats` and `search` use across projects are kept in `~/.vantage`.

## FAQ

**Does it slow the agent down?** The proxy streams responses through as they arrive, without buffering. When rules or a budget are active, each tool call is checked by a short-lived process (about a tenth of a second); in the interactive chat, one also runs after each reply to show alerts.

**Does it change my agent's setup?** No: hooks and memory are passed to each session on the command line or in the session's own folder, your settings files stay untouched, and your own hooks keep working.

**Which agents does it support?** Claude Code, Codex, GitHub Copilot CLI, OpenCode and pi — see [Supported agents](#supported-agents) for what works with each.

**How do I remove it?** `npm uninstall -g @jovan158/vantage`. To remove its data as well, delete `~/.vantage` and the `.vantage` folders in your projects.

## Contributing

Issues and pull requests are welcome. To work on Vantage, clone the repository, run `npm install` and `npm test`; Node.js runs the TypeScript source directly, without a build step. `vantage demo` runs the whole chain against a mock API, without Claude Code or an account; `node --experimental-strip-types scripts/e2e-agents.ts` runs every installed agent against a stand-in model API. Please report security issues privately through the repository's *Security* tab rather than in a public issue. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
