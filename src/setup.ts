// `vantage setup <agent>`: for agents whose hooks cannot be added for one
// session, Vantage's hook is added once to their own settings. It stays out
// of the way outside Vantage sessions: it finds no session and answers
// nothing (see src/agents/hooks.ts).
//
//   gemini       ~/.gemini/settings.json         BeforeTool, AfterAgent, SessionStart
//   cursor       ~/.cursor/hooks.json            preToolUse
//   antigravity  ~/.gemini/config/plugins/vantage/  a plugin with a PreToolUse hook
//   hermes       ~/.hermes/config.yaml           pre_tool_call (shell hook)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hookCommandLine, hookInvocation } from "./hook.ts";
import { geminiSettingsPath, parseJsonc } from "./agents/gemini.ts";

export interface SetupState {
  /** Vantage's hook is in the agent's settings. */
  installed: boolean;
  /** The file it is (or would be) in. */
  file: string;
  /** It is there but runs another Vantage (moved, or a dev checkout). */
  stale?: boolean;
}

function home(): string {
  return process.env.VANTAGE_SETUP_HOME || os.homedir();
}

export function hookCommand(agent: string, entry: string, platform = process.platform): string {
  return hookCommandLine(hookInvocation(process.execPath, entry, [agent]), platform);
}

// ---------------------------------------------------------------------------
// Gemini CLI: ~/.gemini/settings.json, { hooks: { BeforeTool: [{ matcher,
// hooks: [{ type, command, name }] }], … } }. Hook lists from all settings
// files are concatenated, so the user's own hooks keep running.

type GeminiHooks = Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; name?: string; timeout?: number }> }>>;

const GEMINI_EVENTS: Array<[string, string | undefined]> = [
  ["BeforeTool", ".*"],
  ["AfterAgent", undefined],
  ["SessionStart", undefined],
];

function geminiState(entry: string): SetupState {
  const file = geminiSettingsPath();
  let cfg: { hooks?: GeminiHooks } | null = null;
  try {
    cfg = parseJsonc(fs.readFileSync(file, "utf8")) as { hooks?: GeminiHooks };
  } catch {
    return { installed: false, file };
  }
  const commands = (cfg?.hooks?.BeforeTool ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  const ours = commands.filter((c) => isVantageHook(c, "gemini"));
  if (!ours.length) return { installed: false, file };
  return { installed: true, file, stale: !ours.includes(hookCommand("gemini", entry)) };
}

export function geminiSnippet(entry: string): string {
  const command = hookCommand("gemini", entry);
  const hooks: GeminiHooks = {};
  for (const [event, matcher] of GEMINI_EVENTS) {
    hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, name: "vantage", timeout: 600000 }] }];
  }
  return JSON.stringify({ hooks }, null, 2);
}

function geminiInstall(entry: string): string[] {
  const file = geminiSettingsPath();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    /* a new file */
  }
  let cfg: Record<string, unknown>;
  try {
    cfg = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Comments would be lost on rewrite: leave the edit to the user.
    return [`${file} has comments or is not plain JSON, and Vantage does not rewrite it. Merge this into it:`, geminiSnippet(entry)];
  }
  const hooks = { ...((cfg.hooks as GeminiHooks) ?? {}) };
  const command = hookCommand("gemini", entry);
  for (const [event, matcher] of GEMINI_EVENTS) {
    const others = (hooks[event] ?? []).filter((g) => !(g.hooks ?? []).some((h) => isVantageHook(h.command, "gemini")));
    hooks[event] = [...others, { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, name: "vantage", timeout: 600000 }] }];
  }
  cfg.hooks = hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return [`${text ? "updated" : "created"} ${file}: Vantage's hook runs before Gemini CLI's tool calls, after its replies and when a session starts`];
}

// ---------------------------------------------------------------------------
// Cursor: ~/.cursor/hooks.json, { version: 1, hooks: { preToolUse: [{ command }] } }

function cursorFile(): string {
  return path.join(home(), ".cursor", "hooks.json");
}

type CursorHooks = { version?: number; hooks?: Record<string, Array<{ command?: string }>> };

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

const isVantageHook = (command: string | undefined, agent: string): boolean =>
  typeof command === "string" && new RegExp(`\\bhook['"]? ['"]?${agent}['"]?$`).test(command.trim());

function cursorState(entry: string): SetupState {
  const file = cursorFile();
  const cfg = readJson<CursorHooks>(file);
  const ours = (cfg?.hooks?.preToolUse ?? []).filter((h) => isVantageHook(h.command, "cursor"));
  if (!ours.length) return { installed: false, file };
  return { installed: true, file, stale: !ours.some((h) => h.command === hookCommand("cursor", entry)) };
}

