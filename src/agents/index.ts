// The agents Vantage runs, keyed by the name users type.

import { claudeCode } from "./claude.ts";
import { codex } from "./codex.ts";
import { gemini } from "./gemini.ts";
import { copilot } from "./copilot.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";
import { hermes } from "./hermes.ts";
import { cursor } from "./cursor.ts";
import { antigravity } from "./antigravity.ts";
import type { AgentAdapter } from "./types.ts";

export type { AgentAdapter, Capabilities, LaunchContext, LaunchPlan } from "./types.ts";

export const AGENTS: AgentAdapter[] = [claudeCode, codex, copilot, gemini, opencode, pi, hermes, cursor, antigravity];

// By the name users type, or the id session logs show (`claude-code` is
// accepted too, but not advertised: one name to learn).
export function resolveAdapter(name: string): AgentAdapter | undefined {
  return AGENTS.find((a) => a.key === name) ?? AGENTS.find((a) => a.id === name);
}

export function knownAgents(): string[] {
  return AGENTS.map((a) => a.key);
}

// How the agent is called in messages and sentences, from the id in a
// session's log (older logs name no agent: they are Claude Code's).
export function agentName(id: string | undefined): string {
  return (id && resolveAdapter(id)?.name) || (id ?? "Claude Code");
}

export function agentShort(id: string | undefined): string {
  return (id && resolveAdapter(id)?.short) || (id ?? "Claude");
}
