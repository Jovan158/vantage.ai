// Tests for PreToolUse enforcement — the decision logic behind problem ②.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, buildOutput, runHook, hookSettings, parseHookInput } from "../src/hook.ts";
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

test("settings fragment registers a PreToolUse hook for every tool", () => {
  const s = hookSettings('"/usr/bin/node" "/x/cli.js" hook') as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };
  const entry = s.hooks.PreToolUse[0]!;
  assert.equal(entry.matcher, "*");
  assert.equal(entry.hooks[0]!.type, "command");
  assert.match(entry.hooks[0]!.command, /cli\.js" hook$/);
});
