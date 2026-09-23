// VANTAGE_AGENT_PATH: start the agent from an explicit executable instead of
// looking it up. Exercised through the real `vantage run`, on every OS, using
// node itself as the "agent" so the test needs no agent installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

function runVantage(agentPath: string, agentArgs: string[]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-agentpath-"));
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", cli, "run", "claude", "--", ...agentArgs],
    { cwd, encoding: "utf8", env: { ...process.env, VANTAGE_AGENT_PATH: agentPath }, timeout: 30_000 }
  );
  fs.rmSync(cwd, { recursive: true, force: true });
  return res;
}

test("VANTAGE_AGENT_PATH starts the agent from that executable", () => {
  const res = runVantage(process.execPath, ["-e", "console.log('AGENT-PATH-OK')"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /AGENT-PATH-OK/);
  assert.match(res.stderr, /agent from VANTAGE_AGENT_PATH/);
});

test("a VANTAGE_AGENT_PATH that does not exist fails clearly and ends the session", () => {
  const missing = path.join(os.tmpdir(), "definitely-not-here", "claude.exe");
  const res = runVantage(missing, []);
  assert.equal(res.status, 127);
  assert.match(res.stderr, /VANTAGE_AGENT_PATH points at .* which does not exist/);
});

test("the agent is named `claude`; `claude-code` still works but is not advertised", async () => {
  const { resolveAdapter, knownAgents } = await import("../src/agents/index.ts");
  assert.deepEqual(knownAgents(), ["claude"]);
  assert.equal(resolveAdapter("claude-code"), resolveAdapter("claude"));
  assert.equal(resolveAdapter("codex"), undefined);
});
