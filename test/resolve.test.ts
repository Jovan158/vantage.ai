// Tests for resolving agent commands to something spawnable without a shell —
// the Windows case where npm installs agents as `.cmd` shims.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseNpmCmdShim, resolveCommand } from "../src/resolve.ts";

// What current npm writes for a package bin (cmd-shim).
const MODERN_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
`;

// Older npm versions used %~dp0 directly.
const LEGACY_SHIM = `@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\node_modules\\agent\\bin\\agent.mjs" %*
) ELSE (
  node  "%~dp0\\node_modules\\agent\\bin\\agent.mjs" %*
)`;

test("parses the script out of modern and legacy npm shims", () => {
  assert.equal(parseNpmCmdShim(MODERN_SHIM), "node_modules\\@anthropic-ai\\claude-code\\cli.js");
  assert.equal(parseNpmCmdShim(LEGACY_SHIM), "node_modules\\agent\\bin\\agent.mjs");
  assert.equal(parseNpmCmdShim("@echo off\r\nsome-native-tool.exe %*"), null);
});

test("non-Windows platforms pass the command through unchanged", () => {
  const r = resolveCommand("claude", { platform: "linux" });
  assert.deepEqual(r, { ok: true, resolved: { command: "claude", prefix: [] } });
});

// The remaining cases simulate Windows lookup against a real temp directory.
function sandbox(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-resolve-"));
  return { dir, env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } };
}

test("a real .exe is spawned directly", () => {
  const { dir, env } = sandbox();
  fs.writeFileSync(path.join(dir, "claude.exe"), "");
  const r = resolveCommand("claude", { platform: "win32", env });
  assert.ok(r.ok);
  assert.equal(r.resolved.command, path.join(dir, "claude.exe"));
  assert.deepEqual(r.resolved.prefix, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an npm .cmd shim becomes node + its script, no shell", () => {
  const { dir, env } = sandbox();
  fs.writeFileSync(path.join(dir, "claude.cmd"), MODERN_SHIM);
  const script = path.join(dir, "node_modules\\@anthropic-ai\\claude-code\\cli.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "");
  const r = resolveCommand("claude", { platform: "win32", env, nodePath: "C:\\node\\node.exe" });
  assert.ok(r.ok);
  assert.equal(r.resolved.command, "C:\\node\\node.exe");
  assert.deepEqual(r.resolved.prefix, [script]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("clear reasons when the command cannot be started safely", () => {
  const { dir, env } = sandbox();
  const missing = resolveCommand("claude", { platform: "win32", env });
  assert.ok(!missing.ok);
  assert.match(missing.reason, /not found on PATH/);

  fs.writeFileSync(path.join(dir, "claude.cmd"), "@echo off\r\nsome-native-tool.exe %*");
  const notShim = resolveCommand("claude", { platform: "win32", env });
  assert.ok(!notShim.ok);
  assert.match(notShim.reason, /cannot start without a shell/);

  fs.writeFileSync(path.join(dir, "claude.cmd"), MODERN_SHIM);
  const dangling = resolveCommand("claude", { platform: "win32", env });
  assert.ok(!dangling.ok);
  assert.match(dangling.reason, /does not exist/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Real Windows only: build an npm-style shim, resolve it, spawn it, and prove
// an argument full of cmd.exe metacharacters arrives byte-for-byte — i.e. no
// shell ever touched it. That is what protects prompts and injected memory.
test("on Windows, a shimmed agent starts and receives arguments untouched", { skip: process.platform !== "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-shim-"));
  const script = path.join(dir, "node_modules", "fake-agent", "cli.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
  fs.writeFileSync(
    path.join(dir, "fake-agent.cmd"),
    MODERN_SHIM.replace("node_modules\\@anthropic-ai\\claude-code\\cli.js", "node_modules\\fake-agent\\cli.js")
  );

  const r = resolveCommand("fake-agent", { env: { ...process.env, PATH: `${dir};${process.env.PATH ?? ""}` } });
  assert.ok(r.ok, r.ok ? "" : r.reason);

  const tricky = 'say "hi" & echo pwned | more %PATH% ^caret';
  const out = spawnSync(r.resolved.command, [...r.resolved.prefix, "-p", tricky], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), ["-p", tricky]);
  fs.rmSync(dir, { recursive: true, force: true });
});
