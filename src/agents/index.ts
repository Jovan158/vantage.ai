// Agent adapters. The core knows only this interface; each adapter declares how
// to launch a given CLI agent and which env vars redirect its LLM traffic
// through the Vantage proxy (CONCEPT.md §1, "Der Klebstoff").

export interface AgentAdapter {
  id: string;
  /** Default executable name if the user doesn't pass one. */
  command: string;
  /** Upstream provider base URL this agent talks to. */
  defaultUpstream: string;
  /** Env vars that point the agent's SDK at our local proxy. */
  proxyEnv(proxyUrl: string): Record<string, string>;
}

// Claude Code respects ANTHROPIC_BASE_URL to redirect its API traffic.
const claudeCode: AgentAdapter = {
  id: "claude-code",
  command: "claude",
  defaultUpstream: "https://api.anthropic.com",
  proxyEnv(proxyUrl: string): Record<string, string> {
    return { ANTHROPIC_BASE_URL: proxyUrl };
  },
};

// Codex CLI / Aider talk to the OpenAI-compatible endpoint via OPENAI_BASE_URL.
const openaiCompatible = (id: string, command: string): AgentAdapter => ({
  id,
  command,
  defaultUpstream: "https://api.openai.com",
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
