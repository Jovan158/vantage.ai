// Alerts shown in Claude Code's chat: the outbox `vantage run` posts to, and
// the hooks that hand its contents to Claude Code as a systemMessage.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { postAlert, takeAlerts, chatText, outboxPath } from "../src/outbox.ts";
import { hookInvocation, hookSettings } from "../src/hook.ts";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "vantage-outbox-"));

test("each alert is taken exactly once, without duplicates, in order", () => {
  const file = outboxPath(tmp());
  assert.deepEqual(takeAlerts(file), [], "nothing posted yet");
  postAlert(file, { level: "warn", message: "5-hour quota at 91%" });
  postAlert(file, { level: "critical", message: "an AWS access key was sent" });
  postAlert(file, { level: "warn", message: "5-hour quota at 91%" });
  const taken = takeAlerts(file);
  assert.deepEqual(taken.map((a) => a.message), ["5-hour quota at 91%", "an AWS access key was sent"]);
  assert.equal(chatText(taken), "Vantage: 5-hour quota at 91%\nVantage ALERT: an AWS access key was sent");
  assert.deepEqual(takeAlerts(file), [], "taken already");
  postAlert(file, { level: "warn", message: "later" });
  assert.deepEqual(takeAlerts(file).map((a) => a.message), ["later"]);
});

test("the Stop hook is registered only when asked for, in exec form", () => {
  const inv = hookInvocation("/usr/bin/node", "/x/dist/cli.js");
  const both = hookSettings(inv, { preToolUse: true, stop: true }) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; args: string[] }> }>> };
  assert.deepEqual(Object.keys(both.hooks), ["PreToolUse", "Stop"]);
  assert.equal(both.hooks.Stop![0]!.matcher, undefined);
  assert.deepEqual(both.hooks.Stop![0]!.hooks[0]!.args, ["/x/dist/cli.js", "hook"]);
  const stopOnly = hookSettings(inv, { stop: true }) as { hooks: Record<string, unknown> };
  assert.deepEqual(Object.keys(stopOnly.hooks), ["Stop"]);
});

function runHookProcess(payload: object, env: Record<string, string>): { status: number | null; stdout: string } {
  const inv = hookInvocation(process.execPath, ENTRY);
  const r = spawnSync(inv.command, inv.args, { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, ...env } });
  return { status: r.status, stdout: r.stdout };
}

test("when a reply is finished, the Stop hook shows waiting alerts in the chat and never blocks", () => {
  const file = outboxPath(tmp());
  const quiet = runHookProcess({ hook_event_name: "Stop" }, { VANTAGE_OUTBOX_FILE: file });
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, "", "nothing waiting: no output");

  postAlert(file, { level: "critical", message: "a GitHub token was sent to the API" });
  const r = runHookProcess({ hook_event_name: "Stop", stop_hook_active: false }, { VANTAGE_OUTBOX_FILE: file });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout) as Record<string, unknown>;
  assert.deepEqual(out, { systemMessage: "Vantage ALERT: a GitHub token was sent to the API" });
  assert.ok(!fs.existsSync(file));
});

test("before a tool, waiting alerts ride along with the decision", () => {
  const file = outboxPath(tmp());
  postAlert(file, { level: "warn", message: "budget: 80% of $2 used" });
  const r = runHookProcess(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi" } },
    { VANTAGE_OUTBOX_FILE: file, VANTAGE_POLICY: "shell:deny", VANTAGE_POLICY_FILE: "", VANTAGE_EVENTS_FILE: "" }
  );
  const out = JSON.parse(r.stdout) as { systemMessage: string; hookSpecificOutput: { permissionDecision: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(out.systemMessage, "Vantage: budget: 80% of $2 used");

  postAlert(file, { level: "warn", message: "no decision, still shown" });
  const allowed = runHookProcess(
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a.txt" } },
    { VANTAGE_OUTBOX_FILE: file, VANTAGE_POLICY: "read:allow", VANTAGE_POLICY_FILE: "", VANTAGE_EVENTS_FILE: "" }
  );
  assert.deepEqual(JSON.parse(allowed.stdout), { systemMessage: "Vantage: no decision, still shown" }, "never an allow decision");
});
