// `vantage run`: start Claude Code behind the metering proxy, enforce rules
// and budget through its PreToolUse hook, and sum up the session at the end.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startProxy, type RunningProxy } from "../proxy.ts";
import { Meter } from "../meter.ts";
import { EventLog, ensureVantageGitignore, newSessionId, sessionDir, sessionEventsPath, type UsageEvent } from "../events.ts";
import { resolveAdapter, knownAgents } from "../agents/index.ts";
import { QuotaWatcher } from "../ratelimit.ts";
import { shortenPaths } from "../replay.ts";
import { recordLastSession } from "../home.ts";
import { worthHarvesting } from "../harvest.ts";
import { compileMemory } from "../memory.ts";
import { loadPolicy, PolicyWatcher, needsEnforcement, type Policy } from "../policy.ts";
import { loadRules, policyFilePath } from "../rules.ts";
import { hookInvocation } from "../hook.ts";
import { writeHookConfig, type HookConfig } from "../agents/hooks.ts";
import { outboxPath, postAlert, takeAlerts } from "../outbox.ts";
import type { QuotaWarning } from "../ratelimit.ts";
import { resolveCommand } from "../resolve.ts";
import {
  BudgetGuard,
  InflightCounter,
  inflightPath,
  budgetStatePath,
  formatBudget,
  hasBudget,
  parseCost,
  parseQuota,
  type Budget,
  type BudgetChange,
} from "../budget.ts";
import { formatCost, pricingHints } from "../pricing.ts";
import {
  isGitRepo,
  isDirty,
  addSessionWorktree,
  commitSessionWork,
  sessionDiff,
  removeSessionWorktree,
  snapshotWorkingTree,
  treeDiff,
  type SessionDiff,
  type Worktree,
} from "../git.ts";
import { writeMeta, type SessionMeta } from "../session-meta.ts";
import { terminal, log, warn, fmtFileLine } from "./output.ts";
import { plain } from "../sanitize.ts";

// Warn threshold as a fraction 0..1. VANTAGE_QUOTA_WARN accepts a fraction
// (0.8) or a percent (80); default 90%.
function warnThreshold(): number {
  const raw = process.env.VANTAGE_QUOTA_WARN;
  if (!raw) return 0.9;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0.9;
  return n > 1 ? Math.min(n / 100, 1) : n;
}

