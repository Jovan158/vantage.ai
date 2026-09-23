// `vantage doctor`: checks the setup (see src/doctor.ts).

import { runDoctor, renderDoctor } from "../doctor.ts";

export async function cmdDoctor(entry: string): Promise<number> {
  const checks = runDoctor({ cwd: process.cwd(), entry });
  process.stdout.write(renderDoctor(checks, process.stdout.isTTY ?? false) + "\n");
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}
