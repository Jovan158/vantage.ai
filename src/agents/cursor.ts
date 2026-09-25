// Cursor's CLI (cursor-agent) talks to Cursor's own servers in a protocol of
// its own, so its tokens and cost cannot be read. Its hooks can stop or
// question every tool call: preToolUse in ~/.cursor/hooks.json, added once
// by `vantage setup cursor` (see src/setup.ts).

import type { AgentAdapter } from "./types.ts";

export const cursor: AgentAdapter = {
  key: "cursor",
  id: "cursor",
  name: "Cursor CLI",
  short: "Cursor",
  command: "cursor-agent",
  install: "curl https://cursor.com/install -fsS | bash",
  capabilities: { meter: false, enforce: "ask", chatAlerts: false, setup: true },
  routes: () => [],
  prepare: () => ({ args: [], env: {}, notes: [], memory: false }),
  // -p / --print answers once and exits.
  isInteractive: (args) => !args.some((a) => a === "-p" || a === "--print"),
};
