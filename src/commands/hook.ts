// `vantage hook`: started by Claude Code, not by a human — before each tool
// call (PreToolUse: the decision itself is in src/hook.ts) and when a reply is
// finished (Stop). Both hand over the alerts waiting for the chat.

import fs from "node:fs";
import { runHook, decisionRecord, parseHookInput, withAlerts } from "../hook.ts";
import { loadPolicy } from "../policy.ts";
import { loadRules, policyFilePath } from "../rules.ts";
import { readBudgetState, waitForMetering } from "../budget.ts";
import { takeAlerts, chatText } from "../outbox.ts";

export async function cmdHook(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const outbox = process.env.VANTAGE_OUTBOX_FILE;

  if (parseHookInput(raw)?.hook_event_name === "Stop") {
    // Let the finished reply be metered, so an alert it caused (a quota
    // warning, a secret) shows now rather than after the next one.
    await waitForMetering(process.env.VANTAGE_INFLIGHT_FILE, 1000);
    const out = withAlerts("", chatText(takeAlerts(outbox)));
    if (out) process.stdout.write(out);
    return 0; // never blocks the stop
  }

  // With a budget: let the reply that asked for this tool be metered first.
  if (process.env.VANTAGE_BUDGET_FILE) await waitForMetering(process.env.VANTAGE_INFLIGHT_FILE);
  const out = runHook(
    raw,
    loadPolicy(process.cwd()),
    readBudgetState(process.env.VANTAGE_BUDGET_FILE),
    loadRules(process.env.VANTAGE_POLICY_FILE ?? policyFilePath(process.cwd()))
  );
  process.stdout.write(withAlerts(out, chatText(takeAlerts(outbox))));
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
