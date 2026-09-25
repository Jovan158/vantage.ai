// `vantage stats`: usage over the last days, across all recorded sessions.

import { knownSessions } from "../home.ts";
import { readSessionEvents } from "../watch.ts";
import { sessionStat, renderStats, type SessionStat } from "../stats.ts";
import { log } from "./output.ts";

export async function cmdStats(argv: string[]): Promise<number> {
  let days = 7;
  const i = argv.findIndex((a) => a === "--days" || a.startsWith("--days="));
  if (i !== -1) {
    const raw = argv[i]!.includes("=") ? argv[i]!.split("=")[1] : argv[i + 1];
    days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      log(`--days needs a whole number from 1 to 366 (got "${raw ?? ""}")`);
      return 1;
    }
  }
  const cwd = process.cwd();
  const stats: SessionStat[] = [];
  for (const ref of knownSessions(cwd)) {
    const stat = sessionStat(ref, readSessionEvents(ref.cwd, ref.sessionId));
    if (stat) stats.push(stat);
  }
  process.stdout.write(renderStats(stats, { days, cwd, color: process.stdout.isTTY ?? false }) + "\n");
  return 0;
}
