// Hermes Agent (Nous Research) reads each provider's address from an
// environment variable (ANTHROPIC_BASE_URL, OPENAI_BASE_URL,
// OPENROUTER_BASE_URL, …); Vantage sets them to the proxy for the session.
//
// Its hooks come only from ~/.hermes/config.yaml, so Vantage's is added once
// (`vantage setup hermes`, see src/setup.ts) and finds the running session
// itself. A pre_tool_call hook blocks with { decision: "block" }; newer
// versions also send a call to their approval prompt with { action:
// "approve" } — older ones ignore that, so there an "ask" rule blocks.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Route } from "../proxy.ts";
import type { AgentAdapter } from "./types.ts";

// Environment variable → the provider's own address.
const PROVIDERS: Array<[string, string, string]> = [
  ["anthropic", "ANTHROPIC_BASE_URL", "https://api.anthropic.com"],
  ["openai", "OPENAI_BASE_URL", "https://api.openai.com/v1"],
  ["openrouter", "OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"],
  ["nous", "NOUS_INFERENCE_BASE_URL", "https://inference-api.nousresearch.com/v1"],
  ["codex", "HERMES_CODEX_BASE_URL", "https://chatgpt.com/backend-api/codex"],
  ["gemini", "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"],
  ["xai", "XAI_BASE_URL", "https://api.x.ai/v1"],
  ["deepseek", "DEEPSEEK_BASE_URL", "https://api.deepseek.com/v1"],
  ["zen", "OPENCODE_ZEN_BASE_URL", "https://opencode.ai/zen/v1"],
];

// Whether this Hermes can send a tool call to its approval prompt from a
// shell hook: its hook module knows the "approve" action.
function canApprove(command: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const r = spawnSync(command, ["--version"], { env, encoding: "utf8", timeout: 15_000, windowsHide: true, shell: process.platform === "win32" });
    const dir = /Install directory:\s*(.+)/.exec(r.stdout ?? "")?.[1]?.trim();
    if (!dir) return false;
    const source = fs.readFileSync(path.join(dir, "agent", "shell_hooks.py"), "utf8");
    return /["']approve["']/.test(source);
  } catch {
    return false;
  }
}

export const hermes: AgentAdapter = {
  key: "hermes",
  id: "hermes",
  name: "Hermes Agent",
  short: "Hermes",
  command: "hermes",
  install: "pip install hermes-agent",
  capabilities: { meter: true, enforce: "ask", chatAlerts: false, setup: true },
  routes: (env): Route[] => PROVIDERS.map(([id, variable, url]) => ({ prefix: `/${id}`, upstream: env.VANTAGE_UPSTREAM ?? env[variable] ?? url })),
  prepare(ctx) {
    const env: Record<string, string> = {};
    for (const [id, variable] of PROVIDERS) env[variable] = `${ctx.proxyUrl}/${id}`;
    const notes: string[] = [];
    const hookConfig: Record<string, string> = {};
    if (ctx.enforce && !canApprove(ctx.env.VANTAGE_AGENT_PATH || "hermes", ctx.env)) {
      hookConfig.VANTAGE_ASK_MODE = "block";
      notes.push("this Hermes version cannot ask from a hook: actions a rule says to ask about are blocked — update Hermes to be asked instead");
    }
    return { args: [], env, notes, memory: false, hookConfig };
  },
  // -q/--query and -z answer once; the rest opens the chat.
  isInteractive: (args) => !args.some((a) => ["-q", "--query", "--query-file", "-z", "-Q", "--oneshot"].includes(a) || a.startsWith("--query=")),
};
