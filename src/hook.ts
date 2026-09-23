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

export interface HookInput {
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
export function decide(toolName: string, policy: Policy): Verdict {
  const type = classifyTool(toolName);
  const level = policy[type];
  switch (level) {
    case "deny":
      return {
        type,
        decision: "deny",
        reason: `Blocked by Vantage policy: ${type} actions are set to 'deny' (tool: ${toolName}). Change it with VANTAGE_POLICY or .vantage/policy.json.`,
      };
    case "ask":
      return {
        type,
        decision: "ask",
        reason: `Vantage policy requires approval for ${type} actions (tool: ${toolName}).`,
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
export function runHook(rawInput: string, policy: Policy): string {
  const input = parseHookInput(rawInput);
  const tool = input?.tool_name;
  if (!tool) return "";
  const output = buildOutput(decide(tool, policy));
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

export function hookInvocation(execPath: string, entry: string): HookInvocation {
  // A dev checkout runs the TypeScript source, which needs type stripping.
  const strip = entry.endsWith(".ts") ? ["--experimental-strip-types"] : [];
  return { command: execPath, args: [...strip, entry, "hook"] };
}

// The settings fragment that registers this hook. Claude Code merges
// `--settings` with the user's own files and COMBINES list keys such as
// hooks.PreToolUse, so this adds our hook without removing theirs.
export function hookSettings(inv: HookInvocation): object {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: inv.command, args: inv.args }],
        },
      ],
    },
  };
}
