// Gemini CLI talks to the Gemini API (with an API key) or to Code Assist
// (signed in with Google); GOOGLE_GEMINI_BASE_URL and CODE_ASSIST_ENDPOINT
// point either at the proxy.
//
// Its hooks come only from settings files, and the ones that could be given
// for one session (system settings) must be owned by root. So Vantage's hook
// is added once to ~/.gemini/settings.json (`vantage setup gemini`) and finds
// the running session itself: BeforeTool judges each tool call, AfterAgent
// shows alerts when a reply is finished, SessionStart gives project memory.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter } from "./types.ts";

const GEMINI_API = "https://generativelanguage.googleapis.com";
const CODE_ASSIST = "https://cloudcode-pa.googleapis.com";

export function geminiSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.GEMINI_CLI_HOME || os.homedir(), ".gemini", "settings.json");
}

// Settings files may carry comments.
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// How the user signed in, as their settings record it (undefined: Gemini CLI
// works it out from the environment each time).
function selectedAuthType(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const s = parseJsonc(fs.readFileSync(geminiSettingsPath(env), "utf8")) as { security?: { auth?: { selectedType?: string } }; selectedAuthType?: string };
    return s.security?.auth?.selectedType ?? s.selectedAuthType;
  } catch {
    return undefined;
  }
}

export const gemini: AgentAdapter = {
  key: "gemini",
  id: "gemini",
  name: "Gemini CLI",
  short: "Gemini",
  command: "gemini",
  install: "npm install -g @google/gemini-cli",
  capabilities: { meter: true, enforce: "ask", chatAlerts: true, setup: true },
  routes: (env) => [
    { prefix: "/gemini", upstream: env.VANTAGE_UPSTREAM ?? env.GOOGLE_GEMINI_BASE_URL ?? GEMINI_API },
    { prefix: "/code-assist", upstream: env.VANTAGE_UPSTREAM ?? env.CODE_ASSIST_ENDPOINT ?? CODE_ASSIST },
  ],
  prepare(ctx) {
    const env: Record<string, string> = { CODE_ASSIST_ENDPOINT: `${ctx.proxyUrl}/code-assist` };
    const notes: string[] = [];
    // A base URL of its own makes Gemini CLI treat an API key found only in
    // the environment as a gateway key, which its one-shot mode rejects. So
    // the API route is used when the sign-in method is settled.
    if (ctx.env.GOOGLE_GEMINI_BASE_URL || selectedAuthType(ctx.env)) env.GOOGLE_GEMINI_BASE_URL = `${ctx.proxyUrl}/gemini`;
    else notes.push("Gemini CLI has no sign-in method saved, so API-key requests are not metered — pick one with /auth once");
    return { args: [], env, notes, memory: Boolean(ctx.memory) };
  },
  // -p / --prompt answers once and exits.
  isInteractive: (args) => !args.some((a) => a === "-p" || a === "--prompt" || a.startsWith("--prompt=")),
};