function cursorInstall(entry: string): string[] {
  const file = cursorFile();
  const exists = fs.existsSync(file);
  const cfg = exists ? readJson<CursorHooks>(file) : { version: 1, hooks: {} };
  if (!cfg || typeof cfg !== "object") throw new Error(`${file} is not valid JSON — fix it first, then run this again`);
  cfg.version ??= 1;
  cfg.hooks ??= {};
  const list = (cfg.hooks.preToolUse ??= []).filter((h) => !isVantageHook(h.command, "cursor"));
  list.push({ command: hookCommand("cursor", entry) });
  cfg.hooks.preToolUse = list;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return [`${exists ? "updated" : "created"} ${file}: Vantage's hook runs before each of Cursor's tool calls`];
}

// ---------------------------------------------------------------------------
// Antigravity: a plugin of its own, so nothing of the user's is edited.

function antigravityDir(): string {
  return path.join(home(), ".gemini", "config", "plugins", "vantage");
}

function antigravityState(entry: string): SetupState {
  const file = path.join(antigravityDir(), "hooks.json");
  const cfg = readJson<Record<string, { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> }>>(file);
  const commands = Object.values(cfg ?? {}).flatMap((g) => (g.PreToolUse ?? []).flatMap((m) => (m.hooks ?? []).map((h) => h.command)));
  const ours = commands.filter((c) => isVantageHook(c, "antigravity"));
  if (!ours.length) return { installed: false, file };
  return { installed: true, file, stale: !ours.includes(hookCommand("antigravity", entry)) };
}

function antigravityInstall(entry: string): string[] {
  const dir = antigravityDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    JSON.stringify({ name: "vantage", description: "Vantage: rules and budgets for tool calls (see https://github.com/Jovan158/vantage.ai)" }, null, 2) + "\n"
  );
  const hooks = { vantage: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("antigravity", entry) }] }] } };
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify(hooks, null, 2) + "\n");
  return [`installed the plugin ${dir}: Vantage's hook runs before each of Antigravity's tool calls`];
}

// ---------------------------------------------------------------------------
// Hermes: a shell hook in ~/.hermes/config.yaml. YAML is only appended to
// when the file has no hooks yet; otherwise the lines to add are shown.

function hermesHome(): string {
  return process.env.HERMES_HOME || path.join(home(), ".hermes");
}

function hermesState(entry: string): SetupState {
  const file = path.join(hermesHome(), "config.yaml");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { installed: false, file };
  }
  const lines = text.split(/\r?\n/).filter((l) => /^\s*-?\s*command:/.test(l) && /\bhook['"]? ['"]?hermes/.test(l));
  if (!lines.length) return { installed: false, file };
  return { installed: true, file, stale: !lines.some((l) => l.includes(hookCommand("hermes", entry))) };
}

export function hermesSnippet(entry: string): string {
  return [
    "hooks:",
    "  pre_tool_call:",
    `    - command: ${JSON.stringify(hookCommand("hermes", entry))}`,
    "      timeout: 300",
  ].join("\n");
}

function hermesInstall(entry: string): string[] {
  const file = path.join(hermesHome(), "config.yaml");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    /* a new file */
  }
  if (/^hooks\s*:/m.test(text)) {
    hermesApprove(entry);
    return [
      `${file} already has hooks, and Vantage does not rewrite YAML it did not write. Add this under its "hooks:" key:`,
      hermesSnippet(entry).split("\n").slice(1).join("\n"),
    ];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (text && !text.endsWith("\n") ? text + "\n" : text) + hermesSnippet(entry) + "\n");
  hermesApprove(entry);
  return [`added Vantage's hook to ${file}, and approved it in Hermes's hook allowlist`];
}

// Hermes asks before running a shell hook it has not seen; running setup is
// that consent, so it is recorded the way Hermes records it.
function hermesApprove(entry: string): void {
  const file = path.join(hermesHome(), "shell-hooks-allowlist.json");
  const data = readJson<{ approvals?: Array<Record<string, unknown>> }>(file) ?? {};
  const command = hookCommand("hermes", entry);
  const approvals = (data.approvals ?? []).filter((a) => !(a.event === "pre_tool_call" && a.command === command));
  approvals.push({ event: "pre_tool_call", command, approved_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), script_mtime_at_approval: null });
  fs.writeFileSync(file, JSON.stringify({ ...data, approvals }, null, 2));
}

// ---------------------------------------------------------------------------

const SETUPS: Record<string, { state(entry: string): SetupState; install(entry: string): string[] }> = {
  gemini: { state: geminiState, install: geminiInstall },
  cursor: { state: cursorState, install: cursorInstall },
  antigravity: { state: antigravityState, install: antigravityInstall },
  hermes: { state: hermesState, install: hermesInstall },
};

export function setupAgents(): string[] {
  return Object.keys(SETUPS);
}

export function setupState(agent: string, entry: string): SetupState {
  return SETUPS[agent]?.state(entry) ?? { installed: true, file: "" };
}

export function installSetup(agent: string, entry: string): string[] {
  const s = SETUPS[agent];
  if (!s) throw new Error(`${agent} needs no setup: vantage run ${agent} adds its hooks for each session`);
  return s.install(entry);
}
