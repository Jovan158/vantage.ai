// `vantage doctor`: is everything Vantage relies on in place on this machine?
//
// Each check runs the real thing where it can — starts each agent for its
// version, runs the registered hook the way Claude Code would — so a pass
// means it works, not just that a file exists. Every problem comes with what
// to do about it.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveCommand } from "./resolve.ts";
import { hookInvocation } from "./hook.ts";
import { loadRules, policyFilePath } from "./rules.ts";
import { activePrices, STALE_AFTER_DAYS } from "./pricing.ts";
import { vantageHome, knownSessions, sessionRunning } from "./home.ts";
import { AGENTS, type AgentAdapter } from "./agents/index.ts";
import { setupState } from "./setup.ts";

export type CheckLevel = "ok" | "warn" | "fail" | "info";

export interface Check {
  level: CheckLevel;
  text: string;
  /** What to do about a warn or fail; shown for those only. */
  hint?: string;
  /** Shown whatever the level. */
  note?: string;
}

export interface DoctorOptions {
  cwd: string;
  /** Path of the CLI entry, for the hook check. */
  entry: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nowMs?: number;
}

function firstLine(s: string | null | undefined): string {
  return (s ?? "").trim().split(/\r?\n/)[0] ?? "";
}

export function checkNode(version = process.versions.node): Check {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const ok = major > 22 || (major === 22 && minor >= 6);
  return ok
    ? { level: "ok", text: `Node.js ${version}` }
    : { level: "fail", text: `Node.js ${version} is too old`, hint: "install Node.js 22.6 or newer" };
}

// Is the agent installed and does it start? `required`: a missing agent is
// a problem (it was asked about, or it is the only one) rather than a note.
export function checkAgent(adapter: AgentAdapter, opts: DoctorOptions, required = true): Check {
  const env = opts.env ?? process.env;
  const override = env.VANTAGE_AGENT_PATH;
  if (override && !fs.existsSync(override)) {
    return { level: "fail", text: `VANTAGE_AGENT_PATH points at ${override}, which does not exist`, hint: "fix or unset VANTAGE_AGENT_PATH" };
  }
  const target = resolveCommand(override || adapter.command, { env, platform: opts.platform });
  if (!target.ok) {
    return required
      ? { level: "fail", text: `${adapter.name} not found`, hint: `${target.reason} — install it (${adapter.install}) or set VANTAGE_AGENT_PATH` }
      : { level: "info", text: `${adapter.name} not installed` };
  }
  const r = spawnSync(target.resolved.command, [...target.resolved.prefix, "--version"], { env, encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (r.error || r.status !== 0) {
    const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
    if (missing && !required) return { level: "info", text: `${adapter.name} not installed` };
    const why = r.error ? (missing ? "not found on PATH" : r.error.message) : firstLine(r.stderr) || `exit ${r.status}`;
    return { level: "fail", text: `${adapter.name} could not be started (${why})`, hint: `install it (${adapter.install}) or set VANTAGE_AGENT_PATH to its executable` };
  }
  const where = override ? ` via VANTAGE_AGENT_PATH` : target.resolved.command === adapter.command ? "" : ` (${target.resolved.command})`;
  // Agents print their version in their own words; the number is enough.
  const line = firstLine(r.stdout);
  const version = /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(line)?.[0] ?? line;
  const setup = adapter.capabilities.setup ? checkSetup(adapter, opts) : null;
  const check: Check = { level: "ok", text: `${adapter.name} ${version}${where}` };
  if (setup) Object.assign(check, setup);
  return check;
}

// An agent whose hook is set up once: is it, and for this Vantage?
function checkSetup(adapter: AgentAdapter, opts: DoctorOptions): Partial<Check> | null {
  const s = setupState(adapter.key, opts.entry);
  if (!s.installed) return { level: "warn", hint: `its hook is not set up, so rules, budgets and alerts are off: vantage setup ${adapter.key}` };
  if (s.stale) return { level: "warn", hint: `its hook runs another Vantage (moved or reinstalled): vantage setup ${adapter.key}` };
  return null;
}

export function checkClaude(opts: DoctorOptions): Check {
  return checkAgent(AGENTS[0]!, opts);
}

// Every agent Vantage knows: the ones installed, and a note for the rest.
// Without any installed agent there is nothing to run. VANTAGE_AGENT_PATH
// names one executable; without an agent named, it is Claude Code's.
export function checkAgents(opts: DoctorOptions): Check[] {
  const env = opts.env ?? process.env;
  const checks = AGENTS.map((a, i) => checkAgent(a, i === 0 ? opts : { ...opts, env: { ...env, VANTAGE_AGENT_PATH: "" } }, false));
  if (checks.every((c) => c.level === "info")) {
    return [{ level: "fail", text: "no coding agent found", hint: `install one, e.g. ${AGENTS[0]!.install}` }, ...checks];
  }
  return checks;
}

// Runs the hook exactly as registered for Claude Code (exec form, no shell)
// with a call a deny rule must block.
export function checkHook(opts: DoctorOptions): Check {
  const inv = hookInvocation(process.execPath, opts.entry);
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo vantage-doctor" }, cwd: opts.cwd });
  const r = spawnSync(inv.command, inv.args, {
    input: payload,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...(opts.env ?? process.env), VANTAGE_POLICY: "shell:deny", VANTAGE_POLICY_FILE: "", VANTAGE_EVENTS_FILE: "" },
    windowsHide: true,
  });
  try {
    const decision = JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
    if (decision === "deny") return { level: "ok", text: "approval hook runs and blocks (as Claude Code starts it, without a shell)" };
  } catch {
    /* fall through */
  }
  return { level: "fail", text: "approval hook did not answer as expected", hint: firstLine(r.stderr) || "run `vantage hook` by hand to see the error" };
}

export function checkGit(opts: DoctorOptions): Check {
  const v = spawnSync("git", ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (v.error || v.status !== 0) {
    return { level: "warn", text: "git not found", hint: "install git for change summaries and --isolate" };
  }
  const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: opts.cwd, encoding: "utf8", timeout: 10_000, windowsHide: true });
  const repo = inRepo.status === 0 ? "this folder is a git repository: sessions end with a change summary" : "this folder is not a git repository: no change summary here";
  return { level: "ok", text: `${firstLine(v.stdout)} · ${repo}` };
}

