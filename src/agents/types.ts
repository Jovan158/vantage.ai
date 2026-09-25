// What Vantage needs to know about a coding agent: how to start it behind
// the proxy, how to register its hooks for the session, and what it can do.
// The core knows only this interface; src/agents/<agent>.ts fill it in.

import type { Route } from "../proxy.ts";
import type { HookInvocation } from "../hook.ts";
import type { Policy } from "../policy.ts";
import type { Rule } from "../rules.ts";

export interface LaunchContext {
  /** The session's proxy, e.g. http://127.0.0.1:41234. */
  proxyUrl: string;
  /** The session's folder, for files the agent reads (settings, plugins). */
  sessionDir: string;
  /** How the agent starts `vantage hook <agent> <config>`. */
  hook: HookInvocation;
  /** Run the hook before each tool call (rules, budget). */
  enforce: boolean;
  /** Show alerts in the agent's own chat. */
  chatAlerts: boolean;
  /** Project memory to give the agent, or null. */
  memory: string | null;
  /** Where that memory is written, for agents that read it from a file. */
  memoryFile: string;
  /** The directory the agent runs in. */
  cwd: string;
  env: NodeJS.ProcessEnv;
  policy: Policy;
  rules: Rule[];
  /** The agent's own arguments (some settings depend on the mode). */
  args: string[];
}

export interface LaunchPlan {
  /** Arguments before the user's own. */
  args: string[];
  env: Record<string, string>;
  /** One line each, printed before the agent starts. */
  notes: string[];
  /** The memory reached the agent. */
  memory: boolean;
  /** More settings for the session's hook (see src/agents/hooks.ts). */
  hookConfig?: Record<string, string>;
}

export interface Capabilities {
  /** Tokens, cost and activity are read from its API traffic. */
  meter: boolean;
  /** Rules and budgets are enforced: "ask" works as ask, or blocks instead. */
  enforce: "ask" | "deny-only" | "none";
  /** Alerts appear in its own chat while it runs. */
  chatAlerts: boolean;
  /** Its hook is set up once with `vantage setup <agent>`. */
  setup: boolean;
}

export interface AgentAdapter {
  /** The name users type, e.g. "codex". */
  key: string;
  /** How session logs name it ("claude-code" for Claude Code, else the key). */
  id: string;
  /** How it is called in messages, e.g. "Codex CLI". */
  name: string;
  /** How it is called in a sentence, e.g. "Codex is thinking". */
  short: string;
  /** Default executable. */
  command: string;
  capabilities: Capabilities;
  /** Proxy routes for its providers; none when its traffic cannot be read. */
  routes(env: NodeJS.ProcessEnv): Route[];
  /** Arguments, environment and files for one session. */
  prepare(ctx: LaunchContext): LaunchPlan;
  /**
   * Whether these args open the agent's interactive, full-screen UI. While it
   * is open the agent owns the terminal and Vantage must not write to it
   * (see src/terminal.ts).
   */
  isInteractive(args: string[]): boolean;
  /** How to install it, for doctor. */
  install: string;
}
