<p align="center">
<img width="65%" alt="vantage.ai" src="images/vantage.ai.jpg" />
</p>

## See and control what your coding agent does


Vantage wraps AI coding agents without changing them. It sits between your coding agent and the API as a local proxy and uses the agent's own hooks and configuration mechanisms to enforce your rules.

Currently we **only** support **Claude Code**.

- **Cost and limits, live.** Tokens, estimated cost at official list prices, and
  your subscription's quota, with a warning before you hit it.
- **Budgets.** Past a cost or quota limit you set, every action needs your approval.
- **Approvals by action type, file and command.** Allow, warn, ask or deny file
  reads, writes, shell commands and network access, or specific files and
  commands.
- **Secret warnings.** When something that looks like an API key, private key or
  password is sent to the API, Vantage tells you what it was and where it came from.
- **Session replay and stats.** Every prompt, reply and tool call as a timeline
  with usage over days and projects.
- **Change summary.** In a git repository, every session ends with the files it
  changed, and `vantage review` shows the diff. Or run fully isolated in a
  separate git worktree.
- **Project memory.** Decisions and conventions in `.vantage/memory/`, given to
  the AI coding agent at every start.


## Requirements

- Node.js 22.6 or newer
- Claude Code, installed and logged in (subscription or API key). Vantage uses
  that login and needs no key of its own.
- Optional: git, for change summaries and `--isolate`

## Install

```bash
npm install -g vantage-ai-cli
```

The command is `vantage`. To install from a checkout instead:

```bash
git clone https://github.com/Jovan158/vantage.ai.git
cd vantage.ai
npm install
npm pack
npm install -g ./vantage-ai-cli-0.1.0.tgz
```

## Quick start

```bash
vantage doctor         # check the setup once: Claude Code, hook, git
vantage run claude     # start Claude Code through Vantage
vantage watch          # live view in a second terminal, from any directory
vantage sessions       # list past sessions
vantage replay <id>    # replay one as a timeline
```

Arguments after `--` go to Claude Code: `vantage run claude -- -p "fix the failing test"`.

While Claude Code's chat is open, Vantage never writes into its terminal.
Warnings (a secret sent, quota running low, budget reached) appear in the chat
itself, right after Claude's reply; live numbers are in `vantage watch`.

## Commands

| Command | Description |
| --- | --- |
| `vantage run [options] claude [-- args]` | Start Claude Code through Vantage |
| `vantage watch [id]` | Live view, from any directory: all running sessions side by side, or one in detail |
| `vantage sessions` · `vantage sessions prune [--older-than 30d] [--all] [--yes]` | List past sessions · delete old ones (lists them first; `--yes` deletes) |
| `vantage stats [--days N]` | Usage by day and project, and the largest sessions |
| `vantage search <text> [--files \| --commands]` | Which session did what: messages, files, commands, blocks |
| `vantage replay <id>` | Show a session as a timeline, from any directory |
| `vantage review <id> [--patch]` | Files a session changed, or the full diff |
| `vantage discard <id>` | Discard an isolated session's worktree and branch |
| `vantage memory init` · `add <category> <text>` · `show` | Manage project memory |
| `vantage harvest [id]` | Suggest what to remember from a session |
| `vantage policy` · `vantage policy init` | Show the rules in effect · create a starter rule file |
| `vantage pricing` · `vantage pricing update` | Show prices · fetch the current official list |
| `vantage doctor` | Check the setup: Claude Code, hook, git, rules, prices |
| `vantage demo` | Run the whole chain against a mock API (no account needed) |

Options for `run`:

| Option | Description |
| --- | --- |
| `--isolate` | Work in a separate git worktree and branch |
| `--no-memory` | Don't pass project memory to Claude Code |
| `--max-cost <usd>` | Require approval for every action once the estimated cost reaches this |
| `--max-quota <percent>` | Same, once a quota window is this full |

## Configuration

Approval rules live in `.vantage/policy.json`. `vantage policy init` creates
one with recommended rules.

```json
{
  "shell": "warn",
  "network": "ask",
  "files":    { ".env": "ask", "*.pem": "deny" },
  "commands": { "git push*--force*": "ask", "npm publish*": "ask", "npm test*": "allow" }
}
```

Action types are `read`, `write`, `shell`, `network` and `other`. Levels are
`allow`, `warn` (notice only), `ask` (Claude Code asks you) and `deny` (blocked).
By default, `shell` and `network` are `warn` and everything else is `allow`.

File and command rules override the action type when they match, and the
strictest match wins. A file pattern without `/` matches the name anywhere,
with `/` the path from the project root; `*` stays within a name, `**` spans
directories. File rules also catch files named in shell commands (`cat .env`).
Command patterns match each part of a command line (split at `&&`, `;`, `|`).
Rules are guardrails, not a sandbox: a command assembled at run time can get
past them.

| Environment variable | Description |
| --- | --- |
| `VANTAGE_POLICY` | Override rules, e.g. `shell:deny,network:ask` |
| `VANTAGE_MAX_COST`, `VANTAGE_MAX_QUOTA` | Budget, same as the `run` options |
| `VANTAGE_QUOTA_WARN` | Quota warning threshold in percent (default 90) |
| `VANTAGE_AGENT_PATH` | Path to Claude Code if it is not found on `PATH` |
| `VANTAGE_HOME` | Where Vantage keeps its own files (default `~/.vantage`) |
| `VANTAGE_DEBUG=1` | Log upstream status and rate-limit headers |

Cost is an estimate of what the traffic would cost on the API at list price. On a
subscription, the quota line is what counts.

## How it works

`vantage run` starts Claude Code with `ANTHROPIC_BASE_URL` pointing at a local
proxy. The proxy forwards every request unchanged and reads token usage and
rate-limit headers from the responses. Approval rules and budgets go through
Claude Code's `PreToolUse` hook, because tools run inside Claude Code and never
pass through the proxy.

Each session is recorded in the project's `.vantage/sessions/`, including
excerpts of prompts and replies. Vantage keeps it out of git with its own
`.vantage/.gitignore`, so rules and project memory can still be committed.
`vantage sessions prune` deletes old sessions. The price list and the index
that `watch`, `stats` and `search` use across projects are kept in `~/.vantage`.

## License

[MIT](LICENSE)
