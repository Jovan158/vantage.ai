// Terminal control sequences in text from outside never reach the terminal.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plain } from "../src/sanitize.ts";
import { parseEventLines, type VantageEvent } from "../src/events.ts";
import { renderLive } from "../src/watch.ts";
import { renderTimeline } from "../src/replay.ts";
import { fmtFileLine } from "../src/commands/output.ts";
import { postAlert, takeAlerts } from "../src/outbox.ts";

const ESC = "\x1b";
const TITLE = `${ESC}]0;PWNED${"\x07"}`;
const CLIPBOARD = `${ESC}]52;c;ZWNobyBoaQ==${"\x07"}`;

test("control sequences and characters are removed, text and line breaks stay", () => {
  assert.equal(plain(`src/a${TITLE}${ESC}[2J.ts`), "src/a.ts");
  assert.equal(plain(`copy${CLIPBOARD}this`), "copythis");
  assert.equal(plain(`${ESC}[31mred${ESC}[0m and ${ESC}[8mhidden`), "red and hidden");
  assert.equal(plain(`over\rwrite\x07\x00\x7f`), "overwrite");
  assert.equal(plain("\x9b31mC1 csi, \x9d0;t\x07C1 osc"), "C1 csi, C1 osc");
  assert.equal(plain("unterminated " + `${ESC}]0;title to the end`), "unterminated ");
  assert.equal(plain("line one\nline two\tafter a tab"), "line one\nline two after a tab");
  assert.equal(plain("naïve · café — ✓"), "naïve · café — ✓");
});

const T = (s: number): string => new Date(Date.UTC(2026, 8, 25, 12, 0, s)).toISOString();
const hostile: VantageEvent[] = [
  { ts: T(0), type: "session_start", agent: "claude-code", project: `/p/repo${TITLE}`, pid: process.pid },
  { ts: T(1), type: "request" },
  {
    ts: T(2),
    type: "usage",
    path: "/v1/messages",
    model: "claude-opus-5-5",
    in: 1,
    out: 1,
    cache_read: 0,
    cache_write: 0,
    cost_usd: 0.01,
    tools: ["Read"],
    calls: [{ tool: "Read", target: `src/a${TITLE}${ESC}[2J.ts` }],
    prompt: `hi ${ESC}[31mRED`,
    text: `ok ${CLIPBOARD}`,
  },
  { ts: T(3), type: "secret", kind: "value of DB_PASSWORD", masked: "Xk9v…(12 chars)", source: `the output of Read ${TITLE}.env` },
];

test("a hostile log reaches watch and replay without a single escape character", () => {
  const read = parseEventLines(hostile.map((e) => JSON.stringify(e)).join("\n"));
  const live = renderLive(read, { sessionId: "s", color: false, width: 160 });
  const timeline = renderTimeline(read, false);
  for (const out of [live, timeline]) {
    assert.ok(!out.includes(ESC), "no ESC");
    assert.ok(!out.includes("\x07"), "no BEL");
  }
  assert.match(live, /src\/a\.ts/, "the file name is still shown, cleaned");
});

test("file names and chat alerts are cleaned too", () => {
  assert.equal(fmtFileLine({ path: `evil${TITLE}.ts`, added: 1, removed: 0 }), "  evil.ts (+1 -0)");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vantage-plain-")), "outbox.jsonl");
  postAlert(file, { level: "critical", message: `a secret from ${CLIPBOARD}Read .env` });
  assert.equal(takeAlerts(file)[0]!.message, "a secret from Read .env");
});
