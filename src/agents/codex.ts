// Codex (OpenAI's CLI) takes every setting as `-c key=value` for one run:
// openai_base_url points it at the proxy, and hooks — Claude Code's contract,
// with PreToolUse, Stop and SessionStart — are registered the same way.
//
// Signed in with ChatGPT it talks to chatgpt.com/backend-api/codex, with an
// API key to api.openai.com/v1; the ChatGPT-Account-Id header tells which,
// so the proxy sends each request where Codex would have. Its turns stream
// over a WebSocket by default, which the proxy reads (src/ws.ts).
//
// Codex runs a hook only once it is trusted: its settings store a hash of the
// hook's definition. Vantage passes that hash for its own hooks alongside
// them, so they run without a prompt — and without --dangerously-bypass-
// hook-trust, which would also run every untrusted hook of the project.

import crypto from "node:crypto";
import { hookCommandLine } from "../hook.ts";
import type { AgentAdapter } from "./types.ts";

const CHATGPT = "https://chatgpt.com/backend-api/codex";
const OPENAI = "https://api.openai.com/v1";

type HookEvent = "PreToolUse" | "Stop" | "SessionStart";
const EVENT_KEY: Record<HookEvent, string> = { PreToolUse: "pre_tool_use", Stop: "stop", SessionStart: "session_start" };
const TIMEOUT = 600; // Codex's default, written out: it is part of the hash

// Sorted keys at every level, compact — how Codex fingerprints a definition.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical((value as Record<string, unknown>)[k])]));
  }
  return value;
}

// The trust hash of one command hook, as Codex computes it: the event, the
// group's matcher (Stop has none) and the handler with its defaults filled in.
export function codexHookHash(event: HookEvent, command: string, matcher?: string): string {
  const identity = {
    event_name: EVENT_KEY[event],
    ...(matcher !== undefined && event !== "Stop" ? { matcher } : {}),
    hooks: [{ type: "command", command, timeout: TIMEOUT, async: false }],
  };
  return "sha256:" + crypto.createHash("sha256").update(JSON.stringify(canonical(identity))).digest("hex");
}

// Where Codex files hooks from `-c`: a made-up config file of the session.
export function codexHookKey(event: HookEvent, platform = process.platform): string {
  const source = platform === "win32" ? "C:\\<session-flags>\\config.toml" : "/<session-flags>/config.toml";
  return `${source}:${EVENT_KEY[event]}:0:0`;
}

const tomlString = (s: string): string => JSON.stringify(s);

// One `-c hooks={…}` value: the hook groups and their trust.
export function codexHooksToml(command: string, events: HookEvent[], platform = process.platform): string {
  const groups: string[] = [];
  const state: string[] = [];
  for (const event of events) {
    const matcher = event === "PreToolUse" ? "*" : undefined;
    const handler = `{type="command", command=${tomlString(command)}, timeout=${TIMEOUT}}`;
    groups.push(`${event}=[{${matcher ? `matcher=${tomlString(matcher)}, ` : ""}hooks=[${handler}]}]`);
    state.push(`${tomlString(codexHookKey(event, platform))}={trusted_hash=${tomlString(codexHookHash(event, command, matcher))}}`);
  }
  return `{${groups.join(", ")}, state={${state.join(", ")}}}`;
}

export const codex: AgentAdapter = {
  key: "codex",
  id: "codex",
  name: "Codex",
  short: "Codex",
  command: "codex",
  install: "npm install -g @openai/codex",
  // Its PreToolUse hook can block but not ask: an "ask" rule blocks, with a
  // reason that tells Codex to leave the action to the user.
  capabilities: { meter: true, enforce: "deny-only", chatAlerts: true },
  routes: (env) => [
    {
      prefix: "/codex",
      upstream: (headers) => env.VANTAGE_UPSTREAM ?? (headers["chatgpt-account-id"] ? CHATGPT : OPENAI),
    },
  ],
  prepare(ctx) {
    const args = ["-c", `openai_base_url=${tomlString(`${ctx.proxyUrl}/codex`)}`];
    const events: HookEvent[] = [];
    if (ctx.enforce) events.push("PreToolUse");
    if (ctx.chatAlerts) events.push("Stop");
    if (ctx.memory) events.push("SessionStart");
    if (events.length) args.push("-c", `hooks=${codexHooksToml(hookCommandLine(ctx.hook), events)}`);
    const notes: string[] = [];
    if (ctx.enforce) notes.push("Codex hooks can block but not ask: actions a rule says to ask about are blocked, and Codex is told to leave them to you");
    return { args, env: {}, notes, memory: Boolean(ctx.memory) };
  },
  // exec and review run once and exit; everything else opens the TUI.
  isInteractive: (args) => {
    const first = args.find((a) => !a.startsWith("-"));
    return !["exec", "e", "review", "apply", "a", "login", "logout", "mcp", "doctor", "debug", "features"].includes(first ?? "");
  },
};
