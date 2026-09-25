// Tests for file-based project memory: init, compile, skip-templates, add.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initMemory, compileMemory, addNote, memoryDir } from "../src/memory.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vantage-mem-"));
}

test("init scaffolds files; empty templates do not count as memory", () => {
  const cwd = tmp();
  const { created } = initMemory(cwd);
  assert.ok(created.includes("decisions.md"));
  assert.equal(compileMemory(cwd), null, "template-only store is empty");
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("compile includes only files with real content, in order", () => {
  const cwd = tmp();
  initMemory(cwd);
  fs.writeFileSync(path.join(memoryDir(cwd), "architecture.md"), "# Architecture\n\nProxy + adapters.\n");
  fs.writeFileSync(path.join(memoryDir(cwd), "decisions.md"), "# Decisions\n\n- Chose Postgres.\n");
  const compiled = compileMemory(cwd);
  assert.ok(compiled);
  assert.match(compiled!, /persistent project memory/);
  assert.match(compiled!, /Proxy \+ adapters/);
  assert.match(compiled!, /Chose Postgres/);
  // architecture appears before decisions
  assert.ok(compiled!.indexOf("Architecture") < compiled!.indexOf("Decisions"));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("addNote appends a dated bullet and creates missing files", () => {
  const cwd = tmp();
  const p = addNote(cwd, "decisions", "use worktrees for isolation");
  const body = fs.readFileSync(p, "utf8");
  assert.match(body, /# Decisions/);
  assert.match(body, /- \(\d{4}-\d{2}-\d{2}\) use worktrees for isolation/);
  assert.ok(compileMemory(cwd));
  fs.rmSync(cwd, { recursive: true, force: true });
});
