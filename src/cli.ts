// vantage — control & transparency layer over AI-coding CLI agents.
//
// MVP command surface:
//   vantage run <agent> [-- <agent args...>]   wrap a real agent, meter it live
//   vantage demo                               run the full chain against a mock
//   vantage --help
//
// The proxy/usage core is proven in spike/proxy-passthrough and ported to src/.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "./proxy.ts";
import { Meter } from "./meter.ts";
import {
  EventLog,
  newSessionId,
  sessionDir,
  sessionEventsPath,
  type UsageEvent,
} from "./events.ts";
import { resolveAdapter, knownAgents } from "./agents/index.ts";
import { startMockAnthropic } from "./dev/mock-anthropic.ts";
import { QuotaWatcher } from "./ratelimit.ts";
import type { QuotaWarning } from "./ratelimit.ts";
import { renderTimeline, listSessions } from "./replay.ts";
import { renderLive, newestSessionId, readSessionEvents } from "./watch.ts";
import { collectHarvest, renderHarvest, worthHarvesting } from "./harvest.ts";
import { compileMemory, initMemory, addNote, memoryDir } from "./memory.ts";
import { loadPolicy, PolicyWatcher, needsEnforcement } from "./policy.ts";
import type { Policy } from "./policy.ts";
import { runHook, hookSettings, hookInvocation } from "./hook.ts";
import { resolveCommand } from "./resolve.ts";
import {
  BudgetGuard,
  budgetStatePath,
  formatBudget,
  hasBudget,
  parseCost,
  parseQuota,
  readBudgetState,
  type Budget,
  type BudgetChange,
} from "./budget.ts";
import {
  formatCost,
  pricingHints,
  activePrices,
  resetActivePrices,
  writePricingCache,
  pricingCachePath,
  type PriceEntry,
} from "./pricing.ts";
import { fetchPriceTable, pricingSourceUrl, diffPrices, hasDrift, formatChange } from "./pricing-source.ts";
import {
  isGitRepo,
  isDirty,
  addSessionWorktree,
  commitSessionWork,
  sessionDiff,
  removeSessionWorktree,
  gitSafe,
  type Worktree,
} from "./git.ts";

interface SessionMeta {
  sessionId: string;
  agent: string;
  cwd: string;
  isolated: boolean;
  branch?: string;
  baseSha?: string;
  worktreePath?: string;
  createdAt: string;
}