export function checkHome(): Check {
  const home = vantageHome();
  try {
    fs.mkdirSync(home, { recursive: true });
    const probe = path.join(home, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe);
    return { level: "ok", text: `settings folder is writable (${home})` };
  } catch (err) {
    return { level: "fail", text: `cannot write to ${home}`, hint: `${(err as Error).message} — or point VANTAGE_HOME elsewhere` };
  }
}

export function checkPolicy(opts: DoctorOptions): Check {
  const file = policyFilePath(opts.cwd);
  if (!fs.existsSync(file)) return { level: "info", text: "no rules for this folder", note: "`vantage policy init` creates a starter set" };
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { level: "fail", text: `${path.relative(opts.cwd, file)} is not valid JSON — its rules are not applied`, hint: (err as Error).message };
  }
  const rules = loadRules(file);
  return { level: "ok", text: `${rules.length} file/command rule(s) in ${path.relative(opts.cwd, file)}` };
}

export function checkPrices(nowMs = Date.now()): Check {
  const p = activePrices();
  if (p.cacheError) return { level: "warn", text: "downloaded price list ignored", hint: p.cacheError };
  const days = Math.floor((nowMs - Date.parse(p.asOf)) / 86_400_000);
  if (days >= STALE_AFTER_DAYS) return { level: "warn", text: `price list is ${days} days old`, hint: "`vantage pricing update`" };
  return { level: "ok", text: `price list from ${p.asOf.slice(0, 10)} (${Object.keys(p.models).length} models)` };
}

export function checkSessions(opts: DoctorOptions): Check {
  const all = knownSessions(opts.cwd);
  const running = all.filter((r) => sessionRunning(r)).length;
  return { level: "info", text: `${all.length} session(s) recorded, ${running} running` };
}

// `agent`: only that one, required; otherwise all of them.
export function runDoctor(opts: DoctorOptions, agent?: AgentAdapter): Check[] {
  return [
    checkNode(),
    ...(agent ? [checkAgent(agent, opts)] : checkAgents(opts)),
    checkHook(opts),
    checkGit(opts),
    checkHome(),
    checkPolicy(opts),
    checkPrices(opts.nowMs),
    checkSessions(opts),
  ];
}

export function renderDoctor(checks: Check[], color = true): string {
  const paint: Record<CheckLevel, string> = color
    ? { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m", info: "\x1b[2m" }
    : { ok: "", warn: "", fail: "", info: "" };
  const reset = color ? "\x1b[0m" : "";
  const dim = color ? "\x1b[2m" : "";
  const lines = [`${color ? "\x1b[1m" : ""}vantage doctor${reset}`, ""];
  for (const c of checks) {
    lines.push(`  ${paint[c.level]}${c.level.padEnd(4)}${reset}  ${c.text}`);
    const extra = c.level === "warn" || c.level === "fail" ? c.hint : undefined;
    for (const line of [extra, c.note].filter(Boolean)) lines.push(`        ${dim}${line}${reset}`);
  }
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  lines.push("");
  lines.push(
    fails
      ? `${paint.fail}${fails} problem(s) to fix${reset}${warns ? `, ${warns} warning(s)` : ""}`
      : warns
        ? `${paint.warn}Ready, with ${warns} warning(s)${reset}`
        : `${paint.ok}Everything is in place.${reset}`
  );
  return lines.join("\n");
}
