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
import { compileMemory, initMemory, addNote, memoryDir } from "./memory.ts";
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
    `vantage — control & transparency layer for AI-coding CLIs\n\n` +
      `Usage:\n` +
      `  vantage run [--isolate] [--no-memory] <agent> [-- <agent args...>]\n` +
      `  vantage sessions\n` +
      `  vantage replay <sessionId>\n` +
      `  vantage review <sessionId>\n` +
      `  vantage discard <sessionId>\n` +
      `  vantage memory <init|show|add <category> <text>>\n` +
      `  vantage demo\n` +
      `  vantage --help\n\n` +
      `Agents: ${knownAgents().join(", ")}\n\n` +
      `--isolate runs the agent in a dedicated git worktree/branch so your\n` +
      `working tree is untouched; review or discard the changes afterwards.\n` +
      `Project memory under .vantage/memory/ is injected into the agent unless\n` +
      `--no-memory is given.\n`
  );
}

async function cmdRun(argv: string[]): Promise<number> {
  // Leading vantage-level flags come before the agent name.
  let isolate = false;
  let useMemory = true;
  const rest = [...argv];
  while (rest[0]?.startsWith("--")) {
    const flag = rest.shift();
    if (flag === "--isolate") isolate = true;
    else if (flag === "--no-isolate") isolate = false;
    else if (flag === "--no-memory") useMemory = false;
    else {
      log(`unknown flag "${flag}"`);
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
    onUsage: (e: UsageEvent) => {
      eventLog.append(e);
      meter.add(e);
      log(meter.statusLine());
      const rl = meter.rateLimitLine();
      if (rl) log(rl);
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
    },
  });

  // Inject compiled project memory via the agent's native mechanism (⑤).
  let finalArgs = agentArgs;
  if (useMemory && adapter.contextArgs) {
    const memory = compileMemory(cwd);
    const extra = memory ? adapter.contextArgs(memory) : null;
    if (memory && extra) {
      finalArgs = [...extra, ...agentArgs];
      log(`injected project memory (${memory.length} chars) via ${adapter.id}`);
    }
  }

  log(`session ${sessionId} · agent ${adapter.id} · upstream ${upstream} (${proxy.via})`);
  log(`proxy ${proxy.url} → ${adapter.command}`);

  const child = spawn(adapter.command, finalArgs, {
    cwd: childCwd,
    stdio: "inherit",
    env: { ...process.env, ...adapter.proxyEnv(proxy.url) },
  });

  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  return await new Promise<number>((resolve) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        log(`could not launch "${adapter.command}" — is it installed and on PATH?`);
      } else {
        log(`failed to launch agent: ${err.message}`);
      }
      void proxy.close().then(() => resolve(127));
    });
    child.on("exit", async (code) => {
      eventLog.append({ ts: new Date().toISOString(), type: "session_end", exitCode: code });
      const t = meter.snapshot();
      log(
        `session end · ${t.requests} request(s) · in ${t.input} · out ${t.output} · ` +
          `cache ${t.cacheRead} · ~$${t.costUsd.toFixed(4)} (est.)`
      );
      const rl = meter.rateLimitLine();
      if (rl) log(rl);
      log(`event log: ${eventLog.filePath}`);

      if (worktree) reportIsolatedChanges(cwd, sessionId, worktree, adapter.id);

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
        `out ${s.output} · ~$${s.costUsd.toFixed(4)} (est.)\n`
    );
  }
  log(`replay one with: vantage replay <sessionId>`);
  return 0;
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
          `~$${t.costUsd.toFixed(4)} (est.)`
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
    case "memory":
      process.exit(await cmdMemory(rest));
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
