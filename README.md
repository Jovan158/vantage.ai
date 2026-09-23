<img width="1408" height="768" alt="vantage dev_schriftzug" src="https://github.com/user-attachments/assets/13b85a02-08a3-4ea0-813c-44c4c14bbe23" />

# vantage.dev

**See and control what Claude Code does: cost, limits, actions and history.**

Vantage wraps [Claude Code](https://code.claude.com/docs) without
changing it. It sits between Claude Code and the API as a local proxy and uses
Claude Code's own hooks to enforce your rules.

- **Cost and limits, live.** Tokens, estimated cost at official list prices, and
  your subscription's 5-hour and 7-day quota, with a warning before you hit it.
- **Budgets.** Past a cost or quota limit you set, every action needs your approval.
- **Approvals by action type, file and command.** Allow, warn, ask or deny file
  reads, writes, shell commands and network access, or specific files and
  commands such as `.env` or `git push --force`.
- **Secret warnings.** When something that looks like an API key, private key or
  password is sent to the API — say, after Claude read a `.env` file — Vantage
  tells you what it was and where it came from.
- **Session replay and stats.** Every prompt, reply and tool call as a timeline,
  with secrets redacted, and usage over days and projects.
- **Change summary.** In a git repository, every session ends with the files it
  changed, and `vantage review` shows the diff. Or run fully isolated in a
  separate git worktree.
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
vantage doctor         # check the setup once: Claude Code, hook, notifications
vantage run claude     # start Claude Code through Vantage
vantage watch          # live view — in a second terminal, from any directory
vantage sessions       # list past sessions
vantage replay <id>    # replay one as a timeline
```

Arguments after `--` go to Claude Code: `vantage run claude -- -p "fix the failing test"`.

While Claude Code's chat is open, Vantage writes nothing to its terminal. Live
numbers are in `vantage watch`; warnings are printed when Claude Code exits.
A desktop notification tells you when Claude waits for your approval, finishes
a task that took a while, or nears a limit or budget.

## Commands

| Command | Description |
| --- | --- |
| `vantage run [options] claude [-- args]` | Start Claude Code through Vantage |
| `vantage watch [id]` | Live view, from any directory: all running sessions side by side, or one in detail |
| `vantage sessions` | List past sessions |
| `vantage stats [--days N]` | Usage by day and project, and the largest sessions |
| `vantage search <text> [--files \| --commands]` | Which session did what: messages, files, commands, blocks |
| `vantage replay <id>` | Show a session as a timeline, from any directory |
| `vantage review <id> [--patch]` | Files a session changed, or the full diff |
| `vantage discard <id>` | Discard an isolated session's worktree and branch |
| `vantage memory init` · `add <category> <text>` · `show` | Manage project memory |
| `vantage harvest [id]` | Suggest what to remember from a session |
| `vantage policy` · `vantage policy init` | Show the rules in effect · create a starter rule file |
| `vantage pricing` · `vantage pricing update` | Show prices · fetch the current official list |
| `vantage doctor [--no-notify]` | Check the setup: Claude Code, hook, git, notifications, rules, prices |
| `vantage demo` | Run the whole chain against a mock API (no account needed) |

Options for `run`:

| Option | Description |
| --- | --- |
| `--isolate` | Work in a separate git worktree and branch |
| `--no-memory` | Don't pass project memory to Claude Code |
| `--no-notify` | No desktop notifications for this session |
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
| `VANTAGE_NOTIFY` | `0` turns desktop notifications off, `1` turns them on outside the chat UI too |
| `VANTAGE_AGENT_PATH` | Path to Claude Code if it is not found on `PATH` |
| `VANTAGE_DEBUG=1` | Log upstream status and rate-limit headers |

Desktop notifications can be tuned in `~/.vantage/config.json` — all off with
`{ "notify": false }`, or single kinds, e.g. `{ "notify": { "done": false } }`.
Kinds: `approval`, `done`, `limits`, `budget`, `secrets`. `--no-notify` and
`VANTAGE_NOTIFY` take precedence over the file.

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
