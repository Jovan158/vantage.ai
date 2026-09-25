// Antigravity CLI (agy) signs in with Google and talks to Google's own
// backend, which cannot be read. Run with a Gemini API key it uses the
// Gemini API at GOOGLE_GEMINI_BASE_URL, which the proxy then reads.
//
// Its hooks come from plugins: `vantage setup antigravity` installs a small
// one whose PreToolUse hook finds the running session (see src/setup.ts).

import type { AgentAdapter } from "./types.ts";

const GEMINI_API = "https://generativelanguage.googleapis.com";

export const antigravity: AgentAdapter = {
  key: "antigravity",
  id: "antigravity",
  name: "Antigravity CLI",
  short: "Antigravity",
  command: "agy",
  install: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  capabilities: { meter: true, enforce: "ask", chatAlerts: false, setup: true },
  routes: (env) => [{ prefix: "/gemini", upstream: env.VANTAGE_UPSTREAM ?? env.GOOGLE_GEMINI_BASE_URL ?? GEMINI_API }],
  prepare(ctx) {
    const notes: string[] = [];
    if (!ctx.env.GEMINI_API_KEY) notes.push("signed in with Google, Antigravity's traffic cannot be read — tokens and cost are counted only with a Gemini API key");
    return { args: [], env: { GOOGLE_GEMINI_BASE_URL: `${ctx.proxyUrl}/gemini` }, notes, memory: false };
  },
  // -p answers once and exits.
  isInteractive: (args) => !args.some((a) => a === "-p" || a === "--print" || a === "--prompt"),
};
