// `vantage doctor`: is everything Vantage relies on in place on this machine?
//
// Each check runs the real thing where it can — starts Claude Code for its
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

export function checkClaude(opts: DoctorOptions): Check {
  const env = opts.env ?? process.env;
  const override = env.VANTAGE_AGENT_PATH;
  if (override && !fs.existsSync(override)) {
    return { level: "fail", text: `VANTAGE_AGENT_PATH points at ${override}, which does not exist`, hint: "fix or unset VANTAGE_AGENT_PATH" };
  }
  const target = resolveCommand(override || "claude", { env, platform: opts.platform });
  if (!target.ok) {
    return { level: "fail", text: "Claude Code not found", hint: `${target.reason} — install it (npm install -g @anthropic-ai/claude-code) or set VANTAGE_AGENT_PATH` };
  }
  const r = spawnSync(target.resolved.command, [...target.resolved.prefix, "--version"], { env, encoding: "utf8", timeout: 20_000, windowsHide: true });
  if (r.error || r.status !== 0) {
    const why = r.error ? (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "not found on PATH" : r.error.message : firstLine(r.stderr) || `exit ${r.status}`;
    return { level: "fail", text: `Claude Code could not be started (${why})`, hint: "install Claude Code or set VANTAGE_AGENT_PATH to its executable" };
  }
  const where = override ? ` via VANTAGE_AGENT_PATH` : target.resolved.command === "claude" ? "" : ` (${target.resolved.command})`;
  const version = firstLine(r.stdout).replace(/\s*\(Claude Code\)$/, "");
  return { level: "ok", text: `Claude Code ${version}${where}` };
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

export function runDoctor(opts: DoctorOptions): Check[] {
  return [
    checkNode(),
    checkClaude(opts),
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
