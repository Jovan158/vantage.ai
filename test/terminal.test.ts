// Vantage must stay out of Claude Code's interactive UI: nothing written to the
// terminal while it is open, alerts delivered after it closes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalGate } from "../src/terminal.ts";
import { resolveAdapter } from "../src/agents/index.ts";

test("while held, routine lines are dropped and alerts wait", () => {
  const out: string[] = [];
  const gate = new TerminalGate((t) => out.push(t));
  gate.info("before\n");
  gate.hold();
  gate.info("status line\n");
  gate.alert("quota 92%\n");
  gate.alert("quota 92%\n"); // the same alert twice is held once
  gate.alert("budget reached\n");
  assert.deepEqual(out, ["before\n"], "nothing reaches the terminal while held");
  assert.deepEqual(gate.release(), ["quota 92%\n", "budget reached\n"]);
  gate.info("after\n");
  assert.deepEqual(out, ["before\n", "after\n"]);
});

test("the chat UI is interactive; print mode is not", () => {
  const claude = resolveAdapter("claude")!;
  assert.equal(claude.isInteractive([]), true);
  assert.equal(claude.isInteractive(["--model", "claude-opus-5-5"]), true);
  assert.equal(claude.isInteractive(["-p", "hi"]), false);
  assert.equal(claude.isInteractive(["--print", "hi"]), false);
});