function writeMeta(cwd: string, meta: SessionMeta): void {
  const dir = sessionDir(cwd, meta.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

function readMeta(cwd: string, sessionId: string): SessionMeta | null {
  const p = path.join(sessionDir(cwd, sessionId), "meta.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function log(msg: string): void {
  process.stderr.write(`\x1b[2m[vantage]\x1b[0m ${msg}\n`);
}

function warn(w: QuotaWarning): void {
  const color = w.level === "critical" ? "\x1b[1;31m" : "\x1b[1;33m"; // red / yellow
  const icon = w.level === "critical" ? "⛔" : "⚠";
  process.stderr.write(`${color}[vantage] ${icon}  ${w.message}\x1b[0m\n`);
}

// Warn threshold as a fraction 0..1. VANTAGE_QUOTA_WARN accepts a fraction
// (0.8) or a percent (80); default 90%.
function warnThreshold(): number {
  const raw = process.env.VANTAGE_QUOTA_WARN;
  if (!raw) return 0.9;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0.9;
  return n > 1 ? Math.min(n / 100, 1) : n;
}

function printHelp(): void {
  process.stdout.write(
    `vantage — see and control what Claude Code does\n\n` +
      `Usage:\n` +
      `  vantage run [--isolate] [--no-memory] [--max-cost <usd>] [--max-quota <percent>]\n` +
      `              <agent> [-- <agent args...>]\n` +
      `  vantage watch [sessionId]\n` +
      `  vantage sessions\n` +
      `  vantage replay <sessionId>\n` +
      `  vantage harvest [sessionId]\n` +
      `  vantage review <sessionId>\n` +
      `  vantage discard <sessionId>\n` +
      `  vantage memory <init|show|add <category> <text>>\n` +
      `  vantage policy\n` +
      `  vantage pricing [update|check]\n` +
      `  vantage demo\n` +
      `  vantage --help\n\n` +
      `Agents: ${knownAgents().join(", ")}\n\n` +
      `--isolate runs the agent in a dedicated git worktree/branch so your\n` +
      `working tree is untouched; review or discard the changes afterwards.\n` +
      `Project memory under .vantage/memory/ is injected into the agent unless\n` +
      `--no-memory is given.\n\n` +
      `--max-cost 2 / --max-quota 80 set a budget: once the session's estimated\n` +
      `cost reaches $2, or a subscription quota window 80%, every action needs\n` +
      `your approval. Also settable as VANTAGE_MAX_COST / VANTAGE_MAX_QUOTA.\n\n` +
      `VANTAGE_AGENT_PATH=<path> starts the agent from that executable instead of\n` +
      `looking it up on PATH.\n\n` +
      `Prices come from Anthropic's official list: a copy ships with vantage, and\n` +
      `\`vantage pricing update\` fetches the current one. Nothing is fetched\n` +
      `unless you run that command.\n`
  );
}

async function cmdRun(argv: string[]): Promise<number> {
  // Leading vantage-level flags come before the agent name.
  let isolate = false;
  let useMemory = true;
  let costRaw = process.env.VANTAGE_MAX_COST;
  let quotaRaw = process.env.VANTAGE_MAX_QUOTA;
  const rest = [...argv];
  while (rest[0]?.startsWith("--")) {
    const arg = rest.shift()!;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = (): string | undefined => (eq === -1 ? rest.shift() : arg.slice(eq + 1));
    if (flag === "--isolate") isolate = true;
    else if (flag === "--no-isolate") isolate = false;
    else if (flag === "--no-memory") useMemory = false;
    else if (flag === "--max-cost") costRaw = value();
    else if (flag === "--max-quota") quotaRaw = value();
    else {
      log(`unknown flag "${flag}"`);
      return 1;
    }
  }

  const budget: Budget = { maxCostUsd: null, maxQuota: null };
  if (costRaw !== undefined) {
    budget.maxCostUsd = parseCost(costRaw);
    if (budget.maxCostUsd === null) {
      log(`--max-cost needs an amount in USD, e.g. --max-cost 2 (got "${costRaw}")`);
      return 1;
    }
  }
  if (quotaRaw !== undefined) {
    budget.maxQuota = parseQuota(quotaRaw);
    if (budget.maxQuota === null) {
      log(`--max-quota needs a percentage, e.g. --max-quota 80 (got "${quotaRaw}")`);
      return 1;
    }
  }

  const agentName = rest[0];
  if (!agentName) {
    log("missing agent name. try: vantage run claude");
    return 1;
  }
  const adapter = resolveAdapter(agentName);
  if (!adapter) {
    log(`unknown agent "${agentName}". known: ${knownAgents().join(", ")}`);
    return 1;
  }

  // Everything after "--" (or after the agent name) is passed to the agent.
  const afterAgent = rest.slice(1);
  const sep = afterAgent.indexOf("--");
  const agentArgs = sep === -1 ? afterAgent : afterAgent.slice(sep + 1);

  const upstream = process.env.VANTAGE_UPSTREAM ?? adapter.defaultUpstream;
  const cwd = process.cwd();
  const sessionId = newSessionId();
  const eventLog = new EventLog(sessionEventsPath(cwd, sessionId));
  const meter = new Meter();
  const quota = new QuotaWatcher(warnThreshold());
  const effectivePolicy = loadPolicy(cwd);
  const policy = new PolicyWatcher(effectivePolicy);
  const guard = hasBudget(budget) ? new BudgetGuard(budget, budgetStatePath(sessionDir(cwd, sessionId))) : null;
  const onBudget = (change: BudgetChange | null, notes: string[]): void => {
    for (const note of notes) log(`budget: ${note}`);
    if (!change) return;
    eventLog.append({ ts: new Date().toISOString(), type: "budget", state: change.kind, reason: change.reason });
    if (change.kind === "reached") {
      warn({ key: "budget", level: "critical", message: `budget reached — ${change.reason}. Every action now needs your approval.` });
    } else {
      log(`budget: ${change.reason} — actions run as before`);
    }
  };

  // Optional git isolation: run the agent in a dedicated worktree/branch so the
  // user's working tree is never touched (CONCEPT.md problem ④).
  let worktree: Worktree | null = null;
  let childCwd = cwd;
  if (isolate) {
    if (!isGitRepo(cwd)) {
      log("--isolate requires a git repository (none found here)");
      return 1;
    }
    if (isDirty(cwd)) {
      log("note: working tree has uncommitted changes — isolation branches from HEAD, so those are not included");
    }
    worktree = addSessionWorktree(cwd, sessionId);
    childCwd = worktree.path;
    log(`isolated on branch ${worktree.branch} (base ${worktree.baseSha.slice(0, 8)}) · worktree ${path.relative(cwd, worktree.path)}`);
  }

  writeMeta(cwd, {
    sessionId,
    agent: adapter.id,
    cwd,
    isolated: isolate,
    branch: worktree?.branch,
    baseSha: worktree?.baseSha,
    worktreePath: worktree?.path,
    createdAt: new Date().toISOString(),
  });

  eventLog.append({ ts: new Date().toISOString(), type: "session_start", agent: adapter.id });

  const proxy = await startProxy({
    upstream,
    provider: adapter.provider,
    onUsage: (e: UsageEvent) => {
      eventLog.append(e);
      meter.add(e);
      log(meter.statusLine());
      if (guard) {
        const t = meter.snapshot();
        onBudget(guard.onCost(t.costUsd), guard.blindSpots(t.unpricedModels, null));
      }
      const rl = meter.rateLimitLine();
      if (rl) log(rl);
      if (e.tools) {
        for (const notice of policy.observe(e.tools)) {
          warn({ key: notice.type, level: "warn", message: `policy: ${notice.message}` });
        }
      }
    },
    onRateLimit: (snapshot) => {
      meter.setRateLimit(snapshot);
      eventLog.append({
        ts: new Date().toISOString(),
        type: "ratelimit",
        path: "/",
        raw: snapshot.raw,
      });
      for (const w of quota.update(snapshot)) warn(w);
      if (guard) onBudget(guard.onQuota(snapshot), guard.blindSpots([], snapshot));
    },
  });

  // Enforce action-type policy through the agent's PreToolUse hook (②). Only
  // the agent can stop a tool it is about to run — the proxy never sees the
  // execution. Agents without a hook mechanism stay observe-only, said plainly.
  let finalArgs = agentArgs;
  const hookEnv: Record<string, string> = {};
  if (needsEnforcement(effectivePolicy) || guard) {
    if (adapter.enforcementArgs) {
      const settingsFile = writeHookSettings(cwd, sessionId);
      finalArgs = [...adapter.enforcementArgs(settingsFile), ...finalArgs];
      // Pass the resolved policy explicitly: the hook runs with the agent's cwd
      // (a worktree under --isolate), which may not hold .vantage/policy.json.
      hookEnv.VANTAGE_POLICY = policyToEnv(effectivePolicy);
      const enforced = Object.entries(effectivePolicy)
        .filter(([, l]) => l === "ask" || l === "deny")
        .map(([t, l]) => `${t}:${l}`)
        .join(" ");
      if (enforced) log(`enforcing policy via ${adapter.id} PreToolUse hook — ${enforced}`);
      if (guard) {
        hookEnv.VANTAGE_BUDGET_FILE = budgetStatePath(sessionDir(cwd, sessionId));
        log(`budget: every action needs approval once ${formatBudget(budget)} is reached`);
      }
    } else {
      log(`policy or budget needs enforcement, but ${adapter.id} exposes no hook mechanism — observe-only`);
    }
  }

  // Inject compiled project memory via the agent's native mechanism (⑤).
  if (useMemory && adapter.contextArgs) {
    const memory = compileMemory(cwd);
    const extra = memory ? adapter.contextArgs(memory) : null;
    if (memory && extra) {
      finalArgs = [...extra, ...finalArgs];
      log(`injected project memory (${memory.length} chars) via ${adapter.id}`);
    }
  }

  log(`session ${sessionId} · agent ${adapter.id} · upstream ${upstream} (${proxy.via})`);
  log(`proxy ${proxy.url} → ${adapter.command}`);

  // A launch that never gets going must still end its session — otherwise
  // `watch` shows it as running forever — and must not leave an empty
  // isolation worktree behind.
  const failLaunch = async (reason: string): Promise<number> => {
    log(`could not launch ${adapter.command}: ${reason}`);
    eventLog.append({ ts: new Date().toISOString(), type: "session_end", exitCode: 127 });
    if (worktree) removeSessionWorktree(cwd, worktree.path, worktree.branch);
    await proxy.close();
    return 127;
  };

  // VANTAGE_AGENT_PATH names the agent's executable outright, for installs the
  // automatic lookup gets wrong. It still goes through the resolver, so a path
  // to an npm `.cmd` shim works as well as one to the `.exe` itself.
  const override = process.env.VANTAGE_AGENT_PATH;
  if (override) {
    if (!fs.existsSync(override)) {
      return await failLaunch(`VANTAGE_AGENT_PATH points at ${override}, which does not exist`);
    }
    log(`agent from VANTAGE_AGENT_PATH: ${override}`);
  }

  // Windows cannot spawn npm's `claude.cmd` shims without a shell; resolve to
  // what the shim wraps instead (see src/resolve.ts).
  const target = resolveCommand(override || adapter.command);
  if (!target.ok) {
    const hint = override ? "" : " — or set VANTAGE_AGENT_PATH to the agent's executable";
    return await failLaunch(target.reason + hint);
  }

  const child = spawn(target.resolved.command, [...target.resolved.prefix, ...finalArgs], {
    cwd: childCwd,
    stdio: "inherit",
    env: { ...process.env, ...adapter.proxyEnv(proxy.url), ...hookEnv },
  });

  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  return await new Promise<number>((resolve) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      const reason =
        err.code === "ENOENT"
          ? "not found — is it installed and on PATH? (or set VANTAGE_AGENT_PATH to its executable)"
          : err.message;
      void failLaunch(reason).then(resolve);
    });
    child.on("exit", async (code) => {
      eventLog.append({ ts: new Date().toISOString(), type: "session_end", exitCode: code });
      const t = meter.snapshot();
      log(
        `session end · ${t.requests} request(s) · in ${t.input} · out ${t.output} · ` +
          `cache ${t.cacheRead}r/${t.cacheWrite}w · ${formatCost(t.costUsd, t.unpriced, t.requests)}`
      );
      const rl = meter.rateLimitLine();
      if (rl) log(rl);
      for (const hint of pricingHints(t.unpricedModels)) log(hint);
      log(`event log: ${eventLog.filePath}`);

      if (worktree) reportIsolatedChanges(cwd, sessionId, worktree, adapter.id);

      // One quiet line, only when the session actually did something — memory
      // is never written automatically (see src/harvest.ts).
      if (worthHarvesting(eventLog.readAll())) {
        log(`worth remembering? vantage harvest ${sessionId}`);
      }

      await proxy.close();
      resolve(code ?? 0);
    });
  });
}

