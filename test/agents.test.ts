// The other agents: their hook dialects, their routes through the proxy, the
// Codex WebSocket, the hooks set up once — each against the real contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hookProtocol, registerActive, findActiveConfig, writeHookConfig } from "../src/agents/hooks.ts";
import { codexHookHash, codexHookKey, codexHooksToml } from "../src/agents/codex.ts";
import { matchRoute, startProxy } from "../src/proxy.ts";
import { WsReader, wsFrame } from "../src/ws.ts";
import { extractRateLimit, rateLimitFromEvent } from "../src/ratelimit.ts";
import { startMockLlm } from "../src/dev/mock-llm.ts";
import { classifyTool } from "../src/policy.ts";
import { matchRules, rulesFrom } from "../src/rules.ts";
import { commandText } from "../src/turn.ts";
import { hookCommandLine, hookInvocation, shellQuote } from "../src/hook.ts";
import type { UsageEvent } from "../src/events.ts";
import type { RateLimitSnapshot } from "../src/ratelimit.ts";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const tmp = (p: string): string => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---------------------------------------------------------------------------
// Hook dialects

const answer = { decision: "deny" as const, reason: "no", alerts: "" };

test("Claude's dialect, which Codex, Copilot, OpenCode and pi share", () => {
  const p = hookProtocol("claude");
  const call = p.parse(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/r" }))!;
  assert.deepEqual(call, { event: "tool", tool: "Bash", input: { command: "ls" }, dirs: ["/r"] });
  assert.deepEqual(JSON.parse(p.reply(call, answer).stdout).hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" });
  // No decision and no alerts: nothing at all, so the agent's own flow runs.
  assert.equal(p.reply(call, { decision: null, reason: "", alerts: "" }).stdout, "");
  const stop = p.parse(JSON.stringify({ hook_event_name: "Stop" }))!;
  assert.deepEqual(JSON.parse(p.reply(stop, { decision: null, reason: "", alerts: "Vantage: hi" }).stdout), { systemMessage: "Vantage: hi" });
  const start = p.parse(JSON.stringify({ hook_event_name: "SessionStart" }))!;
  assert.equal(JSON.parse(p.reply(start, { decision: null, reason: "", alerts: "", context: "memo" }).stdout).hookSpecificOutput.additionalContext, "memo");
  // Codex cannot ask; Copilot also reads the decision at the top level.
  assert.equal(hookProtocol("codex").ask, "none");
  assert.equal(JSON.parse(hookProtocol("copilot").reply(call, answer).stdout).permissionDecision, "deny");
  // Copilot shows messages as progress lines in its timeline.
  assert.equal(hookProtocol("copilot").reply(stop, { decision: null, reason: "", alerts: "Vantage: a\nVantage: b" }).stdout, '{"type":"progress","message":"Vantage: a"}\n{"type":"progress","message":"Vantage: b"}');
});

test("Gemini CLI: BeforeTool gets decision and reason, AfterAgent shows alerts", () => {
  const p = hookProtocol("gemini");
  const call = p.parse(JSON.stringify({ hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "rm -rf x" }, cwd: "/r" }))!;
  assert.equal(call.tool, "run_shell_command");
  const ask = JSON.parse(p.reply(call, { decision: "ask", reason: "check", alerts: "" }).stdout);
  assert.deepEqual(ask, { decision: "ask", reason: "check", systemMessage: "check" });
  const after = p.parse(JSON.stringify({ hook_event_name: "AfterAgent", prompt: "x" }))!;
  assert.equal(after.event, "stop");
});

test("Cursor, Hermes and Antigravity each answer in their own words", () => {
  const cursor = hookProtocol("cursor");
  const c = cursor.parse(JSON.stringify({ hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: "ls" }, workspace_roots: ["/w"] }))!;
  assert.deepEqual(c.dirs, ["/w"]);
  assert.deepEqual(JSON.parse(cursor.reply(c, { decision: "ask", reason: "r", alerts: "" }).stdout), { permission: "ask", user_message: "r", agent_message: "r" });
  const legacy = cursor.parse(JSON.stringify({ hook_event_name: "beforeShellExecution", command: "npm publish", cwd: "/w" }))!;
  assert.deepEqual([legacy.tool, legacy.input], ["Shell", { command: "npm publish" }]);

  const hermes = hookProtocol("hermes");
  const h = hermes.parse(JSON.stringify({ hook_event_name: "pre_tool_call", tool_name: "terminal", tool_input: { command: "ls" }, cwd: "/w" }))!;
  assert.deepEqual(JSON.parse(hermes.reply(h, answer).stdout), { decision: "block", reason: "no" });
  assert.deepEqual(JSON.parse(hermes.reply(h, { decision: "ask", reason: "r", alerts: "" }).stdout), { action: "approve", message: "r" });

  const agy = hookProtocol("antigravity");
  const a = agy.parse(JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "ls" } } }))!;
  assert.equal(a.tool, "run_command");
  assert.deepEqual(JSON.parse(agy.reply(a, answer).stdout), { decision: "deny", reason: "no" });
  assert.equal(agy.reply(a, { decision: null, reason: "", alerts: "" }).stdout, "");
});

