<img width="1408" height="768" alt="vantage dev_schriftzug" src="https://github.com/user-attachments/assets/13b85a02-08a3-4ea0-813c-44c4c14bbe23" />

# vantage.dev

**See and control what Claude Code does: cost, limits, actions and history.**

Vantage wraps [Claude Code](https://code.claude.com/docs) without
changing it. It sits between Claude Code and the API as a local proxy and uses
Claude Code's own hooks to enforce your rules.

- **Cost and limits, live.** Tokens, estimated cost at official list prices, and
  your subscription's 5-hour and 7-day quota, with a warning before you hit it.
- **Budgets.** Past a cost or quota limit you set, every action needs your approval.
- **Approvals by action type.** Allow, warn, ask or deny file reads, writes, shell
  commands and network access.
- **Session replay.** Every prompt, reply and tool call as a timeline, with
  secrets redacted.
- **Isolation.** Run in a separate git worktree and review one combined diff.
- **Project memory.** Decisions and conventions in `.vantage/memory/`, given to
  Claude Code at every start.

## Requirements

- Node.js 22.6 or newer
- Claude Code, installed and logged in (subscription or API key). Vantage uses
  that login and needs no key of its own.

## Install

Vantage is not on npm yet. Install it from a checkout:

```bash
git clone https://github.com/Jovan158/vantage.dev.git
cd vantage.dev
npm install
npm pack
npm install -g ./vantagedev-0.0.1.tgz
```

## Quick start

```bash
vantage run claude     # start Claude Code through Vantage
vantage watch          # live view — run it in a second terminal
vantage sessions       # list past sessions
vantage replay <id>    # replay one as a timeline
```

Arguments after `--` go to Claude Code: `vantage run claude -- -p "fix the failing test"`.

## Commands

| Command | Description |
| --- | --- |
| `vantage run [options] claude [-- args]` | Start Claude Code through Vantage |
| `vantage watch [id]` | Live view of the running session |
| `vantage sessions` | List past sessions |
| `vantage replay <id>` | Show a session as a timeline |
| `vantage review <id>` · `vantage discard <id>` | Show or discard an isolated session's changes |
| `vantage memory init` · `add <category> <text>` · `show` | Manage project memory |
| `vantage harvest [id]` | Suggest what to remember from a session |
| `vantage policy` | Show the approval rules in effect |
| `vantage pricing` · `vantage pricing update` | Show prices · fetch the current official list |
| `vantage demo` | Run the whole chain against a mock API (no account needed) |

Options for `run`:

| Option | Description |
| --- | --- |
| `--isolate` | Work in a separate git worktree and branch |
| `--no-memory` | Don't pass project memory to Claude Code |
| `--max-cost <usd>` | Require approval for every action once the estimated cost reaches this |
| `--max-quota <percent>` | Same, once a quota window is this full |

## Configuration

Approval rules live in `.vantage/policy.json`:

```json
{ "shell": "ask", "network": "deny" }
```

Action types are `read`, `write`, `shell`, `network` and `other`. Levels are
`allow`, `warn` (notice only), `ask` (Claude Code asks you) and `deny` (blocked).
By default, `shell` and `network` are `warn` and everything else is `allow`.

| Environment variable | Description |
| --- | --- |
| `VANTAGE_POLICY` | Override rules, e.g. `shell:deny,network:ask` |
| `VANTAGE_MAX_COST`, `VANTAGE_MAX_QUOTA` | Budget, same as the `run` options |
| `VANTAGE_QUOTA_WARN` | Quota warning threshold in percent (default 90) |
| `VANTAGE_AGENT_PATH` | Path to Claude Code if it is not found on `PATH` |
| `VANTAGE_DEBUG=1` | Log upstream status and rate-limit headers |

Cost is an estimate of what the traffic would cost on the API at list price. On a
subscription, the quota line is what counts.

## How it works

`vantage run` starts Claude Code with `ANTHROPIC_BASE_URL` pointing at a local
proxy. The proxy forwards every request unchanged and reads token usage and
rate-limit headers from the responses. Approval rules and budgets go through
Claude Code's `PreToolUse` hook, because tools run inside Claude Code and never
pass through the proxy. Each session is recorded in `.vantage/sessions/`.

More detail, with example output and design decisions (in German):
[docs/DETAILS.md](docs/DETAILS.md) and [docs/CONCEPT.md](docs/CONCEPT.md).

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

## License

[MIT](LICENSE)
