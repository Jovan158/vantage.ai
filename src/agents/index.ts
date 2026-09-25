// Agent adapters. The core knows only this interface; each adapter declares how
// to launch a given CLI agent and which env vars redirect its LLM traffic
// through the Vantage proxy (CONCEPT.md §1, "The glue").

import type { ProviderName } from "../providers/index.ts";

export interface AgentAdapter {
  id: string;
  /** Default executable name if the user doesn't pass one. */
  command: string;
  /** Upstream provider base URL this agent talks to. */
  defaultUpstream: string;
  /** Response format this agent's upstream speaks. */
  provider: ProviderName;
  /** Env vars that point the agent's SDK at our local proxy. */
  proxyEnv(proxyUrl: string): Record<string, string>;
  /**
   * Extra CLI args that inject compiled project memory into this agent's
   * context, or null if the agent has no non-invasive injection point.
   */
  contextArgs?(memory: string): string[] | null;
  /**
   * Extra CLI args that register Vantage's PreToolUse hook so action-type
   * policy can be enforced. Absent when the agent exposes no hook mechanism —
   * such agents degrade to observe-only, and Vantage says so.
   */
  enforcementArgs?(settingsPath: string): string[];
  /**
   * Whether these args open the agent's interactive, full-screen UI. While it
   * is open the agent owns the terminal and Vantage must not write to it
   * (see src/terminal.ts).
   */
  isInteractive(args: string[]): boolean;
}

// Claude Code respects ANTHROPIC_BASE_URL to redirect its API traffic and
// --append-system-prompt to inject extra context without touching any file.
const claudeCode: AgentAdapter = {
  id: "claude-code",
  command: "claude",
  defaultUpstream: "https://api.anthropic.com",
  provider: "anthropic",
  proxyEnv(proxyUrl: string): Record<string, string> {
    return { ANTHROPIC_BASE_URL: proxyUrl };
  },
  contextArgs(memory: string): string[] {
    return ["--append-system-prompt", memory];
  },
  // --settings is merged with the user's own settings files, and list keys such
  // as hooks.PreToolUse are combined rather than replaced, so registering our
  // hook never removes theirs.
  enforcementArgs(settingsPath: string): string[] {
    return ["--settings", settingsPath];
  },
  // -p / --print answers once and exits, printing plain text; everything else
  // opens the chat UI.
  isInteractive(args: string[]): boolean {
    return !args.some((a) => a === "-p" || a === "--print" || a.startsWith("--print="));
  },
};

// Claude Code only, for now. Adapters for Codex CLI and Aider existed but were
// metering-only and never tested against the real tools, so they were removed
// rather than shipped half-done.
// Keyed by the command users type. `claude-code` (the adapter id that logs and
// replays show) is accepted too, but not advertised: one name to learn.
const ADAPTERS: Record<string, AgentAdapter> = {
  claude: claudeCode,
};
const ALIASES: Record<string, string> = {
  "claude-code": "claude",
};

export function resolveAdapter(name: string): AgentAdapter | undefined {
  return ADAPTERS[ALIASES[name] ?? name];
}

export function knownAgents(): string[] {
  return Object.keys(ADAPTERS);
}