test("other agents' tool names get the right action type", () => {
  const cases: Array<[string, string]> = [
    ["run_shell_command", "shell"],
    ["read_file", "read"],
    ["replace", "write"],
    ["write_file", "write"],
    ["google_web_search", "network"],
    ["apply_patch", "write"],
    ["terminal", "shell"],
    ["mcp__terminal", "shell"], // Hermes, to Claude models
    ["mcp__github__create_issue", "network"],
    ["ls", "read"],
    ["webfetch", "network"],
  ];
  for (const [tool, type] of cases) assert.equal(classifyTool(tool), type, tool);
});

test("rules see through other agents' input shapes", () => {
  const rules = rulesFrom({ files: { ".env": "deny" }, commands: { "git push*": "ask" } });
  // OpenCode names the file filePath; Codex runs commands as argv.
  assert.equal(matchRules({ filePath: "/p/.env" }, rules, "/p")?.level, "deny");
  assert.equal(matchRules({ command: ["bash", "-lc", "git push origin main"] }, rules, "/p")?.level, "ask");
  assert.equal(matchRules({ cmd: "git push -f" }, rules, "/p")?.level, "ask");
  // A patch names its files in its headers.
  assert.equal(matchRules({ command: "*** Begin Patch\n*** Update File: .env\n@@\n-a\n+b\n*** End Patch" }, rules, "/p")?.level, "deny");
  assert.equal(commandText(["zsh", "-c", "echo hi"]), "echo hi");
  assert.equal(commandText(["git", "status"]), "git status");
});

test("a hook command line survives the shell it runs in", () => {
  const line = hookCommandLine(hookInvocation("/opt/node/bin/node", "/home/a b/cli.js", ["codex", "/s/it's.json"]), "linux");
  assert.equal(line, "/opt/node/bin/node '/home/a b/cli.js' hook codex '/s/it'\\''s.json'");
  // PowerShell takes a quoted path as a string, so node is started by name.
  assert.equal(hookCommandLine(hookInvocation("C:\\Program Files\\nodejs\\node.exe", "C:\\npm\\cli.js", ["gemini"]), "win32"), "node C:\\npm\\cli.js hook gemini");
  assert.equal(shellQuote("C:\\Users\\A B\\cli.js", "win32"), '"C:\\Users\\A B\\cli.js"');
});

// ---------------------------------------------------------------------------
// Codex

