// Secret detection in requests. Test secrets are assembled at run time so
// this file itself never contains a string that looks like a real token.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { scanText, scanRequest, type SecretFinding } from "../src/secrets.ts";
import { startMockAnthropic } from "../src/dev/mock-anthropic.ts";
import { startProxy } from "../src/proxy.ts";

const j = (...parts: string[]): string => parts.join("");
const AWS = j("AKIA", "IOSFODNN7", "EXAMPLE");
const GITHUB = j("gh", "p_", "a1B2c3D4".repeat(5));
const ANTHROPIC = j("sk-", "ant-", "api03-", "x".repeat(30));
const PEM = j("-----BEGIN ", "RSA PRIVATE KEY-----");

test("known key formats are recognized; the value is never kept", () => {
  const kinds = (text: string) => scanText(text, "s").map((f) => f.kind);
  assert.deepEqual(kinds(`key: ${AWS}`), ["AWS access key"]);
  assert.deepEqual(kinds(`token ${GITHUB}`), ["GitHub token"]);
  assert.deepEqual(kinds(ANTHROPIC), ["Anthropic API key"]);
  assert.deepEqual(kinds(`${PEM}\nMIIEow...`), ["private key"]);
  const f = scanText(`x ${AWS}`, "s")[0]!;
  assert.equal(f.masked, "AKIA…(20 chars)");
  assert.ok(!JSON.stringify(f).includes(AWS.slice(4)), "only the masked prefix is kept");
});

test(".env-style assignments, also in Read's numbered output", () => {
  const found = scanText(j("     1\tAPP_NAME=demo\n     2\tDB_PASS", "WORD=hunter2hunter2\nexport GH_TOKEN=abcd1234efgh\n"), "s");
  assert.deepEqual(found.map((f) => f.kind), ["value of DB_PASSWORD", "value of GH_TOKEN"]);
  assert.equal(found[0]!.masked, "hunt…(14 chars)");
});

test("a UTF-16 file (PowerShell's Out-File) is read like any other", () => {
  // What Claude Code's Read sends for such a file: the bytes taken as UTF-8.
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(j("DB_PASS", "WORD=Xk9vQ2mLp7Rt\r\n"), "utf16le")]).toString("utf8");
  const found = scanText(`     1\t${utf16}`, "s");
  assert.deepEqual(found.map((f) => f.kind), ["value of DB_PASSWORD"]);
  assert.equal(found[0]!.masked, "Xk9v…(12 chars)");
  assert.equal(found[0]!.fingerprint, scanText(j("DB_PASS", "WORD=Xk9vQ2mLp7Rt"), "s")[0]!.fingerprint, "the same secret as in UTF-8");
});

test("a key matched by its format and as KEY=value is reported once, by format", () => {
  const found = scanText(`AWS_ACCESS_KEY_ID=${AWS}\n`, "s");
  assert.deepEqual(found.map((f) => f.kind), ["AWS access key"]);
});

test("code and placeholders are not secrets", () => {
  const code = [
    "const token = getToken();",
    "password: string;",
    "API_KEY=${API_KEY}",
    "export TOKEN=$(cat token.txt)",
    "SECRET_KEY=changeme",
    "DB_PASSWORD=your-password-here",
    "AUTH_TOKEN=<token>",
    "sk-ant-short",
  ].join("\n");
  assert.deepEqual(scanText(code, "s"), []);
});

test("each finding says where it came from", () => {
  const body = {
    system: [{ type: "text", text: `Project notes: deploy key ${AWS}` }],
    messages: [
      { role: "user", content: `please use ${GITHUB}` },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p/.env" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: j("1\tDB_PASS", "WORD=s3cr3tpassw0rd") }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "/p/k.pem", content: `${PEM}\nabc` } }] },
    ],
  };
  const where = scanRequest(body).map((f: SecretFinding) => `${f.kind} <- ${f.source}`);
  assert.deepEqual(where, [
    "AWS access key <- the system prompt (CLAUDE.md, memory)",
    "GitHub token <- your message",
    "value of DB_PASSWORD <- the output of Read /p/.env",
    "private key <- Claude's Write /p/k.pem call",
  ]);
});

test("history already scanned is skipped; a new tool result still names its call", () => {
  const seen = new Set<string>();
  const first = {
    messages: [
      { role: "user", content: `please use ${GITHUB}` },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/p/.env" } }] },
    ],
  };
  assert.deepEqual(scanRequest(first, seen).map((f) => f.kind), ["GitHub token"]);
  const second = {
    messages: [
      ...first.messages,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `AWS=${AWS}` }] },
    ],
  };
  const where = scanRequest(second, seen).map((f: SecretFinding) => `${f.kind} <- ${f.source}`);
  assert.deepEqual(where, ["AWS access key <- the output of Read /p/.env"]);
  assert.deepEqual(scanRequest(second, seen), []);
});

test("the proxy reports findings with each request, and still forwards it unchanged", async () => {
  const mock = await startMockAnthropic();
  const seen: SecretFinding[] = [];
  const proxy = await startProxy({ upstream: mock.url, onRequest: (info) => seen.push(...info.secrets) });
  const body = JSON.stringify({ model: "claude-sonnet-5", stream: true, tools: [{ name: "Read" }], messages: [{ role: "user", content: `deploy with ${AWS}` }] });
  await new Promise<void>((resolve, reject) => {
    const req = http.request(proxy.url + "/v1/messages", { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.resume();
      res.on("end", () => resolve());
    });
    req.on("error", reject);
    req.end(body);
  });
  assert.deepEqual(seen.map((f) => [f.kind, f.source]), [["AWS access key", "your message"]]);
  await proxy.close();
  await mock.close();
});