export async function cmdRun(argv: string[], entry: string): Promise<number> {
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

  const routes = adapter.routes(process.env);
  const cwd = process.cwd();
  const sessionId = newSessionId();
  if (ensureVantageGitignore(cwd)) log("created .vantage/.gitignore — session logs stay out of git");
  const eventLog = new EventLog(sessionEventsPath(cwd, sessionId));
  const meter = new Meter();
  const quota = new QuotaWatcher(warnThreshold());
  const effectivePolicy = loadPolicy(cwd);
  const rules = loadRules(policyFilePath(cwd));
  const policy = new PolicyWatcher(effectivePolicy);
  const guard = hasBudget(budget) ? new BudgetGuard(budget, budgetStatePath(sessionDir(cwd, sessionId))) : null;

  // The agent's chat UI owns the terminal from launch until exit. Vantage
  // then shows alerts in that chat, through a hook the agent runs after each
  // reply (see src/outbox.ts); live numbers are in `vantage watch`.
  const interactive = adapter.isInteractive(agentArgs) && Boolean(process.stderr.isTTY);
  const chatAlerts = interactive && adapter.capabilities.chatAlerts;
  const outbox = chatAlerts ? outboxPath(sessionDir(cwd, sessionId)) : null;
  // Exchanges in flight, so a hook can wait until the reply before it is
  // metered: the budget check, and alerts that reply caused.
  const inflight = guard || chatAlerts ? new InflightCounter(inflightPath(sessionDir(cwd, sessionId))) : null;
  const seenSecrets = new Set<string>();

  // An alert goes to the chat while the agent's UI is open, else to stderr.
  const alert = (w: QuotaWarning): void => {
    if (outbox && terminal.isHolding) postAlert(outbox, w);
    else warn(w);
  };

  const onBudget = (change: BudgetChange | null, notes: string[]): void => {
    for (const note of notes) alert({ key: "budget", level: "warn", message: `budget: ${note}` });
    if (!change) return;
    eventLog.append({ ts: new Date().toISOString(), type: "budget", state: change.kind, reason: change.reason });
    if (change.kind === "reached") {
      alert({ key: "budget", level: "critical", message: `budget reached — ${change.reason}. Every action now needs your approval.` });
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

  // Without isolation, snapshot the working tree so the end of the session
  // can say exactly which files changed meanwhile.
  let startTree: string | undefined;
  if (!isolate && isGitRepo(cwd)) {
    const snap = snapshotWorkingTree(cwd);
    if (snap.ok) startTree = snap.tree;
    else log(`no change summary for this session: ${snap.reason}`);
  }

  const meta: SessionMeta = {
    sessionId,
    agent: adapter.id,
    cwd,
    isolated: isolate,
    branch: worktree?.branch,
    baseSha: worktree?.baseSha,
    worktreePath: worktree?.path,
    createdAt: new Date().toISOString(),
    ...(startTree ? { startTree } : {}),
  };
  writeMeta(cwd, meta);

  eventLog.append({
    ts: new Date().toISOString(),
    type: "session_start",
    agent: adapter.id,
    project: cwd,
    pid: process.pid,
    ...(guard ? { budget } : {}),
  });
  recordLastSession({ cwd, sessionId });

  // An agent whose API traffic cannot be read would run without a proxy.
  const proxy: RunningProxy | null = routes.length === 0 ? null : await startProxy({
    routes,
    agentName: adapter.name,
    // Lets watch say "Claude is thinking" while a chat turn is in flight.
    onRequest: (info) => {
      for (const f of info.secrets) {
        if (seenSecrets.has(f.fingerprint)) continue;
        seenSecrets.add(f.fingerprint);
        eventLog.append({ ts: new Date().toISOString(), type: "secret", kind: f.kind, masked: f.masked, source: f.source });
        const source = shortenPaths(f.source, cwd);
        const article = /^[aeiou]/i.test(f.kind) ? "an" : "a";
        const message = `${article} ${f.kind} (${f.masked}) was sent to the API, from ${source} — rotate it if it should not leave your machine`;
        alert({ key: `secret:${f.fingerprint}`, level: "critical", message });
      }
      if (info.background) return;
      eventLog.append({ ts: new Date().toISOString(), type: "request" });
    },
    log: (msg) => terminal.info(`\x1b[2m[vantage:proxy]\x1b[0m ${plain(msg)}\n`),
    onExchange: (phase) => (phase === "start" ? inflight?.start() : inflight?.end()),
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
          alert({ key: notice.type, level: "warn", message: `policy: ${notice.message}` });
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
      for (const w of quota.update(snapshot)) alert(w);
      if (guard) onBudget(guard.onQuota(snapshot), guard.blindSpots([], snapshot));
    },
  });

  // Enforce action-type policy through the agent's hook (②). Only the agent
  // can stop a tool it is about to run — the proxy never sees the execution.
  // Agents without a hook mechanism stay observe-only, said plainly. A hook
  // after each reply carries alerts into the chat.
  const dir = sessionDir(cwd, sessionId);
  const enforcingRules = rules.filter((r) => r.level === "ask" || r.level === "deny");
  const wantsEnforcement = needsEnforcement(effectivePolicy) || enforcingRules.length > 0 || guard !== null;
  const canEnforce = adapter.capabilities.enforce !== "none";
  if (wantsEnforcement && !canEnforce) {
    log(`policy or budget needs enforcement, but ${adapter.name} exposes no hook mechanism — observe-only`);
  }
  const enforce = wantsEnforcement && canEnforce;

  // What the hook needs, as environment variables for hooks that inherit the
  // agent's environment and as a file named in the hook command for those
  // that do not (see src/agents/hooks.ts).
  const hookEnv: HookConfig = {};
  if (outbox) {
    hookEnv.VANTAGE_OUTBOX_FILE = outbox;
    hookEnv.VANTAGE_INFLIGHT_FILE = inflightPath(dir);
  }
  if (enforce) {
    // Pass the resolved policy explicitly: the hook runs with the agent's cwd
    // (a worktree under --isolate), which may not hold .vantage/policy.json.
    hookEnv.VANTAGE_POLICY = policyToEnv(effectivePolicy);
    // Rules are read from the project's file, wherever the agent runs.
    hookEnv.VANTAGE_POLICY_FILE = policyFilePath(cwd);
    const enforced = Object.entries(effectivePolicy)
      .filter(([, l]) => l === "ask" || l === "deny")
      .map(([t, l]) => `${t}:${l}`)
      .join(" ");
    if (enforced) log(`enforcing policy via ${adapter.name}'s hook — ${enforced}`);
    if (enforcingRules.length) log(`enforcing ${enforcingRules.length} file/command rule(s) from .vantage/policy.json`);
    // The hook records what it blocks or asks about, so watch and replay
    // can show it next to the calls that went through.
    hookEnv.VANTAGE_EVENTS_FILE = eventLog.filePath;
    if (guard) {
      hookEnv.VANTAGE_BUDGET_FILE = budgetStatePath(dir);
      hookEnv.VANTAGE_INFLIGHT_FILE = inflightPath(dir);
      log(`budget: every action needs approval once ${formatBudget(budget)} is reached`);
    }
  }

  // Project memory, through the agent's own mechanism (⑤).
  const memory = useMemory ? compileMemory(cwd) || null : null;
  const memoryFile = path.join(dir, "memory.md");
  if (memory) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(memoryFile, memory);
    hookEnv.VANTAGE_MEMORY_FILE = memoryFile;
  }

  const hookConfigFile = path.join(dir, "hook-config.json");
  writeHookConfig(hookConfigFile, hookEnv);
  const plan = adapter.prepare({
    proxyUrl: proxy?.url ?? "",
    sessionDir: dir,
    hook: hookInvocation(process.execPath, entry, [adapter.key, hookConfigFile]),
    enforce,
    chatAlerts,
    memory,
    memoryFile,
    cwd: childCwd,
    env: process.env,
    policy: effectivePolicy,
    rules,
    args: agentArgs,
  });
  const finalArgs = [...plan.args, ...agentArgs];
  for (const note of plan.notes) log(note);

  if (memory && plan.memory) log(`injected project memory (${memory.length} chars) via ${adapter.name}`);

  if (proxy) {
    const all = [...new Set(routes.map((r) => (typeof r.upstream === "string" ? r.upstream : `${r.prefix} (per request)`)))];
    const upstreams = all.length > 3 ? `${all.slice(0, 2).join(", ")} and ${all.length - 2} more` : all.join(", ");
    log(`session ${sessionId} · agent ${adapter.name} · upstream ${upstreams} (${proxy.via})`);
    log(`proxy ${proxy.url} → ${adapter.command}`);
  } else {
    log(`session ${sessionId} · agent ${adapter.name} · its API traffic cannot be read, so no tokens or cost`);
  }

  // A launch that never gets going must still end its session — otherwise
  // `watch` shows it as running forever — and must not leave an empty
  // isolation worktree behind.
  // Ends the quiet period and prints the alerts not shown in the chat yet.
  const releaseTerminal = (): void => {
    const held = terminal.release();
    const waiting = takeAlerts(outbox ?? undefined);
    if (held.length === 0 && waiting.length === 0) return;
    log("during the session:");
    for (const line of held) terminal.alert(line);
    for (const a of waiting) warn({ key: a.message, ...a });
  };

  const failLaunch = async (reason: string): Promise<number> => {
    releaseTerminal();
    log(`could not launch ${adapter.command}: ${reason}`);
    eventLog.append({ ts: new Date().toISOString(), type: "session_end", exitCode: 127 });
    if (worktree) removeSessionWorktree(cwd, worktree.path, worktree.branch);
    await proxy?.close();
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

  // From here until the agent exits, its chat UI owns the terminal. Anything
  // written now would land inside that UI, so live numbers go to
  // `vantage watch` and alerts wait until the end.
  if (interactive) {
    log(
      chatAlerts
        ? `live view: run \`vantage watch\` in a second terminal — alerts appear in ${adapter.name}'s chat`
        : `live view: run \`vantage watch\` in a second terminal — Vantage stays quiet here until ${adapter.name} exits`
    );
    terminal.hold();
  }

  const child = spawn(target.resolved.command, [...target.resolved.prefix, ...finalArgs], {
    cwd: childCwd,
    stdio: "inherit",
    env: { ...process.env, ...plan.env, ...hookEnv },
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
      releaseTerminal();

      // What changed: the isolation branch, or the working tree since start.
      let changes: SessionDiff | null = null;
      if (worktree) {
        changes = reportIsolatedChanges(cwd, sessionId, worktree, adapter.id);
      } else if (startTree) {
        const end = snapshotWorkingTree(cwd);
        if (end.ok) {
          changes = treeDiff(cwd, startTree, end.tree);
          writeMeta(cwd, { ...meta, endTree: end.tree });
          if (changes.files.length) fs.writeFileSync(path.join(sessionDir(cwd, sessionId), "changes.patch"), changes.patch);
        }
      }

      eventLog.append({
        ts: new Date().toISOString(),
        type: "session_end",
        exitCode: code,
        ...(changes
          ? { changes: { files: changes.files.slice(0, 500).map((f) => f.path), added: changes.added, removed: changes.removed } }
          : {}),
      });
      const t = meter.snapshot();
      log(
        `session end · ${t.requests} request(s) · in ${t.input} · out ${t.output} · ` +
          `cache ${t.cacheRead}r/${t.cacheWrite}w · ${formatCost(t.costUsd, t.unpriced, t.requests)}`
      );
      const rl = meter.rateLimitLine();
      if (rl) log(rl);
      for (const hint of pricingHints(t.unpricedModels)) log(hint);
      log(`event log: ${eventLog.filePath}`);

      if (worktree && changes) {
        printIsolatedChanges(sessionId, worktree, changes);
      } else if (startTree && changes) {
        if (changes.files.length === 0) {
          log("no files changed during this session");
        } else {
          log(`changed during this session: ${changes.files.length} file(s), +${changes.added}/-${changes.removed} (edits you made meanwhile included)`);
          for (const f of changes.files.slice(0, 10)) log(fmtFileLine(f));
          if (changes.files.length > 10) log(`  … and ${changes.files.length - 10} more`);
          log(`full diff: vantage review ${sessionId}`);
        }
      }

      // One quiet line, only when the session actually did something — memory
      // is never written automatically (see src/harvest.ts).
      if (worthHarvesting(eventLog.readAll())) {
        log(`worth remembering? vantage harvest ${sessionId}`);
      }

      await proxy?.close();
      resolve(code ?? 0);
    });
  });
}

