#!/usr/bin/env node
// Entry point with two modes:
//   - Installed package: run the compiled CLI in-process (no extra process,
//     signals and stdio pass through naturally).
//   - Dev checkout with no build: run the TypeScript source through Node's
//     type stripping, which must be enabled at startup, so a child process.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.join(here, "..", "dist", "cli.js");
const source = path.join(here, "..", "src", "cli.ts");

// The published package ships dist/ without src/, so the presence of src/ is
// exactly the signal for a dev checkout. Preferring source there keeps a stale
// dist/ from silently shadowing edits (run `node dist/cli.js` to exercise a
// build deliberately).
const hasSource = fs.existsSync(source);

if (!hasSource && fs.existsSync(built)) {
  await import(pathToFileURL(built).href);
} else {
  const { spawn } = await import("node:child_process");
  if (!hasSource) {
    process.stderr.write("vantage: no build found and no source to fall back to\n");
    process.exit(1);
  }
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", source, ...process.argv.slice(2)],
    { stdio: "inherit" }
  );
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}
