// Runs every installed agent through `vantage run` against a stand-in model
// API (src/dev/mock-llm.ts): no account, no network. Each agent is asked to
// run one shell command under a policy that denies shell commands, and the
// session log must show the model call metered and the command blocked. It
// also reports whether the project memory reached the model.
//
//   node --experimental-strip-types scripts/e2e-agents.ts [agent ...]
//
// Each agent runs with a home directory of its own, so nothing of yours is
// read or changed. Agents that are not installed are skipped.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockLlm } from "../src/dev/mock-llm.ts";
import { resolveCommand } from "../src/resolve.ts";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const PROMPT = "run the probe";
const MARKER = "Vantage-e2e-memory-marker";

interface Case {
  agent: string;
  command: string;
  args: string[];
  /** Environment for the run; MOCK is the mock's base URL, HOME the agent's home. */
  env(mock: string, home: string): Record<string, string>;
  /** Settings the agent needs in its home before it runs. */
  prepare?(home: string): void;
}

const CASES: Case[] = [
  {
    agent: "claude",
    command: "claude",
    args: ["-p", PROMPT],
    env: (mock) => ({ VANTAGE_UPSTREAM: mock, ANTHROPIC_API_KEY: "sk-ant-e2e" }),
  },
  {
    agent: "codex",
    command: "codex",
    args: ["exec", "--skip-git-repo-check", PROMPT],
    env: (mock, home) => ({ VANTAGE_UPSTREAM: `${mock}/v1`, CODEX_API_KEY: "sk-e2e", CODEX_HOME: path.join(home, ".codex") }),
    prepare: (home) => fs.mkdirSync(path.join(home, ".codex"), { recursive: true }),
  },
  {
    agent: "copilot",
    command: "copilot",
    args: ["-p", PROMPT, "--allow-all-tools"],
    env: (mock, home) => ({ COPILOT_PROVIDER_BASE_URL: `${mock}/v1`, COPILOT_PROVIDER_API_KEY: "sk-e2e", COPILOT_MODEL: "gpt-5.5-mini", COPILOT_HOME: path.join(home, ".copilot"), COPILOT_AUTO_UPDATE: "false" }),
  },
  {
    agent: "opencode",
    command: "opencode",
    args: ["run", "-m", "anthropic/claude-sonnet-4-5", PROMPT],
    env: (mock) => ({ VANTAGE_UPSTREAM: `${mock}/v1`, ANTHROPIC_API_KEY: "sk-ant-e2e" }),
  },
  {
    agent: "pi",
    command: "pi",
    args: ["-p", "--provider", "anthropic", "--model", "claude-sonnet-4-5", PROMPT],
    env: (mock) => ({ VANTAGE_UPSTREAM: mock, ANTHROPIC_API_KEY: "sk-ant-e2e" }),
  },
];

type Event = { type: string; decision?: string; in?: number };

async function runCase(c: Case): Promise<string> {
  if (!resolveCommand(c.command).ok) return "skipped (not installed)";
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `vantage-e2e-${c.agent}-`));
  const home = path.join(base, "home");
  const project = path.join(base, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, ".vantage"), { recursive: true });
  fs.writeFileSync(path.join(project, ".vantage", "policy.json"), JSON.stringify({ shell: "deny" }));
  fs.mkdirSync(path.join(project, ".vantage", "memory"), { recursive: true });
  fs.writeFileSync(path.join(project, ".vantage", "memory", "decisions.md"), `# Decisions\n\n- ${MARKER}\n`);
  c.prepare?.(home);
  const mock = await startMockLlm({ command: "echo vantage-probe" });
  try {
    const env = { ...process.env, HOME: home, USERPROFILE: home, VANTAGE_HOME: path.join(home, ".vantage"), ...c.env(mock.url, home) };
    // Asynchronous: the mock answers from this very process.
    const cli = (args: string[]): Promise<{ status: number | null; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ["--experimental-strip-types", ENTRY, ...args], { cwd: project, env, stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        const timer = setTimeout(() => child.kill(), 240_000);
        child.on("close", (status) => {
          clearTimeout(timer);
          resolve({ status, stderr });
        });
      });
    const r = await cli(["run", c.agent, "--", ...c.args]);
    const sessions = path.join(project, ".vantage", "sessions");
    const dir = fs.existsSync(sessions) ? fs.readdirSync(sessions)[0] : undefined;
    const events: Event[] = dir
      ? fs.readFileSync(path.join(sessions, dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Event)
      : [];
    const metered = events.filter((e) => e.type === "usage" && (e.in ?? 0) > 0).length;
    const blocked = events.some((e) => e.type === "decision" && e.decision === "deny");
    const memory = mock.requests.some((q) => JSON.stringify(q.body ?? "").includes(MARKER)) ? "memory reached the model" : "no memory";
    if (metered > 0 && blocked) return `ok (${metered} model calls metered, shell command blocked, ${memory})`;
    const tail = String(r.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
    return `FAILED (metered ${metered}, blocked ${blocked}, exit ${r.status}) ${tail}`;
  } finally {
    await mock.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2);
let failed = 0;
for (const c of CASES.filter((x) => only.length === 0 || only.includes(x.agent))) {
  const result = await runCase(c);
  if (result.startsWith("FAILED")) failed++;
  process.stdout.write(`${c.agent.padEnd(10)} ${result}\n`);
}
process.exit(failed ? 1 : 0);
