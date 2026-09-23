// `vantage hook`: started by Claude Code, not by a human, before each tool
// call (see src/hook.ts for the decision itself).

import fs from "node:fs";
import { runHook, decisionRecord } from "../hook.ts";
import { loadPolicy } from "../policy.ts";
import { loadRules, policyFilePath } from "../rules.ts";
import { readBudgetState, waitForMetering } from "../budget.ts";

// Invoked by Claude Code, not by a human: decide on one pending tool call.
export async function cmdHook(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  // With a budget: let the reply that asked for this tool be metered first.
  if (process.env.VANTAGE_BUDGET_FILE) await waitForMetering(process.env.VANTAGE_INFLIGHT_FILE);
  const out = runHook(
    raw,
    loadPolicy(process.cwd()),
    readBudgetState(process.env.VANTAGE_BUDGET_FILE),
    loadRules(process.env.VANTAGE_POLICY_FILE ?? policyFilePath(process.cwd()))
  );
  if (out) process.stdout.write(out);
  // Best effort: a log that cannot be written must never change the decision.
  const record = decisionRecord(raw, out);
  const eventsFile = process.env.VANTAGE_EVENTS_FILE;
  if (record && eventsFile) {
    try {
      fs.appendFileSync(eventsFile, JSON.stringify(record) + "\n");
    } catch {
      /* the decision stands either way */
    }
  }
  return 0; // the JSON decides; exit 0 with no JSON = no decision
}
