// Desktop notifications: the command per OS (text never inside a command
// string), deduplication, when they are on, and following the event log for
// the hook's questions.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { notifyCommand, Notifier, notificationsEnabled } from "../src/notify.ts";
import { followEvents } from "../src/events.ts";

const TRICKY = `it's "done" & $(rm -rf /); echo pwned`;

test("title and text travel in the environment, never in a command string", () => {
  for (const platform of ["win32", "darwin"] as const) {
    const cmd = notifyCommand(platform, "Title", TRICKY)!;
    assert.equal(cmd.env.VANTAGE_NOTIFY_BODY, TRICKY);
    assert.ok(!cmd.args.join(" ").includes("pwned"), `${platform}: text must not be part of the script`);
  }
  // notify-send gets them as separate arguments; no shell parses them.
  const linux = notifyCommand("linux", "Title", TRICKY)!;
  assert.equal(linux.command, "notify-send");
  assert.equal(linux.args.at(-1), TRICKY);
  assert.equal(notifyCommand("aix", "t", "b"), null);
});

test("each kind of event notifies once per cooldown", () => {
  const sent: string[] = [];
  const n = new Notifier((title, body) => sent.push(`${title}|${body}`), 60_000);
  assert.equal(n.notify("quota:5h", "Limit", "92%", 0), true);
  assert.equal(n.notify("quota:5h", "Limit", "93%", 30_000), false);
  assert.equal(n.notify("ask:1", "Approve", "Bash", 30_000), true);
  assert.equal(n.notify("quota:5h", "Limit", "95%", 61_000), true);
  assert.deepEqual(sent, ["Limit|92%", "Approve|Bash", "Limit|95%"]);
});

test("on while the chat UI has the terminal, off otherwise; VANTAGE_NOTIFY overrides", () => {
  assert.equal(notificationsEnabled(true, {}), true);
  assert.equal(notificationsEnabled(false, {}), false);
  assert.equal(notificationsEnabled(true, { VANTAGE_NOTIFY: "0" }), false);
  assert.equal(notificationsEnabled(false, { VANTAGE_NOTIFY: "1" }), true);
});

test("followEvents delivers lines other processes append, including split writes", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vantage-follow-")), "events.jsonl");
  fs.writeFileSync(file, JSON.stringify({ ts: "t0", type: "request" }) + "\n"); // before: not delivered
  const seen: string[] = [];
  const stop = followEvents(file, (e) => seen.push(e.type), 20);
  const line = JSON.stringify({ ts: "t1", type: "decision", tool: "Bash", decision: "ask", reason: "r" });
  fs.appendFileSync(file, line.slice(0, 20));
  await new Promise((r) => setTimeout(r, 60));
  fs.appendFileSync(file, line.slice(20) + "\n");
  await new Promise((r) => setTimeout(r, 60));
  stop();
  assert.deepEqual(seen, ["decision"]);
});

// On a real Windows runner: the toast script runs without error.
test("on Windows, the toast command runs", { skip: process.platform !== "win32" }, () => {
  const cmd = notifyCommand("win32", "Vantage test", TRICKY)!;
  const r = spawnSync(cmd.command, cmd.args, { env: { ...process.env, ...cmd.env }, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
});