function fmtFileLine(f: { path: string; added: number; removed: number }): string {
  const a = f.added < 0 ? "bin" : `+${f.added}`;
  const r = f.removed < 0 ? "" : `-${f.removed}`;
  return `  ${f.path} (${a}${r ? " " + r : ""})`;
}

// Commit the agent's work to the isolation branch and print an aggregated diff.
function reportIsolatedChanges(
  cwd: string,
  sessionId: string,
  worktree: Worktree,
  agentId: string
): void {
  const committed = commitSessionWork(worktree.path, `vantage: ${agentId} session ${sessionId}`);
  if (!committed) {
    log("isolation: no changes made — removing empty worktree/branch");
    removeSessionWorktree(cwd, worktree.path, worktree.branch);
    return;
  }

  const diff = sessionDiff(worktree.path, worktree.baseSha);
  fs.writeFileSync(path.join(sessionDir(cwd, sessionId), "changes.patch"), diff.patch);

  log(`isolation: ${diff.files.length} file(s) changed, +${diff.added}/-${diff.removed} on ${worktree.branch}`);
  for (const f of diff.files.slice(0, 10)) log(fmtFileLine(f));
  if (diff.files.length > 10) log(`  … and ${diff.files.length - 10} more`);
  log(`review:  vantage review ${sessionId}`);
  log(`merge:   git merge --no-ff ${worktree.branch}`);
  log(`discard: vantage discard ${sessionId}`);
}

