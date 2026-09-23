// `vantage policy [init]`: show the rules in effect, or create a starter set.

import fs from "node:fs";
import path from "node:path";
import { loadPolicy, needsEnforcement } from "../policy.ts";
import { loadRules, policyFilePath, STARTER_POLICY } from "../rules.ts";
import { log } from "./output.ts";

export async function cmdPolicy(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const file = policyFilePath(cwd);
  if (argv[0] === "init") {
    if (fs.existsSync(file)) {
      log(`${path.relative(cwd, file)} already exists — left unchanged`);
      return 1;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(STARTER_POLICY, null, 2) + "\n");
    log(`created ${path.relative(cwd, file)} with recommended rules — edit it to fit your project`);
  } else if (argv[0]) {
    log(`unknown policy command "${argv[0]}" (show | init)`);
    return 1;
  }

  const color = (level: string): string =>
    (level === "deny" ? "\x1b[31m" : level === "ask" || level === "warn" ? "\x1b[33m" : "") + level + "\x1b[0m";
  const policy = loadPolicy(cwd);
  log("by action type — allow · warn (notice only) · ask (approval) · deny (blocked):");
  for (const [type, level] of Object.entries(policy)) {
    process.stdout.write(`  ${type.padEnd(8)} ${color(level)}\n`);
  }
  const rules = loadRules(file);
  for (const kind of ["file", "command"] as const) {
    const list = rules.filter((r) => r.kind === kind);
    if (!list.length) continue;
    log(`${kind} rules — override the action type when they match; the strictest match wins:`);
    const width = Math.max(...list.map((r) => r.pattern.length));
    for (const r of list) process.stdout.write(`  ${r.pattern.padEnd(width)}  ${color(r.level)}\n`);
  }
  if (needsEnforcement(policy) || rules.some((r) => r.level === "ask" || r.level === "deny")) {
    log("ask/deny are enforced through Claude Code's PreToolUse hook");
  }
  if (!rules.length) log("no file or command rules yet — `vantage policy init` creates a starter set");
  log("configure in .vantage/policy.json (VANTAGE_POLICY=\"shell:deny,network:ask\" overrides action types)");
  return 0;
}
