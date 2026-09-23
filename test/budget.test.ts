// Budget guard: parsing, when it trips and lifts, what the hook decides while
// it is tripped, and the whole chain through `vantage run` with a stand-in
// agent that behaves like Claude Code (reads --settings, calls the API
// through the proxy, then runs the registered hook for a tool call).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BudgetGuard, parseCost, parseQuota, readBudgetState, budgetStatePath } from "../src/budget.ts";
import { decide } from "../src/hook.ts";
import { DEFAULT_POLICY } from "../src/policy.ts";
import type { RateLimitSnapshot } from "../src/ratelimit.ts";
import { startMockAnthropic } from "../src/dev/mock-anthropic.ts";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("budget values: USD amounts and quota percentages", () => {
  assert.equal(parseCost("2"), 2);
  assert.equal(parseCost("2.50"), 2.5);
  assert.equal(parseCost("$2"), 2);
  assert.equal(parseCost("0"), null);
  assert.equal(parseCost("two"), null);
  assert.equal(parseQuota("80"), 0.8);
  assert.equal(parseQuota("80%"), 0.8);
  assert.equal(parseQuota("0.8"), 0.8);
  assert.equal(parseQuota("150"), null);
  assert.equal(parseQuota("abc"), null);
});

const quota = (util5h: number, util7d = 0.1): RateLimitSnapshot => ({
  unified: {
    status: "allowed",
    representativeClaim: null,
    overageStatus: null,
    windows: [
      { key: "5h", status: "allowed", utilization: util5h, resetUnix: null },
      { key: "7d", status: "allowed", utilization: util7d, resetUnix: null },
    ],
  },
  retryAfterSec: null,
  raw: {},
});

test("cost budget trips once and stays tripped", () => {
  const file = budgetStatePath(tmp("vantage-budget-"));
  const g = new BudgetGuard({ maxCostUsd: 1, maxQuota: null }, file);
  assert.equal(g.onCost(0.4), null);
  assert.equal(readBudgetState(file), null);
  const change = g.onCost(1.02);
  assert.equal(change?.kind, "reached");
  assert.match(change!.reason, /~\$1\.02 \(estimated\) reached the \$1\.00 budget/);
  assert.match(readBudgetState(file)!.reason, /\$1\.00 budget/);
  assert.equal(g.onCost(3), null, "no repeated alarm");
});

test("quota budget trips, and lifts again when the window resets", () => {
  const file = budgetStatePath(tmp("vantage-budget-"));
  const g = new BudgetGuard({ maxCostUsd: null, maxQuota: 0.8 }, file);
  assert.equal(g.onQuota(quota(0.5)), null);
  assert.match(g.onQuota(quota(0.83))!.reason, /quota 5h 83% reached the 80% budget/);
  assert.equal(g.onQuota(quota(0.9)), null);
  assert.equal(g.onQuota(quota(0.02))?.kind, "cleared");
  assert.equal(readBudgetState(file), null);
});

test("a lifted quota trip keeps a reached cost budget in force", () => {
  const file = budgetStatePath(tmp("vantage-budget-"));
  const g = new BudgetGuard({ maxCostUsd: 1, maxQuota: 0.8 }, file);
  g.onQuota(quota(0.85));
  assert.equal(g.onCost(1.5)?.kind, "reached");
  assert.equal(g.onQuota(quota(0.1)), null, "still tripped by cost — nothing to announce");
  assert.match(readBudgetState(file)!.reason, /cost/);
  assert.doesNotMatch(readBudgetState(file)!.reason, /quota/);
});

test("a state file left from an earlier run never blocks a new session", () => {
  const file = budgetStatePath(tmp("vantage-budget-"));
  fs.writeFileSync(file, JSON.stringify({ reason: "old", since: "" }));
  new BudgetGuard({ maxCostUsd: 1, maxQuota: null }, file);
  assert.equal(readBudgetState(file), null);
});

test("blind spots are said once: unpriced models and accounts without quota windows", () => {
  const g = new BudgetGuard({ maxCostUsd: 1, maxQuota: 0.8 }, budgetStatePath(tmp("vantage-budget-")));
  assert.match(g.blindSpots(["mystery-model"], null)[0]!, /cannot count requests to mystery-model/);
  assert.deepEqual(g.blindSpots(["mystery-model"], null), []);
  const apiKeyAccount: RateLimitSnapshot = { requests: { limit: 50, remaining: 49, reset: null }, retryAfterSec: null, raw: {} };
  assert.match(g.blindSpots([], apiKeyAccount)[0]!, /use --max-cost/);
  assert.deepEqual(g.blindSpots([], apiKeyAccount), []);
});

