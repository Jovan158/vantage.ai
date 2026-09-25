// Tests for PreToolUse enforcement — the decision logic behind problem ②.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decide, buildOutput, runHook, hookSettings, hookInvocation, parseHookInput } from "../src/hook.ts";
import type { Policy } from "../src/policy.ts";

const policy = (over: Partial<Policy> = {}): Policy => ({
  read: "allow",
  write: "allow",
  shell: "warn",
  network: "warn",
  other: "allow",
  ...over,
});

test("deny blocks the tool with a reason naming the action type", () => {
  const v = decide("Bash", policy({ shell: "deny" }));
  assert.equal(v.type, "shell");
  assert.equal(v.decision, "deny");
  const out = buildOutput(v);
  assert.equal(out!.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out!.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out!.hookSpecificOutput.permissionDecisionReason, /shell actions are set to 'deny'/);
});

test("ask escalates to human approval", () => {
  const v = decide("Write", policy({ write: "ask" }));
  assert.equal(v.decision, "ask");
  assert.match(buildOutput(v)!.hookSpecificOutput.permissionDecisionReason, /requires approval/);
});

test("allow and warn emit NO decision — Vantage must never widen access", () => {
  // An explicit "allow" would override the user's own permission rules.
  assert.equal(decide("Read", policy()).decision, null);
  assert.equal(buildOutput(decide("Read", policy())), null);
  assert.equal(decide("Bash", policy({ shell: "warn" })).decision, null);
});

test("runHook turns raw stdin into the stdout contract", () => {
  const input = JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /" },
    cwd: "/repo",
  });
  const out = runHook(input, policy({ shell: "deny" }));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");

  // Allowed action -> empty output -> normal permission flow.
  assert.equal(runHook(input, policy({ shell: "allow" })), "");
});

test("malformed or toolless input never blocks work", () => {
  assert.equal(runHook("not json", policy({ shell: "deny" })), "");
  assert.equal(runHook("{}", policy({ shell: "deny" })), "");
  assert.equal(parseHookInput("["), null);
});

test("unknown tools are classified before being judged", () => {
  // MCP tools reach external services -> network.
  assert.equal(decide("mcp__github__create_pr", policy({ network: "deny" })).decision, "deny");
  // Heuristic write classification still enforces.
  assert.equal(decide("SomeCustomEditor", policy({ write: "ask" })).decision, "ask");
});

test("settings fragment registers the hook in exec form (no shell)", () => {
  const inv = hookInvocation("/usr/bin/node", "/x/dist/cli.js");
  const s = hookSettings(inv) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string; args: string[] }> }> };
  };
  const entry = s.hooks.PreToolUse[0]!;
  assert.equal(entry.matcher, "*");
  assert.equal(entry.hooks[0]!.type, "command");
  assert.equal(entry.hooks[0]!.command, "/usr/bin/node");
  assert.deepEqual(entry.hooks[0]!.args, ["/x/dist/cli.js", "hook"]);
});

test("a TypeScript entry gets type stripping, a compiled one does not", () => {
  assert.deepEqual(hookInvocation("node", "/a/src/cli.ts").args, ["--experimental-strip-types", "/a/src/cli.ts", "hook"]);
  assert.deepEqual(hookInvocation("node", "/a/dist/cli.js").args, ["/a/dist/cli.js", "hook"]);
});

// End to end, on whatever OS runs the suite: spawn the exact invocation we
// register — command + args, NO shell, as Claude Code does in exec form — feed
// it a real PreToolUse payload, and check the decision on stdout. On the
// Windows CI runner this exercises real Windows paths, the case that shell
// quoting would have broken.
test("the registered invocation runs and blocks a denied tool", () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
  const inv = hookInvocation(process.execPath, entry);
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" } });

  const denied = spawnSync(inv.command, inv.args, {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, VANTAGE_POLICY: "shell:deny" },
  });
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");

  const allowed = spawnSync(inv.command, inv.args, {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, VANTAGE_POLICY: "shell:allow" },
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout, "", "no decision -> normal permission flow");
});
