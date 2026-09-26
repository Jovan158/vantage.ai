// Claude Code respects ANTHROPIC_BASE_URL to redirect its API traffic,
// --append-system-prompt to inject extra context without touching any file,
// and --settings to add hooks for one session.

import fs from "node:fs";
import path from "node:path";
import { hookSettings } from "../hook.ts";
import type { AgentAdapter } from "./types.ts";

export const claudeCode: AgentAdapter = {
  key: "claude",
  id: "claude-code",
  name: "Claude Code",
  short: "Claude",
  command: "claude",
  install: "npm install -g @anthropic-ai/claude-code",
  capabilities: { enforce: "ask", chatAlerts: true },
  routes: (env) => [{ prefix: "", upstream: env.VANTAGE_UPSTREAM ?? "https://api.anthropic.com" }],
  prepare(ctx) {
    const args: string[] = [];
    // --settings is merged with the user's own settings files, and list keys
    // such as hooks.PreToolUse are combined rather than replaced, so
    // registering our hook never removes theirs.
    if (ctx.enforce || ctx.chatAlerts) {
      const file = path.join(ctx.sessionDir, "hook-settings.json");
      fs.mkdirSync(ctx.sessionDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(hookSettings(ctx.hook, { preToolUse: ctx.enforce, stop: ctx.chatAlerts }), null, 2));
      args.push("--settings", file);
    }
    if (ctx.memory) args.push("--append-system-prompt", ctx.memory);
    return { args, env: { ANTHROPIC_BASE_URL: ctx.proxyUrl }, notes: [], memory: Boolean(ctx.memory) };
  },
  // -p / --print answers once and exits, printing plain text; everything else
  // opens the chat UI.
  isInteractive: (args) => !args.some((a) => a === "-p" || a === "--print" || a.startsWith("--print=")),
};