async function cmdReview(argv: string[]): Promise<number> {
  const sessionId = argv[0];
  if (!sessionId) {
    log("usage: vantage review <sessionId>");
    return 1;
  }
  const cwd = process.cwd();
  const meta = readMeta(cwd, sessionId);
  if (!meta) {
    log(`no session "${sessionId}" found under .vantage/sessions/`);
    return 1;
  }
  if (!meta.isolated || !meta.branch || !meta.baseSha) {
    log(`session ${sessionId} was not run with --isolate (nothing to review)`);
    return 1;
  }

  const branchExists = gitSafe(cwd, ["rev-parse", "--verify", meta.branch]).ok;
  if (branchExists) {
    const stat = gitSafe(cwd, ["diff", "--stat", meta.baseSha, meta.branch]);
    log(`branch ${meta.branch} vs base ${meta.baseSha.slice(0, 8)}:`);
    process.stdout.write(stat.stdout + "\n");
    log(`full diff: git diff ${meta.baseSha.slice(0, 8)} ${meta.branch}`);
    log(`merge:     git merge --no-ff ${meta.branch}`);
    log(`discard:   vantage discard ${sessionId}`);
  } else {
    const patch = path.join(sessionDir(cwd, sessionId), "changes.patch");
    if (fs.existsSync(patch)) {
      log(`branch is gone; saved patch: ${patch}`);
    } else {
      log(`nothing to review for session ${sessionId}`);
    }
  }
  return 0;
}

