// vantage — see and control what your coding agent does.
//
// The entry point: parses the command and hands over to src/commands/. Its
// own path is what Claude Code starts for the approval hook, so it is passed
// to the commands that register or check that hook.

import { fileURLToPath } from "node:url";
import { knownAgents } from "./agents/index.ts";
import { banner, bannerForStdout } from "./banner.ts";
import { log } from "./commands/output.ts";
import { cmdRun } from "./commands/run.ts";
import { cmdWatch } from "./commands/watch.ts";
import { cmdHook } from "./commands/hook.ts";
import { cmdReview, cmdDiscard } from "./commands/review.ts";
import { cmdSessions, cmdReplay, cmdHarvest } from "./commands/sessions.ts";
import { cmdStats } from "./commands/stats.ts";
import { cmdSearch } from "./commands/search.ts";
import { cmdDoctor } from "./commands/doctor.ts";
import { cmdPolicy } from "./commands/policy.ts";
import { cmdPricing } from "./commands/pricing.ts";
import { cmdMemory } from "./commands/memory.ts";
import { cmdDemo } from "./commands/demo.ts";

const ENTRY = fileURLToPath(import.meta.url);

// The logo heads the help when it is asked for; after a mistyped command
// the help follows the error, plain.
function printHelp(withLogo = true): void {
  const head = withLogo ? bannerForStdout() : banner({ art: false, color: false });
  process.stdout.write(
    `${head}\n\n` +
      `Usage:\n` +
      `  vantage run [--isolate] [--no-memory] [--max-cost <usd>] [--max-quota <percent>]\n` +
      `              <agent> [-- <agent args...>]\n` +
      `  vantage watch [sessionId]\n` +
      `  vantage sessions [prune [--older-than 30d] [--all] [--yes]]\n` +
      `  vantage stats [--days N]\n` +
      `  vantage search <text> [--files | --commands]\n` +
      `  vantage replay <sessionId>\n` +
      `  vantage harvest [sessionId]\n` +
      `  vantage review <sessionId> [--patch]\n` +
      `  vantage discard <sessionId>\n` +
      `  vantage memory <init|show|add <category> <text>>\n` +
      `  vantage policy [init]\n` +
      `  vantage pricing [update|check]\n` +
      `  vantage doctor\n` +
      `  vantage demo\n` +
      `  vantage --help\n\n` +
      `Agents: ${knownAgents().join(", ")}\n\n` +
      `--isolate runs the agent in a dedicated git worktree/branch so your\n` +
      `working tree is untouched; review or discard the changes afterwards.\n` +
      `Project memory under .vantage/memory/ is injected into the agent unless\n` +
      `--no-memory is given.\n\n` +
      `--max-cost 2 / --max-quota 80 set a budget: once the session's estimated\n` +
      `cost reaches $2, or a subscription quota window 80%, every action needs\n` +
      `your approval. Also settable as VANTAGE_MAX_COST / VANTAGE_MAX_QUOTA.\n\n` +
      `VANTAGE_AGENT_PATH=<path> starts the agent from that executable instead of\n` +
      `looking it up on PATH.\n\n` +
      `Prices come from Anthropic's official list: a copy ships with vantage, and\n` +
      `\`vantage pricing update\` fetches the current one. Nothing is fetched\n` +
      `unless you run that command.\n`
  );
}

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  run: (argv) => cmdRun(argv, ENTRY),
  watch: cmdWatch,
  sessions: cmdSessions,
  stats: cmdStats,
  search: cmdSearch,
  replay: cmdReplay,
  harvest: cmdHarvest,
  review: cmdReview,
  discard: cmdDiscard,
  memory: cmdMemory,
  policy: cmdPolicy,
  pricing: cmdPricing,
  hook: () => cmdHook(),
  doctor: () => cmdDoctor(ENTRY),
  demo: () => cmdDemo(),
};

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === undefined || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    process.exit(0);
  }
  const run = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!run) {
    log(`unknown command "${cmd}"`);
    printHelp(false);
    process.exit(1);
  }
  process.exit(await run(rest));
}

void main();
