// PreToolUse enforcement for problem ② — the half the proxy cannot do.
//
// Why a hook and not the proxy: the proxy sees a tool *intention* in the
// response stream, but the tool is executed inside the agent and never travels
// through the proxy. Only the agent (via its hook) or the OS (via a sandbox) can
// actually stop a file write or a shell command. Claude Code's PreToolUse hook
// runs before execution and returns a decision, so that is the correct layer.
//
// Contract (verified against the Claude Code hooks documentation):
//   stdin : { tool_name, tool_input, session_id, cwd, ... }
//   stdout: { hookSpecificOutput: { hookEventName: "PreToolUse",
//             permissionDecision: "allow"|"deny"|"ask",
//             permissionDecisionReason: string } }
//   exit 0: the JSON decides; no JSON means "no decision, normal flow".

import { classifyTool } from "./policy.ts";
import type { ActionType, Policy } from "./policy.ts";
import type { BudgetState } from "./budget.ts";
import { matchRules, type Rule } from "./rules.ts";

export interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
  cwd?: string;
}

export type HookDecision = "allow" | "deny" | "ask";

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: HookDecision;
    permissionDecisionReason: string;
  };
}

export interface Verdict {
  type: ActionType;
  /** null means: emit nothing and let the agent's normal permission flow run. */
  decision: HookDecision | null;
  reason: string;
}

// Map the policy level for a tool's action type onto a hook decision.
// "allow" and "warn" deliberately produce no decision: warn is observe-only,
// and emitting an explicit "allow" would override the user's own permission
// rules — Vantage should never widen access, only narrow it.
//
// A rule for this file or command (src/rules.ts) overrides the action-type
// level. A reached budget (src/budget.ts) then turns allow/warn into "ask":
// every action needs the user's approval. deny stays deny.
export interface DecideContext {
  input?: Record<string, unknown>;
  rules?: Rule[];
  /** Project root, for rules written as paths from it. */
  cwd?: string;
}

export function decide(toolName: string, policy: Policy, budget: BudgetState | null = null, ctx: DecideContext = {}): Verdict {
  const type = classifyTool(toolName);
  const match = matchRules(ctx.input, ctx.rules ?? [], ctx.cwd, undefined, policy[type]);
  const level = match ? match.level : policy[type];
  if (budget && (level === "allow" || level === "warn")) {
    return {
      type,
      decision: "ask",
      reason: `Vantage budget reached: ${budget.reason}. Approve to continue (tool: ${toolName}).`,
    };
  }
  const rule = match ? `Vantage rule "${match.rule.pattern}" (${match.rule.kind}s in .vantage/policy.json)` : null;
  switch (level) {
    case "deny":
      return {
        type,
        decision: "deny",
        reason: rule
          ? `Blocked by ${rule} (tool: ${toolName}).`
          : `Blocked by Vantage policy: ${type} actions are set to 'deny' (tool: ${toolName}). Change it with VANTAGE_POLICY or .vantage/policy.json.`,
      };
    case "ask":
      return {
        type,
        decision: "ask",
        reason: rule
          ? `${rule} requires your approval (tool: ${toolName}).`
          : `Vantage policy requires approval for ${type} actions (tool: ${toolName}).`,
      };
    default:
      return { type, decision: null, reason: "" };
  }
}

export function buildOutput(v: Verdict): HookOutput | null {
  if (!v.decision) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: v.decision,
      permissionDecisionReason: v.reason,
    },
  };
}

export function parseHookInput(raw: string): HookInput | null {
  try {
    const json = JSON.parse(raw) as HookInput;
    return typeof json === "object" && json !== null ? json : null;
  } catch {
    return null;
  }
}

// Whole hook run as one pure step: raw stdin -> stdout text (or "" for no
// decision). Unparseable input yields no decision rather than blocking work.
export function runHook(rawInput: string, policy: Policy, budget: BudgetState | null = null, rules: Rule[] = []): string {
  const input = parseHookInput(rawInput);
  const tool = input?.tool_name;
  if (!tool) return "";
  const output = buildOutput(decide(tool, policy, budget, { input: input.tool_input, rules, cwd: input.cwd }));
  return output ? JSON.stringify(output) : "";
}

// How the agent should invoke this CLI's `hook` subcommand: node plus the entry
// script, in EXEC form (command + args, no shell). Exec form sidesteps quoting
// entirely — on Windows the hook would otherwise run under Git Bash or
// PowerShell, each with its own rules for backslashes and spaces in paths —
// and the docs name `node` + script path as the pattern that works on every
// platform, because node is a real binary.
export interface HookInvocation {
  command: string;
  args: string[];
}

// `extra` names the agent and the session's hook settings (see
// src/agents/hooks.ts); Claude Code's hook reads them from the environment.
export function hookInvocation(execPath: string, entry: string, extra: string[] = []): HookInvocation {
  // A dev checkout runs the TypeScript source, which needs type stripping.
  const strip = entry.endsWith(".ts") ? ["--experimental-strip-types"] : [];
  return { command: execPath, args: [...strip, entry, "hook", ...extra] };
}

// The same invocation as one shell command line, for agents that run hooks
// through a shell (Codex). Every
// part is quoted for the shell the agent uses on this platform.
export function hookCommandLine(inv: HookInvocation, platform = process.platform): string {
  // A quoted program path is a string, not a command, to PowerShell; node
  // under "C:\Program Files" is started by name then (npm put it on PATH).
  const command = platform === "win32" && shellQuote(inv.command, platform) !== inv.command ? "node" : inv.command;
  return [command, ...inv.args].map((a) => shellQuote(a, platform)).join(" ");
}

export function shellQuote(arg: string, platform = process.platform): string {
  if (platform === "win32") {
    // cmd.exe and PowerShell both take a double-quoted path; a path cannot
    // contain a double quote on Windows.
    return /^[A-Za-z0-9_\\/:.=-]+$/.test(arg) ? arg : `"${arg}"`;
  }
  return /^[A-Za-z0-9_\/:.=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

// The settings fragment that registers the hooks. Claude Code merges
// `--settings` with the user's own files and COMBINES list keys such as
// hooks.PreToolUse, so this adds our hooks without removing theirs.
//   PreToolUse  judges each tool call (rules, budget)
//   Stop        runs when a reply is finished, to show waiting alerts in the
//               chat (see src/outbox.ts)
export function hookSettings(inv: HookInvocation, events: { preToolUse?: boolean; stop?: boolean } = { preToolUse: true }): object {
  const hook = { type: "command", command: inv.command, args: inv.args };
  const hooks: Record<string, object[]> = {};
  if (events.preToolUse) hooks.PreToolUse = [{ matcher: "*", hooks: [hook] }];
  if (events.stop) hooks.Stop = [{ hooks: [hook] }];
  return { hooks };
}
