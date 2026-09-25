// `vantage setup <agent>`: adds Vantage's hook once to the settings of an
// agent that cannot take it for one session (see src/setup.ts).

import { installSetup, setupAgents, setupState } from "../setup.ts";
import { resolveAdapter } from "../agents/index.ts";
import { log } from "./output.ts";

export async function cmdSetup(argv: string[], entry: string): Promise<number> {
  const name = argv[0];
  if (!name) {
    log(`which agent? vantage setup <${setupAgents().join("|")}>`);
    for (const agent of setupAgents()) {
      const s = setupState(agent, entry);
      log(`  ${agent.padEnd(12)} ${s.installed ? (s.stale ? "set up, but for another Vantage — run setup again" : "set up") : "not set up"} (${s.file})`);
    }
    return 1;
  }
  const adapter = resolveAdapter(name);
  if (!adapter) {
    log(`unknown agent "${name}"`);
    return 1;
  }
  if (!adapter.capabilities.setup) {
    log(`${adapter.name} needs no setup: vantage run ${adapter.key} adds its hooks for each session`);
    return 0;
  }
  try {
    for (const line of installSetup(adapter.key, entry)) log(line);
  } catch (err) {
    log(`setup failed: ${(err as Error).message}`);
    return 1;
  }
  log(`outside a Vantage session the hook does nothing; \`vantage run ${adapter.key}\` switches it on`);
  return 0;
}
