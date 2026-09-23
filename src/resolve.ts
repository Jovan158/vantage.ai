// Resolve an agent command to something Node can spawn WITHOUT a shell.
//
// On Linux/macOS, spawn() searches PATH itself, so nothing is needed. On
// Windows it only finds real executables (.exe/.com). Agents installed through
// npm — Claude Code, Codex CLI — are exposed as `claude.cmd` shims, which Node
// refuses to spawn without `shell: true`. Using a shell is not an option here:
// the agent's arguments include the user's prompt and the injected project
// memory, and cmd.exe would interpret quotes, `&`, `|`, `%` in that text.
//
// So for an npm shim we read what it points at and start that directly: a
// native .exe as-is, a JS entry through node — the "node + script path" pattern
// Claude Code's own docs give for running npm shims on Windows.

import fs from "node:fs";
import path from "node:path";

export interface ResolvedCommand {
  command: string;
  /** Arguments to put before the agent's own arguments. */
  prefix: string[];
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedCommand }
  | { ok: false; reason: string };

interface ResolveOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  nodePath?: string;
}

// What an npm cmd-shim launches. npm writes one of two shapes, and the target
// is always the quoted %dp0%-relative path immediately followed by `%*`:
//   node script:  ... "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
//   native exe:   "%dp0%\node_modules\pkg\bin\claude.exe"   %*
// (older npm used %~dp0). Anchoring on `%*` matters: the node-script shape
// also mentions "%dp0%\node.exe" in an IF EXIST check, which must not be taken
// for the target. Current Claude Code (2.1.x via npm) is the native-exe shape.
export interface ShimTarget {
  kind: "node" | "exe";
  /** Path relative to the shim's own directory. */
  rel: string;
}

export function parseNpmCmdShim(content: string): ShimTarget | null {
  const m = content.match(/"%~?dp0%?\\([^"]+)"\s+%\*/i);
  if (!m) return null;
  const rel = m[1]!;
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return { kind: "node", rel };
  if (ext === ".exe" || ext === ".com") return { kind: "exe", rel };
  return null; // e.g. a python or shell script — needs an interpreter we won't guess
}

export function resolveCommand(command: string, opts: ResolveOptions = {}): ResolveResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    return { ok: true, resolved: { command, prefix: [] } };
  }

  const env = opts.env ?? process.env;
  const nodePath = opts.nodePath ?? process.execPath;
  const pathVar = env.PATH ?? env.Path ?? "";
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
  const candidates = path.extname(command) ? [command] : exts.map((e) => command + e);
  const dirs = path.isAbsolute(command) ? [""] : pathVar.split(";").filter(Boolean);

  for (const dir of dirs) {
    for (const name of candidates) {
      const full = dir ? path.join(dir, name) : name;
      if (!fs.existsSync(full)) continue;
      const ext = path.extname(full).toLowerCase();

      if (ext === ".exe" || ext === ".com") {
        return { ok: true, resolved: { command: full, prefix: [] } };
      }
      if (ext === ".cmd" || ext === ".bat") {
        const shim = parseNpmCmdShim(fs.readFileSync(full, "utf8"));
        if (!shim) {
          return {
            ok: false,
            reason: `${full} is a batch file Vantage cannot start without a shell (and a shell would interpret your prompt text)`,
          };
        }
        const target = path.join(path.dirname(full), shim.rel);
        if (!fs.existsSync(target)) {
          return { ok: false, reason: `${full} points at ${target}, which does not exist` };
        }
        return shim.kind === "exe"
          ? { ok: true, resolved: { command: target, prefix: [] } }
          : { ok: true, resolved: { command: nodePath, prefix: [target] } };
      }
      // .ps1, .js, ...: not directly spawnable; keep looking.
    }
  }
  return { ok: false, reason: `"${command}" was not found on PATH` };
}