test("Codex hook trust: the hash Codex computes for Vantage's hooks", () => {
  // Verified against codex-cli 0.157: with these hashes it ran the hooks
  // without --dangerously-bypass-hook-trust.
  const cmd = "node /x/cli.js hook codex /s/hook-config.json";
  assert.equal(codexHookHash("PreToolUse", cmd, "*"), "sha256:98340c1ba16669afa5b41f7c44914ee0faabea030f017d6fc985aef66cf55777");
  assert.equal(codexHookHash("Stop", cmd), "sha256:43fd44b596240094cedf296f4973dfd534c64861a80233708f2172e80770ca13");
  assert.equal(codexHookKey("PreToolUse", "linux"), "/<session-flags>/config.toml:pre_tool_use:0:0");
  const toml = codexHooksToml(cmd, ["PreToolUse", "Stop"], "linux");
  assert.match(toml, /^\{PreToolUse=\[\{matcher="\*", hooks=\[\{type="command", command="node \/x\/cli\.js hook codex \/s\/hook-config\.json", timeout=600\}\]\}\], Stop=/);
  assert.match(toml, /state=\{"\/<session-flags>\/config\.toml:pre_tool_use:0:0"=\{trusted_hash="sha256:98340c1b/);
});

test("Codex usage limits: headers and the WebSocket event give the same windows", () => {
  const now = Math.floor(Date.now() / 1000);
  const h = extractRateLimit({
    "x-codex-primary-used-percent": "42.5",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": String(now + 600),
    "x-codex-secondary-used-percent": "100",
    "x-codex-secondary-window-minutes": "10080",
  })!;
  assert.deepEqual(
    h.unified!.windows.map((w) => [w.key, w.utilization, w.status]),
    [
      ["5h", 0.425, null],
      ["7d", 1, "rejected"],
    ]
  );
  const e = rateLimitFromEvent({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 10, window_minutes: 300, reset_at: now } } })!;
  assert.equal(e.unified!.windows[0]!.key, "5h");
  assert.equal(e.raw["x-codex-primary-used-percent"], "10", "logged under the header names, so the log reads back the same");
  assert.equal(rateLimitFromEvent({ type: "response.completed" }), null);
});

test("WebSocket frames are read however the bytes arrive", () => {
  const got: string[] = [];
  const r = new WsReader((t) => got.push(t));
  const big = "x".repeat(70_000);
  const bytes = Buffer.concat([wsFrame('{"a":1}', true), wsFrame(big, false), wsFrame("é".repeat(200), true)]);
  for (let i = 0; i < bytes.length; i += 1000) r.feed(bytes.subarray(i, i + 1000));
  assert.deepEqual(got, ['{"a":1}', big, "é".repeat(200)]);
  // A fragmented message: first frame without FIN, then a continuation.
  const got2: string[] = [];
  const r2 = new WsReader((t) => got2.push(t));
  const first = wsFrame("hel", false);
  first[0] = 0x01; // text, not final
  const cont = wsFrame("lo", false);
  cont[0] = 0x80; // continuation, final
  r2.feed(Buffer.concat([first, cont]));
  assert.deepEqual(got2, ["hello"]);
});

// ---------------------------------------------------------------------------
// The proxy with routes

test("routes: the longest prefix wins, the default route takes the rest", () => {
  const routes = [
    { prefix: "", upstream: "https://a" },
    { prefix: "/h/api.x.ai", upstream: "https://api.x.ai" },
    { prefix: "/codex", upstream: "https://c" },
  ];
  assert.deepEqual(matchRoute(routes, "/h/api.x.ai/v1/chat/completions")?.rest, "/v1/chat/completions");
  assert.equal(matchRoute(routes, "/codexy/x")?.route.upstream, "https://a");
  assert.equal(matchRoute(routes, "/codex?x=1")?.rest, "?x=1");
});

function wsClient(url: string, path: string): Promise<{ send(o: object): void; messages: string[]; close(): void }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), "Sec-WebSocket-Version": "13", "Sec-WebSocket-Extensions": "permessage-deflate" } });
    req.on("upgrade", (_res, socket: net.Socket, head) => {
      const messages: string[] = [];
      const reader = new WsReader((t) => messages.push(t));
      if (head.length) reader.feed(head);
      socket.on("data", (d: Buffer) => reader.feed(d));
      resolve({ send: (o) => socket.write(wsFrame(JSON.stringify(o), true)), messages, close: () => socket.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
};

test("Codex over a WebSocket: every turn metered, limits read, bytes untouched", async () => {
  const mock = await startMockLlm({ command: "echo hi" });
  const usage: UsageEvent[] = [];
  const limits: RateLimitSnapshot[] = [];
  const phases: string[] = [];
  const proxy = await startProxy({
    routes: [{ prefix: "/codex", upstream: (h) => (h["chatgpt-account-id"] ? "http://unused.invalid" : `${mock.url}/v1`) }],
    agentName: "Codex",
    onUsage: (e) => usage.push(e),
    onRateLimit: (s) => limits.push(s),
    onExchange: (p) => phases.push(p),
  });
  try {
    const ws = await wsClient(proxy.url, "/codex/responses");
    ws.send({ type: "response.create", model: "gpt-5.5", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }], tools: [{ type: "function", name: "exec_command", parameters: { properties: { cmd: { type: "string" } } } }] });
    await until(() => usage.length === 1);
    ws.send({ type: "response.create", previous_response_id: "r1", input: [{ type: "function_call_output", call_id: "c", output: "hi" }] });
    await until(() => usage.length === 2);
    ws.close();
    assert.equal(mock.requests.filter((r) => r.websocket).length, 2, "both requests reached the upstream");
    assert.equal(mock.requests[0]!.headers["sec-websocket-extensions"], undefined, "no compression asked for, so frames can be read");
    assert.deepEqual(usage.map((u) => [u.path, u.in, u.cache_read, u.out, u.prompt ?? null, u.tools ?? null]), [
      ["/v1/responses", 200, 100, 40, "go", ["exec_command"]],
      ["/v1/responses", 200, 100, 40, null, null],
    ]);
    assert.ok(ws.messages.some((m) => m.includes('"response.completed"')), "the client got the events");
    assert.ok(limits.some((l) => l.unified?.windows.some((w) => w.key === "5h")), "limits from the handshake and the event");
    await until(() => phases.filter((p) => p === "end").length === 2);
    assert.deepEqual(phases, ["start", "end", "start", "end"]);
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test("one proxy, several providers: each route reaches its own upstream and format", async () => {
  const mock = await startMockLlm({ command: "ls" });
  const usage: UsageEvent[] = [];
  const proxy = await startProxy({
    routes: [
      { prefix: "/openai", upstream: `${mock.url}/v1` },
      { prefix: "/gemini", upstream: `${mock.url}/v1beta` },
    ],
    onUsage: (e) => usage.push(e),
  });
  const post = (p: string, body: object): Promise<string> =>
    fetch(proxy.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.text());
  try {
    await post("/openai/chat/completions", { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "bash", parameters: { properties: { command: { type: "string" } } } } }] });
    await post("/gemini/models/gemini-3-pro:streamGenerateContent?alt=sse", { contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ functionDeclarations: [{ name: "run_shell_command", parameters: { properties: { command: { type: "string" } } } }] }] });
    await until(() => usage.length === 2);
    assert.deepEqual(mock.requests.map((r) => r.path), ["/v1/chat/completions", "/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse"]);
    assert.deepEqual(usage.map((u) => [u.path, u.model, u.calls?.[0]?.tool, u.calls?.[0]?.target]), [
      ["/v1/chat/completions", "gpt-5.5-mini", "bash", "ls"],
      ["/v1beta/models/gemini-3-pro:streamGenerateContent", "gemini-3-pro", "run_shell_command", "ls"],
    ]);
    const miss = await fetch(proxy.url + "/nowhere", { method: "POST" });
    assert.equal(miss.status, 404, "no default route: no guessing where it should go");
  } finally {
    await proxy.close();
    await mock.close();
  }
});

