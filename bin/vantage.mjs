#!/usr/bin/env node
// Launcher: runs the TypeScript CLI via Node's built-in type stripping so the
// tool works from a checkout with zero build step. A compiled `dist/` build
// (npm run build) is the distribution path once TypeScript is installed.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "src", "cli.ts");

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", cli, ...process.argv.slice(2)],
  { stdio: "inherit" }
);
child.on("exit", (code) => process.exit(code ?? 0));