// Commits the isolated session's work and returns its diff (empty when the
// session changed nothing; the empty worktree is removed then).
function reportIsolatedChanges(cwd: string, sessionId: string, worktree: Worktree, agentId: string): SessionDiff {
  const committed = commitSessionWork(worktree.path, `vantage: ${agentId} session ${sessionId}`);
  if (!committed) {
    removeSessionWorktree(cwd, worktree.path, worktree.branch);
    return { files: [], added: 0, removed: 0, patch: "" };
  }
  const diff = sessionDiff(worktree.path, worktree.baseSha);
  fs.writeFileSync(path.join(sessionDir(cwd, sessionId), "changes.patch"), diff.patch);
  return diff;
}

function printIsolatedChanges(sessionId: string, worktree: Worktree, diff: SessionDiff): void {
  if (diff.files.length === 0) {
    log("isolation: no changes made — removed the empty worktree/branch");
    return;
  }
  log(`isolation: ${diff.files.length} file(s) changed, +${diff.added}/-${diff.removed} on ${worktree.branch}`);
  for (const f of diff.files.slice(0, 10)) log(fmtFileLine(f));
  if (diff.files.length > 10) log(`  … and ${diff.files.length - 10} more`);
  log(`review:  vantage review ${sessionId}`);
  log(`merge:   git merge --no-ff ${worktree.branch}`);
  log(`discard: vantage discard ${sessionId}`);
}

function policyToEnv(policy: Policy): string {
  return Object.entries(policy).map(([k, v]) => `${k}:${v}`).join(",");
}