async function cmdDiscard(argv: string[]): Promise<number> {
  const sessionId = argv[0];
  if (!sessionId) {
    log("usage: vantage discard <sessionId>");
    return 1;
  }
  const cwd = process.cwd();
  const meta = readMeta(cwd, sessionId);
  if (!meta || !meta.isolated || !meta.branch || !meta.worktreePath) {
    log(`session ${sessionId} has no isolation worktree to discard`);
    return 1;
  }
  removeSessionWorktree(cwd, meta.worktreePath, meta.branch);
  log(`discarded worktree and branch ${meta.branch}`);
  return 0;
}

async function cmdReplay(argv: string[]): Promise<number> {
  const sessionId = argv[0];
  const cwd = process.cwd();
  if (!sessionId) {
    log("usage: vantage replay <sessionId>  (see: vantage sessions)");
    return 1;
  }
  const logPath = sessionEventsPath(cwd, sessionId);
  if (!fs.existsSync(logPath)) {
    log(`no session "${sessionId}" found under .vantage/sessions/`);
    return 1;
  }
  const events = new EventLog(logPath).readAll();
  process.stdout.write(renderTimeline(events, process.stdout.isTTY ?? false) + "\n");
  return 0;
}

async function cmdHarvest(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const sessionId = argv[0] ?? newestSessionId(cwd);
  if (!sessionId) {
    log("usage: vantage harvest [sessionId]  (see: vantage sessions)");
    return 1;
  }
  const events = readSessionEvents(cwd, sessionId);
  if (events.length === 0) {
    log(`no session "${sessionId}" found under .vantage/sessions/`);
    return 1;
  }

  // Changed files come from the isolation branch when the session had one.
  let files: string[] = [];
  const meta = readMeta(cwd, sessionId);
  if (meta?.isolated && meta.branch && meta.baseSha) {
    const res = gitSafe(cwd, ["diff", "--name-only", meta.baseSha, meta.branch]);
    if (res.ok) files = res.stdout.split("\n").filter(Boolean);
  }

  const harvest = collectHarvest(sessionId, events, files);
  process.stdout.write(renderHarvest(harvest, process.stdout.isTTY ?? false) + "\n");
  return 0;
}

