// `vantage setup`: Vantage's hook added once to an agent's own settings —
// next to the user's hooks, never instead of them, and only once.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installSetup, setupState, hermesSnippet, hookCommand } from "../src/setup.ts";

const ENTRY = "/opt/vantage/dist/cli.js";

function withHome(fn: (home: string) => void): void {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vantage-setup-"));
  const saved = { a: process.env.VANTAGE_SETUP_HOME, g: process.env.GEMINI_CLI_HOME, h: process.env.HERMES_HOME };
  process.env.VANTAGE_SETUP_HOME = home;
  process.env.GEMINI_CLI_HOME = home;
  process.env.HERMES_HOME = path.join(home, ".hermes");
  try {
    fn(home);
  } finally {
    for (const [k, v] of [["VANTAGE_SETUP_HOME", saved.a], ["GEMINI_CLI_HOME", saved.g], ["HERMES_HOME", saved.h]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("Cursor: added next to the user's hooks, once", () => {
  withHome((home) => {
    const file = path.join(home, ".cursor", "hooks.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: "./mine.sh" }], stop: [{ command: "./done.sh" }] } }));
    assert.equal(setupState("cursor", ENTRY).installed, false);
    installSetup("cursor", ENTRY);
    installSetup("cursor", ENTRY);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(cfg.hooks.preToolUse.map((h: { command: string }) => h.command), ["./mine.sh", hookCommand("cursor", ENTRY)]);
    assert.deepEqual(cfg.hooks.stop, [{ command: "./done.sh" }]);
    assert.deepEqual(setupState("cursor", ENTRY), { installed: true, file, stale: false });
    assert.equal(setupState("cursor", "/elsewhere/cli.js").stale, true, "a moved Vantage shows as stale");
  });
});

test("Gemini CLI: three events, the user's hooks kept; a file with comments is left alone", () => {
  withHome((home) => {
    const file = path.join(home, ".gemini", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } }, hooks: { BeforeTool: [{ matcher: "write_file", hooks: [{ type: "command", command: "lint" }] }] } }));
    installSetup("gemini", ENTRY);
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(cfg.security.auth.selectedType, "oauth-personal");
    assert.equal(cfg.hooks.BeforeTool.length, 2);
    assert.equal(cfg.hooks.BeforeTool[0].hooks[0].command, "lint");
    assert.deepEqual(Object.keys(cfg.hooks).sort(), ["AfterAgent", "BeforeTool", "SessionStart"]);
    assert.equal(setupState("gemini", ENTRY).installed, true);

    const commented = '{\n  // mine\n  "ui": { "theme": "dark" }\n}\n';
    fs.writeFileSync(file, commented);
    const lines = installSetup("gemini", ENTRY);
    assert.match(lines[0]!, /does not rewrite it/);
    assert.equal(fs.readFileSync(file, "utf8"), commented);
  });
});

test("Antigravity: a plugin of its own", () => {
  withHome((home) => {
    installSetup("antigravity", ENTRY);
    const dir = path.join(home, ".gemini", "config", "plugins", "vantage");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8")).name, "vantage");
    const hooks = JSON.parse(fs.readFileSync(path.join(dir, "hooks.json"), "utf8"));
    assert.equal(hooks.vantage.PreToolUse[0].hooks[0].command, hookCommand("antigravity", ENTRY));
    assert.equal(setupState("antigravity", ENTRY).installed, true);
  });
});

test("Hermes: appended when the config has no hooks, shown otherwise; approved either way", () => {
  withHome((home) => {
    const dir = path.join(home, ".hermes");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.yaml"), "model:\n  default: claude-sonnet-5\n");
    installSetup("hermes", ENTRY);
    const yaml = fs.readFileSync(path.join(dir, "config.yaml"), "utf8");
    assert.ok(yaml.startsWith("model:\n  default: claude-sonnet-5\nhooks:\n  pre_tool_call:\n"));
    assert.equal(setupState("hermes", ENTRY).installed, true);
    const allow = JSON.parse(fs.readFileSync(path.join(dir, "shell-hooks-allowlist.json"), "utf8"));
    assert.deepEqual(allow.approvals.map((a: { event: string; command: string }) => [a.event, a.command]), [["pre_tool_call", hookCommand("hermes", ENTRY)]]);

    fs.writeFileSync(path.join(dir, "config.yaml"), "hooks:\n  post_tool_call: []\n");
    const lines = installSetup("hermes", ENTRY);
    assert.match(lines[0]!, /already has hooks/);
    assert.equal(fs.readFileSync(path.join(dir, "config.yaml"), "utf8"), "hooks:\n  post_tool_call: []\n");
    assert.match(hermesSnippet(ENTRY), /pre_tool_call:\n {4}- command: /);
  });
});

test("agents that take their hooks per session need no setup", () => {
  assert.throws(() => installSetup("codex", ENTRY), /needs no setup/);
});
