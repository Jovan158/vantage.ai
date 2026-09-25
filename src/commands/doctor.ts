// `vantage doctor`: checks the setup (see src/doctor.ts).

import { runDoctor, renderDoctor } from "../doctor.ts";
import { bannerForStdout } from "../banner.ts";

export async function cmdDoctor(entry: string): Promise<number> {
  // The logo first: the checks start Claude Code and take a moment.
  if (process.stdout.isTTY) process.stdout.write(bannerForStdout() + "\n\n");
  const checks = runDoctor({ cwd: process.cwd(), entry });
  process.stdout.write(renderDoctor(checks, process.stdout.isTTY ?? false) + "\n");
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}
