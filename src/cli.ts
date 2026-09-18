// vantage — control & transparency layer over AI-coding CLI agents.
//
// MVP command surface:
//   vantage run <agent> [-- <agent args...>]   wrap a real agent, meter it live
//   vantage demo                               run the full chain against a mock
//   vantage --help
//
// The proxy/usage core is proven in spike/proxy-passthrough and ported to src/.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "./proxy.ts";
import { Meter } from "./meter.ts";
import {
  EventLog,
  newSessionId,
  sessionEventsPath,
  type UsageEvent,
} from "./events.ts";
import { resolveAdapter, knownAgents } from "./agents/index.ts";
import { startMockAnthropic } from "./dev/mock-anthropic.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function log(msg: string): void {
  process.stderr.write(`\x1b[2m[vantage]\x1b[0m ${msg}\n`);
}

function printHelp(): void {
  process.stdout.write(
    `vantage — control & transparency layer for AI-coding CLIs\n\n` +
      `Usage:\n` +
      `  vantage run <agent> [-- <agent args...>]\n` +
      `  vantage demo\n` +
      `  vantage --help\n\n` +
      `Agents: ${knownAgents().join(", ")}\n`
  );
}

async function cmdRun(argv: string[]): Promise<number> {
  const agentName = argv[0];
  if (!agentName) {
    log("missing agent name. try: vantage run claude");
    return 1;
  }
  const adapter = resolveAdapter(agentName);
  if (!adapter) {
    log(`unknown agent "${agentName}". known: ${knownAgents().join(", ")}`);
    return 1;
  }

  // Everything after "--" (or after the agent name) is passed to the agent.
  const sep = argv.indexOf("--");
  const agentArgs = sep === -1 ? argv.slice(1) : argv.slice(sep + 1);

  const upstream = process.env.VANTAGE_UPSTREAM ?? adapter.defaultUpstream;
  const cwd = process.cwd();
  const sessionId = newSessionId();
  const eventLog = new EventLog(sessionEventsPath(cwd, sessionId));
  const meter = new Meter();

  eventLog.append({ ts: new Date().toISOString(), type: "session_start", agent: adapter.id });

  const proxy = await startProxy({
    upstream,
    onUsage: (e: UsageEvent) => {
      eventLog.append(e);
      meter.add(e);
      log(meter.statusLine());
    },
  });

  log(`session ${sessionId} · agent ${adapter.id} · upstream ${upstream} (${proxy.via})`);
  log(`proxy ${proxy.url} → ${adapter.command} ${agentArgs.join(" ")}`.trimEnd());

  const child = spawn(adapter.command, agentArgs, {
    stdio: "inherit",
    env: { ...process.env, ...adapter.proxyEnv(proxy.url) },
  });

  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));

  return await new Promise<number>((resolve) => {
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        log(`could not launch "${adapter.command}" — is it installed and on PATH?`);
      } else {
        log(`failed to launch agent: ${err.message}`);
      }
      void proxy.close().then(() => resolve(127));
    });
    child.on("exit", async (code) => {
      eventLog.append({ ts: new Date().toISOString(), type: "session_end", exitCode: code });
      const t = meter.snapshot();
      log(
        `session end · ${t.requests} request(s) · in ${t.input} · out ${t.output} · ` +
          `cache ${t.cacheRead} · ~$${t.costUsd.toFixed(4)} (est.)`
      );
      log(`event log: ${eventLog.filePath}`);
      await proxy.close();
      resolve(code ?? 0);
    });
  });
}

async function cmdDemo(): Promise<number> {
  log("demo: proving the full chain against a mock upstream (no API key needed)");
  const mock = await startMockAnthropic();
  const meter = new Meter();

  const proxy = await startProxy({
    upstream: mock.url,
    onUsage: (e: UsageEvent) => {
      meter.add(e);
      log(meter.statusLine());
    },
  });

  const fakeAgent = path.join(HERE, "..", "examples", "fake-agent.mjs");
  log(`upstream(mock) ${mock.url} · proxy ${proxy.url} · agent ${path.basename(fakeAgent)}`);

  const child = spawn(process.execPath, [fakeAgent], {
    stdio: "inherit",
    env: { ...process.env, ANTHROPIC_BASE_URL: proxy.url },
  });

  return await new Promise<number>((resolve) => {
    child.on("exit", async (code) => {
      const t = meter.snapshot();
      log(
        `demo end · in ${t.input} · out ${t.output} · cache ${t.cacheRead} · ` +
          `~$${t.costUsd.toFixed(4)} (est.)`
      );
      await proxy.close();
      await mock.close();
      resolve(code ?? 0);
    });
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      process.exit(await cmdRun(rest));
      break;
    case "demo":
      process.exit(await cmdDemo());
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printHelp();
      process.exit(0);
      break;
    default:
      log(`unknown command "${cmd}"`);
      printHelp();
      process.exit(1);
  }
}

void main();
