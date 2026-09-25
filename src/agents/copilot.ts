// GitHub Copilot CLI talks to the Copilot API, or — with a model provider of
// your own (BYOK) — to COPILOT_PROVIDER_BASE_URL. COPILOT_API_URL moves the
// first, and Vantage wraps the second, so either reaches the proxy.
//
// Hooks come for one session from a plugin directory (--plugin-dir). Under
// Claude Code's PascalCase event names Copilot sends Claude's payload, with
// Claude's tool names (Bash, Read, Edit, …), and takes its answer.

import fs from "node:fs";
import path from "node:path";
import type { AgentAdapter } from "./types.ts";

const COPILOT_API = "https://api.githubcopilot.com";

// The plugin that registers Vantage's hooks for the session.
export function copilotPlugin(dir: string, hook: { command: string; args: string[] }, events: { tool: boolean; stop: boolean }): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ name: "vantage", version: "1.0.0", description: "Vantage: rules, budgets and alerts for this session" }, null, 2)
  );
  const entry = { type: "command", exec: hook.command, args: hook.args, timeoutSec: 600 };
  const hooks: Record<string, object[]> = {};
  if (events.tool) hooks.PreToolUse = [{ matcher: "*", ...entry }];
  if (events.stop) hooks.Stop = [entry];
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ version: 1, hooks }, null, 2));
}

export const copilot: AgentAdapter = {
  key: "copilot",
  id: "copilot",
  name: "Copilot CLI",
  short: "Copilot",
  command: "copilot",
  install: "npm install -g @github/copilot",
  capabilities: { meter: true, enforce: "ask", chatAlerts: true, setup: false },
  routes: (env) =>
    env.COPILOT_PROVIDER_BASE_URL
      ? [{ prefix: "/copilot-byok", upstream: env.VANTAGE_UPSTREAM ?? env.COPILOT_PROVIDER_BASE_URL }]
      : [{ prefix: "/copilot", upstream: env.VANTAGE_UPSTREAM ?? env.COPILOT_API_URL ?? COPILOT_API }],
  prepare(ctx) {
    const env: Record<string, string> = ctx.env.COPILOT_PROVIDER_BASE_URL
      ? { COPILOT_PROVIDER_BASE_URL: `${ctx.proxyUrl}/copilot-byok` }
      : { COPILOT_API_URL: `${ctx.proxyUrl}/copilot` };
    const args: string[] = [];
    if (ctx.enforce || ctx.chatAlerts) {
      const dir = path.join(ctx.sessionDir, "copilot-plugin");
      copilotPlugin(dir, ctx.hook, { tool: ctx.enforce, stop: ctx.chatAlerts });
      args.push("--plugin-dir", dir);
    }
    // Extra instruction directories are searched for *.instructions.md.
    let memory = false;
    if (ctx.memory) {
      const dir = path.join(ctx.sessionDir, "copilot-instructions");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "vantage-memory.instructions.md"), ctx.memory);
      const existing = ctx.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
      env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS = existing ? `${existing}${path.delimiter}${dir}` : dir;
      memory = true;
    }
    return { args, env, notes: [], memory };
  },
  // -p / --prompt runs one prompt and exits; -i opens the chat with it.
  isInteractive: (args) => !args.some((a) => a === "-p" || a === "--prompt" || a.startsWith("--prompt=")),
};
