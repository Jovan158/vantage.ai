// Tests for action-type classification, policy loading, and the watcher.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTool,
  loadPolicy,
  DEFAULT_POLICY,
  PolicyWatcher,
  summarizeActions,
  formatActionSummary,
} from "../src/policy.ts";

test("classifies known and unknown tools", () => {
  assert.equal(classifyTool("Read"), "read");
  assert.equal(classifyTool("Write"), "write");
  assert.equal(classifyTool("Edit"), "write");
  assert.equal(classifyTool("Bash"), "shell");
  assert.equal(classifyTool("WebFetch"), "network");
  assert.equal(classifyTool("mcp__github__create_pr"), "network");
  assert.equal(classifyTool("SomeCustomEditor"), "write"); // heuristic
  assert.equal(classifyTool("TodoWrite"), "write"); // heuristic on 'write'
  assert.equal(classifyTool("Think"), "other");
});

test("env override wins over defaults", () => {
  const p = loadPolicy("/nonexistent", { VANTAGE_POLICY: "shell:allow,network:warn,read:warn" } as NodeJS.ProcessEnv);
  assert.equal(p.shell, "allow");
  assert.equal(p.network, "warn");
  assert.equal(p.read, "warn");
  // defaults preserved where not overridden
  assert.equal(p.write, DEFAULT_POLICY.write);
});

test("watcher warns once per warned action type", () => {
  const w = new PolicyWatcher({ read: "allow", write: "allow", shell: "warn", network: "warn", other: "allow" });
  const first = w.observe(["Read", "Bash", "Write"]);
  assert.equal(first.length, 1, "only shell warns");
  assert.equal(first[0]!.type, "shell");
  assert.equal(w.observe(["Bash"]).length, 0, "no repeat for shell");
  const net = w.observe(["WebFetch"]);
  assert.equal(net.length, 1);
  assert.equal(net[0]!.type, "network");
});

test("action summary counts by type", () => {
  const counts = summarizeActions(["Read", "Read", "Write", "Bash", "WebFetch", "WebFetch"]);
  assert.equal(counts.read, 2);
  assert.equal(counts.write, 1);
  assert.equal(counts.shell, 1);
  assert.equal(counts.network, 2);
  assert.equal(formatActionSummary(counts), "read×2 · write×1 · shell×1 · network×2");
  assert.equal(formatActionSummary(summarizeActions([])), null);
});
