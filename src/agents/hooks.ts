// How each agent talks to its hooks, and how a hook finds its session.
//
// Every agent that can stop a tool call runs a command before it and reads
// the command's answer — each in its own dialect. `vantage hook <agent>`
// reads the agent's JSON from stdin, turns it into one HookCall, lets the
// shared decision logic (src/hook.ts) judge it, and answers in the agent's
// dialect again.
//
// What the hook needs to know about the session (policy, rules file, budget,
// alerts waiting) is in a small JSON file written by `vantage run`. Its path
// is an argument of the hook command, which Vantage registers with the agent
// for that one session.

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// The session's settings for the hook: the same names as the environment
// variables the Claude Code hook has always read, so both ways lead to the
// same code.

export type HookConfig = Record<string, string>;

export function writeHookConfig(file: string, config: HookConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

export function readHookConfig(file: string | undefined): HookConfig | null {
  if (!file) return null;
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!json || typeof json !== "object") return null;
    const out: HookConfig = {};
    for (const [k, v] of Object.entries(json)) if (k.startsWith("VANTAGE_") && typeof v === "string") out[k] = v;
    return out;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dialects.

export interface HookCall {
  /** tool: before a tool runs · stop: a reply is finished · start: a session begins */
  event: "tool" | "stop" | "start" | "other";
  tool?: string;
  input?: Record<string, unknown>;
  /** The directory the agent works in. */
  cwd?: string;
}

export interface HookAnswer {
  decision: "ask" | "deny" | null;
  reason: string;
  /** Alerts for the chat, one per line; "" when none are waiting. */
  alerts: string;
  /** Project memory for a session start. */
  context?: string;
}

export interface HookReply {
  stdout: string;
  exitCode: number;
}

export interface HookProtocol {
  /**
   * Who asks the user when a rule says "ask": "agent" — the agent itself,
   * when the hook answers "ask" · "none" — nobody, so the action is blocked
   * with a reason that says so (Codex and OpenCode, whose hooks can only
   * block).
   */
  ask: "agent" | "none";
  parse(raw: string): HookCall | null;
  reply(call: HookCall, answer: HookAnswer): HookReply;
}

function json(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function obj(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    const parsed = json(v);
    if (parsed) return parsed;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

const out = (value: object | null, exitCode = 0): HookReply => ({ stdout: value ? JSON.stringify(value) : "", exitCode });

// Claude Code's contract, which Codex, Copilot CLI (with PascalCase event
// names) and Vantage's own OpenCode and pi extensions speak too.
//   stdin : { hook_event_name, tool_name, tool_input, cwd, ... }
//   stdout: { hookSpecificOutput: { hookEventName, permissionDecision,
//             permissionDecisionReason }, systemMessage }
function claudeParse(raw: string): HookCall | null {
  const j = json(raw);
  if (!j) return null;
  const name = str(j.hook_event_name) ?? str(j.hookEventName);
  const cwd = str(j.cwd);
  if (name === "Stop" || name === "SubagentStop") return { event: "stop", cwd };
  if (name === "SessionStart") return { event: "start", cwd };
  const tool = str(j.tool_name) ?? str(j.toolName);
  if (!tool) return name ? { event: "other", cwd } : null;
  return { event: "tool", tool, input: obj(j.tool_input) ?? obj(j.toolArgs), cwd };
}

function claudeReply(call: HookCall, a: HookAnswer, extra: Record<string, unknown> = {}): HookReply {
  const message = a.alerts ? { systemMessage: a.alerts } : {};
  if (call.event === "start") {
    return out(a.context ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: a.context } } : null);
  }
  if (call.event !== "tool" || !a.decision) return out(a.alerts ? message : null);
  return out({
    ...extra,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: a.decision, permissionDecisionReason: a.reason },
    ...message,
  });
}

const claude: HookProtocol = { ask: "agent", parse: claudeParse, reply: (c, a) => claudeReply(c, a) };

// Codex implements Claude's contract, but a PreToolUse hook can only block:
// "ask" is refused as unsupported (and would let the call through).
const codex: HookProtocol = { ask: "none", parse: claudeParse, reply: (c, a) => claudeReply(c, a) };

// Copilot CLI: hooks registered under the PascalCase names get Claude's
// payload and tool names. Its documented answer puts the decision at the top
// level; the Claude shape is sent alongside for the same reason. Messages
// for the user go in "progress" lines before the answer, which it shows in
// its timeline.
const copilot: HookProtocol = {
  ask: "agent",
  parse: claudeParse,
  reply(c, a) {
    const progress = a.alerts ? a.alerts.split("\n").map((message) => JSON.stringify({ type: "progress", message })) : [];
    const decision =
      c.event === "tool" && a.decision
        ? claudeReply(c, { ...a, alerts: "" }, { permissionDecision: a.decision, permissionDecisionReason: a.reason }).stdout
        : "";
    return { stdout: [...progress, decision].filter(Boolean).join("\n"), exitCode: 0 };
  },
};

// OpenCode: Vantage's plugin speaks Claude's contract. A plugin can stop a
// tool call but not ask about it; OpenCode's own permission settings could,
// but a rule added there would also override the user's own "deny" for the
// same call — so "ask" blocks, as with Codex.
const opencode: HookProtocol = { ask: "none", parse: claudeParse, reply: (c, a) => claudeReply(c, a) };

// pi: Vantage's extension speaks Claude's contract and asks through pi's UI.
const pi: HookProtocol = claude;

const PROTOCOLS: Record<string, HookProtocol> = { claude, codex, copilot, opencode, pi };

export function hookProtocol(agent: string | undefined): HookProtocol {
  return PROTOCOLS[agent ?? "claude"] ?? claude;
}