async function cmdSessions(): Promise<number> {
  const cwd = process.cwd();
  const sessions = listSessions(cwd);
  if (sessions.length === 0) {
    log("no sessions recorded yet — run `vantage run <agent>` first");
    return 0;
  }
  for (const s of sessions) {
    const flags = s.isolated ? " [isolated]" : "";
    const when = s.startedAt ? s.startedAt.replace("T", " ").slice(0, 19) : "?";
    process.stdout.write(
      `${s.sessionId}${flags}\n` +
        `  ${when} · ${s.agent ?? "?"} · ${s.requests} turn(s) · ` +
        `out ${s.output} · ${formatCost(s.costUsd, s.unpriced, s.requests)}\n`
    );
  }
  log(`replay one with: vantage replay <sessionId>`);
  return 0;
}

async function cmdWatch(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const pinned = argv[0];
  const interval = 500;

  // Renders into THIS terminal only — the agent's own terminal is never
  // touched, which is the whole point of watching from a second pane.
  const draw = (body: string): void => {
    process.stdout.write("\x1b[H\x1b[J" + body + "\n"); // home, clear to end
  };

  let current = pinned ?? newestSessionId(cwd);
  if (!current) draw("waiting for a session…  (start one with `vantage run <agent>`)");

  return await new Promise<number>((resolve) => {
    const stop = (): void => {
      clearInterval(timer);
      process.stdout.write("\n");
      resolve(0);
    };
    process.on("SIGINT", stop);

    const timer = setInterval(() => {
      // Without a pinned id, follow whichever session is newest, so you can
      // start watching before launching the agent.
      if (!pinned) {
        const newest = newestSessionId(cwd);
        if (newest && newest !== current) current = newest;
      }
      if (!current) {
        draw("waiting for a session…  (start one with `vantage run <agent>`)");
        return;
      }
      const events = readSessionEvents(cwd, current);
      if (events.length === 0) return;
      draw(renderLive(events, { sessionId: current, color: process.stdout.isTTY ?? false }));

      // A pinned session that has finished has nothing more to show.
      if (pinned && events.some((e) => e.type === "session_end")) stop();
    }, interval);
  });
}

// Write a session-scoped settings file registering the PreToolUse hook.
// Claude Code merges --settings with the user's own settings and combines list
// keys, so this adds our hook without disturbing theirs.
function writeHookSettings(cwd: string, sessionId: string): string {
  const file = path.join(sessionDir(cwd, sessionId), "hook-settings.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const inv = hookInvocation(process.execPath, fileURLToPath(import.meta.url));
  fs.writeFileSync(file, JSON.stringify(hookSettings(inv), null, 2));
  return file;
}

function policyToEnv(policy: Policy): string {
  return Object.entries(policy).map(([k, v]) => `${k}:${v}`).join(",");
}

// Invoked by Claude Code, not by a human: decide on one pending tool call.
async function cmdHook(): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const out = runHook(
    Buffer.concat(chunks).toString("utf8"),
    loadPolicy(process.cwd()),
    readBudgetState(process.env.VANTAGE_BUDGET_FILE)
  );
  if (out) process.stdout.write(out);
  return 0; // the JSON decides; exit 0 with no JSON = no decision
}