// ---------------------------------------------------------------------------
// The hook as agents start it

function runHook(args: string[], payload: object, env: Record<string, string> = {}): { status: number | null; stdout: string } {
  const inv = hookInvocation(process.execPath, ENTRY, args);
  const r = spawnSync(inv.command, inv.args, { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, VANTAGE_POLICY: "", VANTAGE_HOOK_CONFIG: "", VANTAGE_HOOK_AGENT: "", ...env } });
  return { status: r.status, stdout: r.stdout };
}

test("Codex: an ask rule blocks, and says the user has to do it", () => {
  const dir = tmp("vantage-hook-");
  const cfg = path.join(dir, "hook-config.json");
  writeHookConfig(cfg, { VANTAGE_POLICY: "shell:ask", VANTAGE_POLICY_FILE: path.join(dir, "none.json") });
  const r = runHook(["codex", cfg], { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, cwd: dir });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /cannot pause to ask/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a hook set up once stays out of the way outside a session, and finds the one running", () => {
  const home = tmp("vantage-home-");
  const project = tmp("vantage-proj-");
  const env = { VANTAGE_HOME: home };
  const call = { hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: "rm -rf build" }, workspace_roots: [project] };
  // No session: an empty answer, whatever the policy would say.
  assert.equal(runHook(["cursor"], call, { ...env, VANTAGE_POLICY: "shell:deny" }).stdout, "");
  const cfg = path.join(project, "hook-config.json");
  writeHookConfig(cfg, { VANTAGE_POLICY: "shell:deny", VANTAGE_POLICY_FILE: path.join(project, "none.json") });
  process.env.VANTAGE_HOME = home;
  const unregister = registerActive("cursor", [project], cfg);
  try {
    assert.equal(findActiveConfig("cursor", [path.join(project, "src")]), cfg, "found from a subdirectory too");
    assert.equal(JSON.parse(runHook(["cursor"], call, env).stdout).permission, "deny");
    // The environment counts only for the agent it was set for.
    assert.equal(runHook(["gemini"], { hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "ls" } }, { ...env, VANTAGE_HOOK_CONFIG: cfg, VANTAGE_HOOK_AGENT: "cursor" }).stdout, "");
  } finally {
    unregister();
    delete process.env.VANTAGE_HOME;
  }
  assert.equal(findActiveConfig("cursor", [project]), null, "gone once the session ends");
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});
