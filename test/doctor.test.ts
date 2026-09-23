// `vantage doctor`: each check against real processes where possible.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkNode, checkClaude, checkHook, checkPolicy, checkNotification, renderDoctor } from "../src/doctor.ts";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("Node.js version floor is 22.6", () => {
  assert.equal(checkNode("22.6.0").level, "ok");
  assert.equal(checkNode("24.1.0").level, "ok");
  assert.equal(checkNode("22.5.1").level, "fail");
  assert.equal(checkNode("20.11.0").level, "fail");
});

test("Claude Code: started for its version, or a clear failure", () => {
  const cwd = tmp("vantage-doc-");
  // node stands in for Claude Code: it answers --version too.
  const ok = checkClaude({ cwd, entry, env: { ...process.env, VANTAGE_AGENT_PATH: process.execPath } });
  assert.equal(ok.level, "ok");
  assert.match(ok.text, /v\d+\.\d+.*via VANTAGE_AGENT_PATH/);

  const missing = checkClaude({ cwd, entry, env: { ...process.env, VANTAGE_AGENT_PATH: path.join(cwd, "nope.exe") } });
  assert.equal(missing.level, "fail");
  assert.match(missing.text, /does not exist/);

  const none = checkClaude({ cwd, entry, env: { ...process.env, PATH: cwd, Path: cwd, VANTAGE_AGENT_PATH: "" } });
  assert.equal(none.level, "fail");
  assert.match(none.hint ?? "", /VANTAGE_AGENT_PATH/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("the hook check runs the real hook the way Claude Code starts it", () => {
  const cwd = tmp("vantage-doc-");
  const c = checkHook({ cwd, entry });
  assert.equal(c.level, "ok", c.hint ?? "");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("a broken policy file is a failure: its rules would silently not apply", () => {
  const cwd = tmp("vantage-doc-");
  assert.equal(checkPolicy({ cwd, entry }).level, "info");
  fs.mkdirSync(path.join(cwd, ".vantage"));
  fs.writeFileSync(path.join(cwd, ".vantage", "policy.json"), '{ "files": { ".env": "deny" }');
  const bad = checkPolicy({ cwd, entry });
  assert.equal(bad.level, "fail");
  assert.match(bad.text, /not valid JSON/);
  fs.writeFileSync(path.join(cwd, ".vantage", "policy.json"), '{ "files": { ".env": "deny" } }');
  assert.match(checkPolicy({ cwd, entry }).text, /1 file\/command rule/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("notifications: an unsupported system is a warning, not a failure", () => {
  assert.equal(checkNotification({ cwd: ".", entry, platform: "aix" }).level, "warn");
});

test("summary: problems, warnings, or all good", () => {
  assert.match(renderDoctor([{ level: "ok", text: "a" }], false), /Everything is in place\./);
  assert.match(renderDoctor([{ level: "warn", text: "a", hint: "do x" }], false), /warn  a\n\s+do x[\s\S]*Ready, with 1 warning/);
  assert.match(renderDoctor([{ level: "fail", text: "a" }, { level: "warn", text: "b" }], false), /1 problem\(s\) to fix, 1 warning/);
});

test("`vantage doctor` runs end to end", () => {
  const cwd = tmp("vantage-doc-");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", entry, "doctor", "--no-notify"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, VANTAGE_HOME: cwd, VANTAGE_AGENT_PATH: process.execPath },
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ok\s+approval hook runs and blocks/);
  assert.match(r.stdout, /ok\s+settings folder is writable/);
  assert.doesNotMatch(r.stdout, /test notification/, "--no-notify skips it");
  fs.rmSync(cwd, { recursive: true, force: true });
});
