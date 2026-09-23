// Desktop notifications: the command per OS (text never inside a command
// string), deduplication, when they are on, and following the event log for
// the hook's questions.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { notifyCommand, Notifier } from "../src/notify.ts";
import { parseConfig, loadConfig, enabledNotifyKinds, NOTIFY_KINDS } from "../src/config.ts";
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

test("only enabled kinds are sent, titled with the project, once per cooldown", () => {
  const sent: string[] = [];
  const n = new Notifier((title, body) => sent.push(`${title}|${body}`), {
    kinds: new Set(["limits", "approval"] as const),
    project: "vantage.dev",
    cooldownMs: 60_000,
  });
  assert.equal(n.notify("limits", "quota:5h", "Usage limit", "92%", 0), true);
  assert.equal(n.notify("limits", "quota:5h", "Usage limit", "93%", 30_000), false, "cooldown");
  assert.equal(n.notify("done", "done:1", "Claude is done", "x", 30_000), false, "kind turned off");
  assert.equal(n.notify("approval", "ask:1", "Waiting", "Bash", 30_000), true);
  assert.equal(n.notify("limits", "quota:5h", "Usage limit", "95%", 61_000), true);
  assert.deepEqual(sent, ["vantage.dev · Usage limit|92%", "vantage.dev · Waiting|Bash", "vantage.dev · Usage limit|95%"]);
});

test("settings: all off, single kinds off, and what overrides what", () => {
  const all = new Set(NOTIFY_KINDS);
  const kinds = (config: unknown, interactive: boolean, env: NodeJS.ProcessEnv = {}, noNotifyFlag = false) =>
    [...enabledNotifyKinds(parseConfig(config), { interactive, env, noNotifyFlag })].sort();

  assert.deepEqual(kinds({}, true), [...all].sort(), "default: everything while the chat is open");
  assert.deepEqual(kinds({}, false), [], "default: nothing in print mode");
  assert.deepEqual(kinds({ notify: false }, true), []);
  assert.deepEqual(kinds({ notify: { done: false, limits: false } }, true), ["approval", "budget", "secrets"]);
  assert.deepEqual(kinds({}, true, { VANTAGE_NOTIFY: "0" }), [], "env beats the file");
  assert.deepEqual(kinds({ notify: false }, false, { VANTAGE_NOTIFY: "1" }).length, all.size);
  assert.deepEqual(kinds({}, true, { VANTAGE_NOTIFY: "1" }, true), [], "--no-notify beats everything");

  assert.throws(() => parseConfig({ notify: { dnoe: false } }), /unknown notification kind "dnoe"/);
  assert.throws(() => parseConfig({ notify: "off" }), /must be true, false or an object/);
});

test("a broken settings file is reported and the defaults apply", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-config-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, "{ notify: nope");
  const r = loadConfig(file);
  assert.deepEqual(r.config, { notify: true });
  assert.match(r.error ?? "", /config\.json/);
  assert.deepEqual(loadConfig(path.join(dir, "missing.json")), { config: { notify: true }, error: null });
  fs.rmSync(dir, { recursive: true, force: true });
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