async function cmdPolicy(): Promise<number> {
  const cwd = process.cwd();
  const policy = loadPolicy(cwd);
  log("action-type policy — allow · warn (notice only) · ask (approval) · deny (blocked):");
  for (const [type, level] of Object.entries(policy)) {
    const mark =
      level === "deny" ? "\x1b[31m⛔\x1b[0m" : level === "ask" ? "\x1b[33m?\x1b[0m" : level === "warn" ? "\x1b[33m⚠\x1b[0m" : " ";
    process.stdout.write(`  ${mark} ${type.padEnd(8)} ${level}\n`);
  }
  if (needsEnforcement(policy)) {
    log("ask/deny are enforced through the agent's PreToolUse hook (agents without hooks stay observe-only)");
  }
  log("configure via .vantage/policy.json or VANTAGE_POLICY=\"shell:deny,network:ask\"");
  return 0;
}

// Human page for a source URL (the Markdown form is what gets fetched).
function pageUrl(source: string): string {
  return source.replace(/\.md$/, "");
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function priceRow(id: string, m: PriceEntry): string {
  const n = (v: number) => `$${v}`.padStart(8);
  return `  ${id.padEnd(20)}${n(m.input)}${n(m.cache_write_5m)}${n(m.cache_write_1h)}${n(m.cache_read)}${n(m.output)}\n`;
}

async function cmdPricing(argv: string[]): Promise<number> {
  const sub = argv[0];
  switch (sub) {
    case "show":
    case undefined: {
      const p = activePrices();
      const updated = p.cached && p.cached.fetchedAt === p.asOf;
      log(
        `prices as of ${day(p.asOf)} · ` +
          (updated ? `from \`vantage pricing update\` (${pricingCachePath()})` : "bundled with vantage")
      );
      log(`source: ${pageUrl(updated ? p.cached!.source : p.bundled.source)}`);
      if (p.cacheError) log(`ignored an invalid price file — ${p.cacheError}`);
      process.stdout.write(`  ${"model".padEnd(20)}${"input".padStart(8)}${"5m wr".padStart(8)}${"1h wr".padStart(8)}${"read".padStart(8)}${"output".padStart(8)}   USD / MTok\n`);
      for (const [id, m] of Object.entries(p.models)) process.stdout.write(priceRow(id, m));
      log("vantage never fetches prices on its own — `vantage pricing update` gets the current list");
      return 0;
    }
    case "update": {
      const before = activePrices();
      log(`fetching ${pricingSourceUrl()}`);
      let fetched;
      try {
        fetched = await fetchPriceTable();
      } catch (err) {
        log(`update failed, prices unchanged — ${(err as Error).message}`);
        return 1;
      }
      for (const s of fetched.skipped) log(`skipped ${s}`);
      const { skipped: _skipped, ...table } = fetched;
      writePricingCache(table);
      resetActivePrices();
      const d = diffPrices(before.models, table.models);
      for (const id of d.added) log(`new: ${id}`);
      for (const c of d.changed) log(`changed: ${formatChange(c)}`);
      if (!hasDrift(d)) log("no price changes");
      log(`${Object.keys(table.models).length} models saved to ${pricingCachePath()} · applies from the next session`);
      return 0;
    }
    case "check": {
      // For CI: does the official list still match the bundled snapshot?
      const bundled = activePrices().bundled;
      let fetched;
      try {
        fetched = await fetchPriceTable();
      } catch (err) {
        log(`check failed — ${(err as Error).message}`);
        return 1;
      }
      for (const s of fetched.skipped) log(`skipped ${s}`);
      const d = diffPrices(bundled.models, fetched.models);
      for (const id of d.added) log(`new: ${id}`);
      for (const c of d.changed) log(`changed: ${formatChange(c)}`);
      for (const id of d.unlisted) log(`no longer listed: ${id}`);
      if (hasDrift(d)) {
        log("the bundled price list is out of date — run `npm run pricing:snapshot` and commit");
        return 1;
      }
      log(`bundled price list matches the official one (${Object.keys(fetched.models).length} models)`);
      return 0;
    }
    default:
      log(`unknown pricing command "${sub}" (show | update | check)`);
      return 1;
  }
}

async function cmdMemory(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const sub = argv[0];
  switch (sub) {
    case "init": {
      const { created, existing } = initMemory(cwd);
      log(`memory at ${path.relative(cwd, memoryDir(cwd))}/`);
      if (created.length) log(`created: ${created.join(", ")}`);
      if (existing.length) log(`kept: ${existing.join(", ")}`);
      return 0;
    }
    case "add": {
      const category = argv[1];
      const text = argv.slice(2).join(" ");
      if (!category || !text) {
        log('usage: vantage memory add <category> <text>   (e.g. decisions "chose Postgres")');
        return 1;
      }
      const p = addNote(cwd, category, text);
      log(`noted in ${path.relative(cwd, p)}`);
      return 0;
    }
    case "show":
    case undefined: {
      const memory = compileMemory(cwd);
      if (!memory) {
        log("no project memory yet — run `vantage memory init`");
        return 0;
      }
      process.stdout.write(memory + "\n");
      return 0;
    }
    default:
      log(`unknown memory command "${sub}" (init | add | show)`);
      return 1;
  }
}

async function cmdDemo(): Promise<number> {
  log("demo: proving the full chain against a mock upstream (no API key needed)");
  const mock = await startMockAnthropic();
  const meter = new Meter();

  const proxy = await startProxy({
    upstream: mock.url,
    onUsage: (e: UsageEvent) => {
      meter.add(e);
      log(meter.statusLine());
    },
  });

  const fakeAgent = path.join(HERE, "..", "examples", "fake-agent.mjs");
  log(`upstream(mock) ${mock.url} · proxy ${proxy.url} · agent ${path.basename(fakeAgent)}`);

  const child = spawn(process.execPath, [fakeAgent], {
    stdio: "inherit",
    env: { ...process.env, ANTHROPIC_BASE_URL: proxy.url },
  });

  return await new Promise<number>((resolve) => {
    child.on("exit", async (code) => {
      const t = meter.snapshot();
      log(
        `demo end · in ${t.input} · out ${t.output} · cache ${t.cacheRead} · ` +
          formatCost(t.costUsd, t.unpriced, t.requests)
      );
      await proxy.close();
      await mock.close();
      resolve(code ?? 0);
    });
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      process.exit(await cmdRun(rest));
      break;
    case "review":
      process.exit(await cmdReview(rest));
      break;
    case "discard":
      process.exit(await cmdDiscard(rest));
      break;
    case "sessions":
      process.exit(await cmdSessions());
      break;
    case "replay":
      process.exit(await cmdReplay(rest));
      break;
    case "harvest":
      process.exit(await cmdHarvest(rest));
      break;
    case "memory":
      process.exit(await cmdMemory(rest));
      break;
    case "policy":
      process.exit(await cmdPolicy());
      break;
    case "pricing":
      process.exit(await cmdPricing(rest));
      break;
    case "hook":
      process.exit(await cmdHook());
      break;
    case "watch":
      process.exit(await cmdWatch(rest));
      break;
    case "demo":
      process.exit(await cmdDemo());
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printHelp();
      process.exit(0);
      break;
    default:
      log(`unknown command "${cmd}"`);
      printHelp();
      process.exit(1);
  }
}

void main();
