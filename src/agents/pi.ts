// pi talks to many providers, each at its own address, from inside one Node
// process. Vantage's extension (loaded with -e for the session) sends the
// model requests to known provider hosts through the proxy — by rewriting
// the address inside pi's own fetch — and judges each tool call through
// `vantage hook pi`: a "deny" blocks, an "ask" asks in pi's UI. When a run is
// done, waiting alerts show as a notification. Memory goes in through
// --append-system-prompt.

import fs from "node:fs";
import path from "node:path";
import type { Route } from "../proxy.ts";
import type { AgentAdapter } from "./types.ts";

// Model API hosts pi's built-in providers use.
export const PI_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "chatgpt.com",
  "generativelanguage.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "openrouter.ai",
  "api.githubcopilot.com",
  "api.individual.githubcopilot.com",
  "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com",
  "opencode.ai",
  "ai-gateway.vercel.sh",
  "router.huggingface.co",
  "api.mistral.ai",
  "api.groq.com",
  "api.x.ai",
  "api.deepseek.com",
  "api.cerebras.ai",
  "api.together.ai",
  "api.fireworks.ai",
  "integrate.api.nvidia.com",
  "inference.baseten.co",
  "api.z.ai",
  "api.moonshot.ai",
  "api.minimax.io",
  "api.kimi.com",
];

export function piExtension(hook: { command: string; args: string[] } | null, proxy: string, hosts: string[], events: { tool: boolean; stop: boolean }): string {
  return `// Written by Vantage for one pi session (see https://github.com/Jovan158/vantage.ai).
import { spawn } from "node:child_process";

const HOOK = ${JSON.stringify(hook)};
const PROXY = ${JSON.stringify(proxy)};
const HOSTS = new Set(${JSON.stringify(hosts)});

// Model requests go through Vantage's proxy: https://<host>/<path> becomes
// <proxy>/h/<host>/<path>. Everything else is left alone.
const direct = globalThis.fetch;
globalThis.fetch = function (input, init) {
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    if (url.protocol === "https:" && HOSTS.has(url.hostname)) {
      const target = PROXY + "/h/" + url.hostname + url.pathname + url.search;
      if (typeof input === "string" || input instanceof URL) return direct.call(this, target, init);
      return direct.call(this, new Request(target, input), init);
    }
  } catch {}
  return direct.call(this, input, init);
};

function vantage(payload) {
  return new Promise((resolve) => {
    if (!HOOK) return resolve({});
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

export default function (pi) {${
    events.tool
      ? `
  pi.on("tool_call", async (event, ctx) => {
    const out = await vantage({ hook_event_name: "PreToolUse", tool_name: event.toolName, tool_input: event.input, cwd: ctx.cwd || process.cwd() });
    if (out.systemMessage && ctx.hasUI) ctx.ui.notify(out.systemMessage, "warning");
    const d = out.hookSpecificOutput;
    if (!d) return undefined;
    const reason = d.permissionDecisionReason || "Vantage";
    if (d.permissionDecision === "deny") return { block: true, reason };
    if (d.permissionDecision === "ask") {
      if (!ctx.hasUI) return { block: true, reason: reason + " There is no one to ask in this mode, so it was not run." };
      const ok = await ctx.ui.confirm("Vantage", reason);
      if (!ok) return { block: true, reason: "The user declined. " + reason };
    }
    return undefined;
  });`
      : ""
  }${
    events.stop
      ? `
  pi.on("agent_end", async (_event, ctx) => {
    const out = await vantage({ hook_event_name: "Stop", cwd: ctx.cwd || process.cwd() });
    if (out.systemMessage && ctx.hasUI) ctx.ui.notify(out.systemMessage, "warning");
  });`
      : ""
  }
}
`;
}

export const pi: AgentAdapter = {
  key: "pi",
  id: "pi",
  name: "pi",
  short: "pi",
  command: "pi",
  install: "npm install -g @earendil-works/pi-coding-agent",
  capabilities: { enforce: "ask", chatAlerts: true },
  routes: (env): Route[] => PI_HOSTS.map((host) => ({ prefix: `/h/${host}`, upstream: env.VANTAGE_UPSTREAM ?? `https://${host}` })),
  prepare(ctx) {
    const file = path.join(ctx.sessionDir, "vantage-pi.mjs");
    fs.mkdirSync(ctx.sessionDir, { recursive: true });
    const hook = ctx.enforce || ctx.chatAlerts ? ctx.hook : null;
    fs.writeFileSync(file, piExtension(hook, ctx.proxyUrl, PI_HOSTS, { tool: ctx.enforce, stop: ctx.chatAlerts }));
    const args = ["-e", file];
    if (ctx.memory) args.push("--append-system-prompt", ctx.memory);
    return { args, env: {}, notes: [], memory: Boolean(ctx.memory) };
  },
  // -p / --print answers once; --mode json and rpc are for programs.
  isInteractive: (args) =>
    !args.some((a, i) => a === "-p" || a === "--print" || ((a === "--mode" || a.startsWith("--mode=")) && (a.split("=")[1] ?? args[i + 1]) !== "text")),
};
