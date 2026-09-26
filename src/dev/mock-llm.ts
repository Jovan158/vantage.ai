// A stand-in for the model APIs the agents talk to — Anthropic Messages,
// OpenAI Responses (HTTP and WebSocket), Chat Completions and Gemini — for
// tests that run the real agent CLIs through Vantage with no account and no
// network. Each conversation goes the same way: the first reply calls the
// agent's shell tool with the command given, the next one says "done".
//
// The shell tool is found in the request's own tool list, and its arguments
// follow that tool's schema, so the same mock drives every agent.

import http from "node:http";
import crypto from "node:crypto";
import type net from "node:net";
import type { AddressInfo } from "node:net";
import { WsReader, wsFrame } from "../ws.ts";

export interface MockOptions {
  /** The shell command the first reply asks to run. */
  command: string;
  /** Text of the final reply. */
  reply?: string;
}

export interface MockRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  websocket?: boolean;
}

export interface RunningMockLlm {
  url: string;
  port: number;
  requests: MockRequest[];
  close(): Promise<void>;
}

type Tool = { name: string; params: Record<string, unknown> };

const SHELL = /^(?:mcp__)?(bash|shell|exec_command|run_shell_command|terminal|execute_command|run_command|run_in_terminal|powershell)$/i;

// The tools a request offers, from any of the formats' tool lists (Codex
// sends them as an "additional_tools" input item, grouped in namespaces).
function toolsOf(body: Record<string, unknown>): Tool[] {
  const out: Tool[] = [];
  const req = (body.request as Record<string, unknown>) ?? body;
  const lists: unknown[][] = [(req.tools as unknown[]) ?? []];
  for (const item of Array.isArray(req.input) ? (req.input as Array<Record<string, unknown>>) : []) {
    if (item?.type === "additional_tools" && Array.isArray(item.tools)) lists.push(item.tools as unknown[]);
  }
  const all: unknown[] = [];
  for (const list of lists) {
    for (const t of list) {
      const o = t as Record<string, unknown>;
      if (o?.type === "namespace" && Array.isArray(o.tools)) all.push(...(o.tools as unknown[]));
      else all.push(t);
    }
  }
  for (const t of all) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    if (Array.isArray(o.functionDeclarations)) {
      for (const f of o.functionDeclarations as Array<Record<string, unknown>>) {
        out.push({ name: String(f.name), params: (f.parameters ?? f.parametersJsonSchema ?? {}) as Record<string, unknown> });
      }
    } else if (o.function && typeof o.function === "object") {
      const f = o.function as Record<string, unknown>;
      out.push({ name: String(f.name), params: (f.parameters ?? {}) as Record<string, unknown> });
    } else if (typeof o.name === "string") {
      out.push({ name: o.name, params: (o.input_schema ?? o.parameters ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

// Arguments for the shell tool, shaped by its schema.
function shellArgs(tool: Tool, command: string): Record<string, unknown> {
  const props = (tool.params.properties ?? {}) as Record<string, { type?: string | string[] }>;
  if (props.cmd) return { cmd: command };
  const type = props.command?.type;
  if (type === "array" || (Array.isArray(type) && type.includes("array"))) return { command: ["bash", "-lc", command] };
  const args: Record<string, unknown> = { command };
  if (props.description) args.description = "run a command";
  if (props.timeout && (tool.params.required as string[] | undefined)?.includes("timeout")) args.timeout = 30000;
  return args;
}

// Has the agent already sent back a tool result in this conversation?
function hasToolResult(body: unknown): boolean {
  const s = JSON.stringify(body);
  return /"tool_result"|"function_call_output"|"functionResponse"|"role":"tool"|"custom_tool_call_output"/.test(s);
}

interface Plan {
  call: { name: string; args: Record<string, unknown> } | null;
  /** A free-form call (Codex's code mode: JavaScript for its "exec" tool). */
  custom?: { name: string; input: string };
  text: string;
}

function plan(body: unknown, opts: MockOptions, known: Tool[] = []): Plan {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const offered = toolsOf(b);
  const tools = offered.length ? offered : known;
  if (!hasToolResult(body)) {
    const shell = tools.find((t) => SHELL.test(t.name));
    if (shell) return { call: { name: shell.name, args: shellArgs(shell, opts.command) }, text: "" };
    // Codex in code mode: tools are called from JavaScript.
    if (tools.some((t) => t.name === "exec")) {
      return { call: null, custom: { name: "exec", input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(opts.command)} });\ntext(JSON.stringify(r));` }, text: "" };
    }
  }
  return { call: null, text: opts.reply ?? "done" };
}

const sse = (events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

function anthropicSse(p: Plan): string {
  const f: string[] = [];
  const push = (type: string, data: object): void => void f.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  push("message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  if (p.call) {
    push("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_mock", name: p.call.name, input: {} } });
    push("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(p.call.args) } });
  } else {
    push("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    push("content_block_delta", { index: 0, delta: { type: "text_delta", text: p.text } });
  }
  push("content_block_stop", { index: 0 });
  push("message_delta", { delta: { stop_reason: p.call ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } });
  push("message_stop", {});
  return f.join("");
}

function responsesEvents(p: Plan, id = crypto.randomUUID()): object[] {
  const response = { id: `resp_${id}`, object: "response", model: "gpt-5.5", status: "in_progress", output: [] as object[] };
  const items: object[] = p.custom
    ? [{ type: "custom_tool_call", id: `ctc_${id}`, call_id: `call_${id}`, name: p.custom.name, input: p.custom.input, status: "completed" }]
    : p.call
    ? [{ type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: p.call.name, arguments: JSON.stringify(p.call.args), status: "completed" }]
    : [{ type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: p.text, annotations: [] }] }];
  const events: object[] = [{ type: "response.created", response }];
  items.forEach((item, i) => {
    events.push({ type: "response.output_item.added", output_index: i, item });
    if (!p.call && !p.custom) events.push({ type: "response.output_text.delta", output_index: i, content_index: 0, item_id: `msg_${id}`, delta: p.text });
    events.push({ type: "response.output_item.done", output_index: i, item });
  });
  events.push({
    type: "response.completed",
    response: { ...response, status: "completed", output: items, usage: { input_tokens: 300, input_tokens_details: { cached_tokens: 100 }, output_tokens: 40, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 340 } },
  });
  return events;
}

function chatSse(p: Plan): string {
  const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", model: "gpt-5.5-mini" };
  const events: object[] = [{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }];
  if (p.call) {
    events.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_mock", type: "function", function: { name: p.call.name, arguments: JSON.stringify(p.call.args) } }] } }] });
  } else {
    events.push({ ...base, choices: [{ index: 0, delta: { content: p.text } }] });
  }
  events.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: p.call ? "tool_calls" : "stop" }] });
  events.push({ ...base, choices: [], usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230, prompt_tokens_details: { cached_tokens: 50 } } });
  return sse(events) + "data: [DONE]\n\n";
}

function geminiChunks(p: Plan, wrap: boolean): object[] {
  const parts = p.call ? [{ functionCall: { name: p.call.name, args: p.call.args } }] : [{ text: p.text }];
  const r = {
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 25, cachedContentTokenCount: 100, thoughtsTokenCount: 5, totalTokenCount: 430 },
    modelVersion: "gemini-3-pro",
    responseId: "mock",
  };
  return [wrap ? { response: r } : r];
}

const RATE_LIMIT_HEADERS = {
  "x-codex-primary-used-percent": "42",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
  "x-codex-secondary-used-percent": "7",
  "x-codex-secondary-window-minutes": "10080",
};

export function startMockLlm(opts: MockOptions): Promise<RunningMockLlm> {
  const requests: MockRequest[] = [];
  const sockets = new Set<net.Socket>();

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
      } catch {
        /* not JSON */
      }
      const path = req.url ?? "/";
      requests.push({ method: req.method ?? "GET", path, headers: req.headers, body });
      const p = path.split("?")[0]!;
      const stream = (text: string, extra: Record<string, string> = {}): void => {
        res.writeHead(200, { "content-type": "text/event-stream", ...extra });
        res.end(text);
      };
      if (req.method === "POST" && /\/messages$/.test(p)) return stream(anthropicSse(plan(body, opts)));
      if (req.method === "POST" && /\/responses$/.test(p)) return stream(sse(responsesEvents(plan(body, opts))), RATE_LIMIT_HEADERS);
      if (req.method === "POST" && /\/chat\/completions$/.test(p)) return stream(chatSse(plan(body, opts)));
      if (req.method === "POST" && /:streamGenerateContent$/.test(p)) return stream(sse(geminiChunks(plan(body, opts), p.includes("v1internal"))));
      if (req.method === "POST" && /:generateContent$/.test(p)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(geminiChunks(plan(body, opts), p.includes("v1internal"))[0]));
      }
      if (/\/models$/.test(p)) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [], models: [] }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `mock: no ${req.method} ${p}` } }));
    });
  });

  // Responses over a WebSocket, as Codex uses it.
  server.on("upgrade", (req, socket: net.Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    const headers = ["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`];
    for (const [k, v] of Object.entries(RATE_LIMIT_HEADERS)) headers.push(`${k}: ${v}`);
    socket.write(headers.join("\r\n") + "\r\n\r\n");
    // Tools come with the first request of a connection; later ones continue
    // from its response.
    let tools: Tool[] = [];
    const reader = new WsReader((text) => {
      const msg = JSON.parse(text) as { type?: string };
      const offered = toolsOf(msg as Record<string, unknown>);
      if (offered.length) tools = offered;
      requests.push({ method: "WS", path: req.url ?? "/", headers: req.headers, body: msg, websocket: true });
      if (msg.type !== "response.create") return;
      // A warm-up: Codex opens the connection before the first prompt.
      if ((msg as { generate?: boolean }).generate === false) {
        const id = crypto.randomUUID();
        socket.write(wsFrame(JSON.stringify({ type: "response.created", response: { id: `resp_${id}`, model: "gpt-5.5", status: "in_progress", output: [] } }), false));
        socket.write(wsFrame(JSON.stringify({ type: "response.completed", response: { id: `resp_${id}`, model: "gpt-5.5", status: "completed", output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } }), false));
        return;
      }
      socket.write(wsFrame(JSON.stringify({ type: "codex.rate_limits", rate_limits: { primary: { used_percent: 43, window_minutes: 300, reset_at: Math.floor(Date.now() / 1000) + 3500 } } }), false));
      for (const e of responsesEvents(plan(msg, opts, tools))) socket.write(wsFrame(JSON.stringify(e), false));
    });
    socket.on("data", (d: Buffer) => reader.feed(d));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        requests,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}
