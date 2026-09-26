// `vantage doctor`: checks the setup (see src/doctor.ts).

import { runDoctor, renderDoctor } from "../doctor.ts";
import { bannerForStdout } from "../banner.ts";
import { resolveAdapter, knownAgents } from "../agents/index.ts";
import { log } from "./output.ts";

export async function cmdDoctor(argv: string[], entry: string): Promise<number> {
  const agent = argv[0] ? resolveAdapter(argv[0]) : undefined;
  if (argv[0] && !agent) {
    log(`unknown agent "${argv[0]}". known: ${knownAgents().join(", ")}`);
    return 1;
  }
  // The logo first: the checks start the agents and take a moment.
  if (process.stdout.isTTY) process.stdout.write(bannerForStdout() + "\n\n");
  const checks = runDoctor({ cwd: process.cwd(), entry }, agent);
  process.stdout.write(renderDoctor(checks, process.stdout.isTTY ?? false) + "\n");
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}
