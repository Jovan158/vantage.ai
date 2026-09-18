// Agent adapters. The core knows only this interface; each adapter declares how
// to launch a given CLI agent and which env vars redirect its LLM traffic
// through the Vantage proxy (CONCEPT.md §1, "Der Klebstoff").

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
};

// Codex CLI / Aider talk to the OpenAI-compatible endpoint via OPENAI_BASE_URL.
const openaiCompatible = (id: string, command: string): AgentAdapter => ({
  id,
  command,
  defaultUpstream: "https://api.openai.com",
  provider: "openai",
  proxyEnv(proxyUrl: string): Record<string, string> {
    return { OPENAI_BASE_URL: proxyUrl, OPENAI_API_BASE: proxyUrl };
  },
});

const ADAPTERS: Record<string, AgentAdapter> = {
  claude: claudeCode,
  "claude-code": claudeCode,
  codex: openaiCompatible("codex", "codex"),
  aider: openaiCompatible("aider", "aider"),
};

export function resolveAdapter(name: string): AgentAdapter | undefined {
  return ADAPTERS[name];
}

export function knownAgents(): string[] {
  return Object.keys(ADAPTERS);
}
