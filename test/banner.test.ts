// The logo at the top of `vantage`, `vantage --help` and `vantage doctor`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { banner, packageVersion, SLOGAN } from "../src/banner.ts";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");

test("the logo spells vantage.ai, with the slogan and version below", () => {
  const out = banner({ art: true, color: false, version: "1.2.3" });
  const lines = out.split("\n");
  assert.equal(lines.length, 7);
  assert.equal(lines[4], "|___/\\__,_/_/ /_/\\__/\\__,_/\\__, /\\___(_)__,_/_/");
  assert.equal(lines[6], `${SLOGAN} · v1.2.3`);
  assert.ok(lines.every((l) => /^[\x20-\x7e·]*$/.test(l)), "plain ASCII apart from the separator");
  assert.ok(!out.includes("\x1b"), "no color when color is off");
});

test("too narrow for the logo, or not a terminal: one line", () => {
  const one = `vantage.ai · ${SLOGAN} · v1.2.3`;
  assert.equal(banner({ art: true, color: false, version: "1.2.3", columns: 40 }), one);
  assert.equal(banner({ art: false, color: false, version: "1.2.3" }), one);
  assert.equal(banner({ art: true, color: false, version: "1.2.3", columns: 0 }).split("\n").length, 7, "width 0 means unknown");
});

test("the version comes from package.json", () => {
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});

test("help that is piped starts with the one-line form", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split("\n")[0], `vantage.ai · ${SLOGAN} · v${packageVersion()}`);
});
