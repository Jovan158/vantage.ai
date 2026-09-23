// `vantage demo`: the whole chain against a mock upstream, no API key needed.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startProxy } from "../proxy.ts";
import { Meter } from "../meter.ts";
import type { UsageEvent } from "../events.ts";
import { startMockAnthropic } from "../dev/mock-anthropic.ts";
import { formatCost } from "../pricing.ts";
import { log } from "./output.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function cmdDemo(): Promise<number> {
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

  const fakeAgent = path.join(HERE, "..", "..", "examples", "fake-agent.mjs");
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
          formatCost(t.costUsd, t.unpriced, t.requests)
      );
      await proxy.close();
      await mock.close();
      resolve(code ?? 0);
    });
  });
}
