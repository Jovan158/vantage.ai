// Terminal output shared by the commands. All of it goes through the gate,
// which keeps Vantage out of the agent's interactive UI while it is open
// (see src/terminal.ts).

import { TerminalGate } from "../terminal.ts";
import type { QuotaWarning } from "../ratelimit.ts";

export const terminal = new TerminalGate((text) => process.stderr.write(text));

export function log(msg: string): void {
  terminal.info(`\x1b[2m[vantage]\x1b[0m ${msg}\n`);
}

export function warn(w: QuotaWarning): void {
  const color = w.level === "critical" ? "\x1b[1;31m" : "\x1b[1;33m"; // red / yellow
  const label = w.level === "critical" ? "ALERT" : "warning";
  terminal.alert(`${color}[vantage] ${label}: ${w.message}\x1b[0m\n`);
}

export function fmtFileLine(f: { path: string; added: number; removed: number }): string {
  const a = f.added < 0 ? "bin" : `+${f.added}`;
  const r = f.removed < 0 ? "" : `-${f.removed}`;
  return `  ${f.path} (${a}${r ? " " + r : ""})`;
}
