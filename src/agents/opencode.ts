// OpenCode reaches many providers through the AI SDK. The Anthropic and
// OpenAI clients honor ANTHROPIC_BASE_URL and OPENAI_BASE_URL; the others
// take a baseURL from OpenCode's config, which OPENCODE_CONFIG_CONTENT adds
// to for one session. A provider the user already points somewhere else
// keeps that address — it becomes the upstream.
//
// Hooks come as a plugin (named in the same config): before each tool call
// it asks `vantage hook opencode`, and throws to block. When a reply is done
// it shows waiting alerts as a toast.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Route } from "../proxy.ts";
import type { AgentAdapter } from "./types.ts";

// Providers whose address comes from the config, with their default.
const CONFIG_PROVIDERS: Record<string, string> = {
  google: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
  "github-copilot": "https://api.githubcopilot.com",
  opencode: "https://opencode.ai/zen/v1",
  xai: "https://api.x.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai/v1",
};

// The user's resolved OpenCode config, for the addresses they set. Asking
// OpenCode itself is the only way to see every file it merges.
function userConfig(command: string, env: NodeJS.ProcessEnv): { provider?: Record<string, { options?: { baseURL?: string } }> } {
  try {
    const r = spawnSync(command, ["debug", "config"], { env, encoding: "utf8", timeout: 10_000, windowsHide: true, shell: process.platform === "win32" });
    return r.status === 0 ? (JSON.parse(r.stdout) as ReturnType<typeof userConfig>) : {};
  } catch {
    return {};
  }
}

const routeCache = new WeakMap<NodeJS.ProcessEnv, Route[]>();

function opencodeRoutes(env: NodeJS.ProcessEnv): Route[] {
  const cached = routeCache.get(env);
  if (cached) return cached;
  const cfg = env.VANTAGE_OPENCODE_SKIP_CONFIG ? {} : userConfig(env.VANTAGE_AGENT_PATH || "opencode", env);
  const upstream = (fallback: string, own?: string): string => env.VANTAGE_UPSTREAM ?? own ?? fallback;
  const routes: Route[] = [
    { prefix: "/anthropic", upstream: upstream("https://api.anthropic.com/v1", env.ANTHROPIC_BASE_URL) },
    { prefix: "/openai", upstream: upstream("https://api.openai.com/v1", env.OPENAI_BASE_URL) },
  ];
  for (const [id, url] of Object.entries(CONFIG_PROVIDERS)) {
    routes.push({ prefix: `/p/${id}`, upstream: upstream(url, cfg.provider?.[id]?.options?.baseURL) });
  }
  routeCache.set(env, routes);
  return routes;
}

// The plugin, written for the session with the hook command filled in. It
// runs inside OpenCode (Bun), so it only uses what Node and Bun share.
export function opencodePlugin(hook: { command: string; args: string[] }, events: { tool: boolean; stop: boolean }): string {
  return `// Written by Vantage for one OpenCode session (see https://github.com/Jovan158/vantage.ai).
import { spawn } from "node:child_process";

const HOOK = ${JSON.stringify(hook)};

function vantage(payload) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(HOOK.command, HOOK.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve({}));
    child.on("close", () => {
      try {
        resolve(out ? JSON.parse(out) : {});
      } catch {
        resolve({});
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export const Vantage = async ({ directory, client }) => {
  const toast = (message) =>
    client?.tui?.showToast?.({ body: { title: "Vantage", message, variant: "warning", duration: 10000 } })?.catch?.(() => {});
  return {${
    events.tool
      ? `
    "tool.execute.before": async (input, output) => {
      const out = await vantage({ hook_event_name: "PreToolUse", tool_name: input.tool, tool_input: output.args, cwd: directory });
      const d = out.hookSpecificOutput;
      if (out.systemMessage) toast(out.systemMessage);
      if (d && (d.permissionDecision === "deny" || d.permissionDecision === "ask")) {
        throw new Error(d.permissionDecisionReason || "Blocked by Vantage");
      }
    },`
      : ""
  }${
    events.stop
      ? `
    event: async ({ event }) => {
      if (event?.type !== "session.idle") return;
      const out = await vantage({ hook_event_name: "Stop", cwd: directory });
      if (out.systemMessage) toast(out.systemMessage);
    },`
      : ""
  }
  };
};
`;
}

// Deep merge for the session's config over a user's own OPENCODE_CONFIG_CONTENT;
// lists (plugins, instructions) are joined.
function merge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  }
  return b;
}

export const opencode: AgentAdapter = {
  key: "opencode",
  id: "opencode",
  name: "OpenCode",
  short: "OpenCode",
  command: "opencode",
  install: "npm install -g opencode-ai",
  // A plugin can stop a tool call but not ask about it (see hooks.ts).
  capabilities: { meter: true, enforce: "deny-only", chatAlerts: true },
  routes: opencodeRoutes,
  prepare(ctx) {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: `${ctx.proxyUrl}/anthropic`,
      OPENAI_BASE_URL: `${ctx.proxyUrl}/openai`,
    };
    const config: Record<string, unknown> = {
      provider: Object.fromEntries(Object.keys(CONFIG_PROVIDERS).map((id) => [id, { options: { baseURL: `${ctx.proxyUrl}/p/${id}` } }])),
    };
    const notes: string[] = [];
    if (ctx.enforce || ctx.chatAlerts) {
      const file = path.join(ctx.sessionDir, "vantage-opencode.js");
      fs.mkdirSync(ctx.sessionDir, { recursive: true });
      fs.writeFileSync(file, opencodePlugin(ctx.hook, { tool: ctx.enforce, stop: ctx.chatAlerts }));
      config.plugin = [pathToFileURL(file).href];
    }
    if (ctx.enforce) notes.push("OpenCode plugins can block but not ask: actions a rule says to ask about are blocked, and OpenCode is told to leave them to you");
    if (ctx.memory) config.instructions = [ctx.memoryFile];
    let own: unknown = {};
    try {
      own = ctx.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(ctx.env.OPENCODE_CONFIG_CONTENT) : {};
    } catch {
      own = {};
    }
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(merge(own, config));
    return { args: [], env, notes, memory: Boolean(ctx.memory) };
  },
  // `run` answers once and exits; serve, web and acp have no TUI either.
  isInteractive: (args) => {
    const first = args.find((a) => !a.startsWith("-"));
    return !["run", "serve", "web", "acp", "debug", "auth", "models", "stats", "export", "import", "upgrade", "mcp", "github", "agent"].includes(first ?? "");
  },
};