test("while the budget is reached, every action needs approval; deny stays deny", () => {
  const reached = { reason: "session cost ~$2.01 (estimated) reached the $2.00 budget", since: "" };
  const write = decide("Write", DEFAULT_POLICY, reached);
  assert.equal(write.decision, "ask");
  assert.match(write.reason, /budget reached: session cost/);
  assert.equal(decide("Read", DEFAULT_POLICY, reached).decision, "ask");
  assert.equal(decide("Bash", { ...DEFAULT_POLICY, shell: "deny" }, reached).decision, "deny");
  assert.equal(decide("Write", DEFAULT_POLICY, null).decision, null, "no budget, no decision");
});

// ---------------------------------------------------------------------------
// End to end through `vantage run`.

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

// Does what Vantage relies on Claude Code doing: one API call through
// ANTHROPIC_BASE_URL, then — before running a tool — the PreToolUse hook
// registered via --settings. Prints the hook's answer.
const FAKE_CLAUDE = `
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
(async () => {
  const settings = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--settings") + 1], "utf8"));
  const hook = settings.hooks.PreToolUse[0].hooks[0];
  const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  await res.text();
  const out = spawnSync(hook.command, hook.args, { input: JSON.stringify({ tool_name: "Write" }), encoding: "utf8" });
  process.stdout.write("HOOK:" + (out.stdout || "none") + "\\n");
})();
`;

// An executable "agent" on every OS: a shebang script on POSIX, an npm-style
// .cmd shim around a JS file on Windows (the shape Vantage resolves there).
function fakeClaude(dir: string): string {
  if (process.platform === "win32") {
    const script = path.join(dir, "node_modules", "fake-claude", "cli.js");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, FAKE_CLAUDE);
    const shim = path.join(dir, "fake-claude.cmd");
    fs.writeFileSync(
      shim,
      `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n` +
        `SET "_prog=node"\r\n` +
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-claude\\cli.js" %*\r\n`
    );
    return shim;
  }
  const file = path.join(dir, "fake-claude");
  fs.writeFileSync(file, `#!${process.execPath}\n${FAKE_CLAUDE}`);
  fs.chmodSync(file, 0o755);
  return file;
}

function vantageRun(cwd: string, flags: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", cli, "run", "--no-memory", ...flags, "claude"], {
      cwd,
      env: { ...process.env, ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c));
    child.stderr.on("data", (c: Buffer) => (err += c));
    child.on("exit", (code) => resolve({ code, out, err }));
  });
}

test("`vantage run --max-cost`: the request that crosses the budget makes the next action ask", async () => {
  const mock = await startMockAnthropic();
  const dir = tmp("vantage-budget-run-");
  const env = { VANTAGE_UPSTREAM: mock.url, VANTAGE_AGENT_PATH: fakeClaude(dir), VANTAGE_HOME: dir };

  // The mock request costs ~$0.003 at Sonnet 5 prices.
  const over = await vantageRun(dir, ["--max-cost", "0.001"], env);
  assert.equal(over.code, 0, over.err);
  assert.match(over.err, /budget reached — session cost ~\$0\.0030 \(estimated\) reached the \$0\.0010 budget/);
  const answer = JSON.parse(/HOOK:(.*)/.exec(over.out)![1]!);
  assert.equal(answer.hookSpecificOutput.permissionDecision, "ask");
  assert.match(answer.hookSpecificOutput.permissionDecisionReason, /Vantage budget reached/);

  const sessions = path.join(dir, ".vantage", "sessions");
  const events = fs.readFileSync(path.join(sessions, fs.readdirSync(sessions)[0]!, "events.jsonl"), "utf8");
  assert.match(events, /"type":"budget","state":"reached"/);

  // Under budget: the hook is registered but stays silent.
  const under = await vantageRun(dir, ["--max-cost=5"], env);
  assert.equal(under.code, 0, under.err);
  assert.match(under.out, /HOOK:none/);
  assert.doesNotMatch(under.err, /budget reached/);

  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an invalid budget value is refused before anything starts", async () => {
  const dir = tmp("vantage-budget-bad-");
  const r = await vantageRun(dir, ["--max-quota", "lots"], {});
  assert.equal(r.code, 1);
  assert.match(r.err, /--max-quota needs a percentage/);
  assert.equal(fs.existsSync(path.join(dir, ".vantage")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
