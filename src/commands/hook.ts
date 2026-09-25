// `vantage hook [agent] [config]`: started by the agent, not by a human —
// before each tool call (the decision itself is in src/hook.ts), when a reply
// is finished, and for some agents when a session starts. The agent's own
// dialect is translated by src/agents/hooks.ts; without an agent name it is
// Claude Code's.

import fs from "node:fs";
import { decide } from "../hook.ts";
import { loadPolicy } from "../policy.ts";
import { loadRules, policyFilePath } from "../rules.ts";
import { readBudgetState, waitForMetering } from "../budget.ts";
import { takeAlerts, chatText } from "../outbox.ts";
import { toolTarget } from "../turn.ts";
import { findActiveConfig, hookProtocol, readHookConfig, type HookAnswer } from "../agents/hooks.ts";
import type { DecisionEvent } from "../events.ts";

// Agents whose hook is set up once in the user's settings: outside a Vantage
// session their hook finds no session and stays out of the way.
const SETUP_AGENTS = new Set(["gemini", "cursor", "hermes", "antigravity"]);

export async function cmdHook(args: string[] = []): Promise<number> {
  const agent = args[0];
  const protocol = hookProtocol(agent);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const call = protocol.parse(raw);

  // The session's settings: named by the hook command, by the environment,
  // or — for a hook set up once — found by the directory the agent works in.
  // The environment counts only for the agent it was set for: a Gemini CLI
  // started from inside a Cursor session is not that session.
  const fromEnv = process.env.VANTAGE_HOOK_AGENT === agent ? process.env.VANTAGE_HOOK_CONFIG : undefined;
  const configFile =
    args[1] ?? fromEnv ?? (agent && SETUP_AGENTS.has(agent) ? findActiveConfig(agent, [...(call?.dirs ?? []), process.cwd()]) : null) ?? undefined;
  const config = readHookConfig(configFile);
  if (!config && agent && SETUP_AGENTS.has(agent)) return 0; // not a Vantage session
  if (config) Object.assign(process.env, config);
  if (!call) return 0; // unreadable input never blocks work

  const outbox = process.env.VANTAGE_OUTBOX_FILE;
  const answer: HookAnswer = { decision: null, reason: "", alerts: "" };

  if (call.event === "stop") {
    // Let the finished reply be metered, so an alert it caused (a quota
    // warning, a secret) shows now rather than after the next one.
    await waitForMetering(process.env.VANTAGE_INFLIGHT_FILE, 1000);
    answer.alerts = chatText(takeAlerts(outbox));
  } else if (call.event === "start") {
    try {
      if (process.env.VANTAGE_MEMORY_FILE) answer.context = fs.readFileSync(process.env.VANTAGE_MEMORY_FILE, "utf8");
    } catch {
      /* no memory then */
    }
  } else if (call.event === "tool" && call.tool) {
    // With a budget: let the reply that asked for this tool be metered first.
    if (process.env.VANTAGE_BUDGET_FILE) await waitForMetering(process.env.VANTAGE_INFLIGHT_FILE);
    const cwd = call.dirs[0] ?? process.cwd();
    const budget = readBudgetState(process.env.VANTAGE_BUDGET_FILE);
    const v = decide(call.tool, loadPolicy(cwd), budget, {
      input: call.input,
      rules: loadRules(process.env.VANTAGE_POLICY_FILE ?? policyFilePath(cwd)),
      cwd,
    });
    // decide() never allows: Vantage only narrows what the agent permits.
    answer.decision = v.decision === "allow" ? null : v.decision;
    answer.reason = v.reason;
    if (v.decision === "ask" && (protocol.ask === "none" || process.env.VANTAGE_ASK_MODE === "block")) {
      answer.decision = "deny";
      answer.reason = `${v.reason} This agent cannot pause to ask, so the action was not run: tell the user what you wanted to do, so they can do it themselves or change the rule.`;
    }
    answer.alerts = chatText(takeAlerts(outbox));
    if (answer.decision) record(call.tool, call.input, answer.decision, answer.reason);
  }

  const reply = protocol.reply(call, answer);
  if (reply.stdout) process.stdout.write(reply.stdout);
  return reply.exitCode;
}

// What the hook stopped or asked about goes into the event log, so watch and
// replay show it next to the calls that went through. Best effort: a log that
// cannot be written must never change the decision.
function record(tool: string, input: Record<string, unknown> | undefined, decision: "ask" | "deny", reason: string): void {
  const file = process.env.VANTAGE_EVENTS_FILE;
  if (!file) return;
  const target = toolTarget(input);
  const event: DecisionEvent = { ts: new Date().toISOString(), type: "decision", tool, ...(target ? { target } : {}), decision, reason };
  try {
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
  } catch {
    /* the decision stands either way */
  }
}
