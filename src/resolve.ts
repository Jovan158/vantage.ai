// Resolve an agent command to something Node can spawn WITHOUT a shell.
//
// On Linux/macOS, spawn() searches PATH itself, so nothing is needed. On
// Windows it only finds real executables (.exe/.com). Agents installed through
// npm — Claude Code, Codex CLI — are exposed as `claude.cmd` shims, which Node
// refuses to spawn without `shell: true`. Using a shell is not an option here:
// the agent's arguments include the user's prompt and the injected project
// memory, and cmd.exe would interpret quotes, `&`, `|`, `%` in that text.
//
// So for an npm shim we read the JS entry it points at and run that with node
// directly — the same "node + script path" pattern Claude Code's own docs give
// for running npm shims on Windows.

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

// npm's cmd-shim ends in:  "%_prog%"  "%dp0%\node_modules\pkg\cli.js" %*
// (older shims: "%~dp0\node_modules\pkg\cli.js"). Return the script path
// relative to the shim's directory, or null if this is not an npm node shim.
export function parseNpmCmdShim(content: string): string | null {
  const m = content.match(/"%~?dp0%?\\([^"]+?\.(?:js|mjs|cjs))"/i);
  return m ? m[1]! : null;
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
        const rel = parseNpmCmdShim(fs.readFileSync(full, "utf8"));
        if (!rel) {
          return {
            ok: false,
            reason: `${full} is a batch file Vantage cannot start without a shell (and a shell would interpret your prompt text)`,
          };
        }
        const script = path.join(path.dirname(full), rel);
        if (!fs.existsSync(script)) {
          return { ok: false, reason: `${full} points at ${script}, which does not exist` };
        }
        return { ok: true, resolved: { command: nodePath, prefix: [script] } };
      }
      // .ps1, .js, ...: not directly spawnable; keep looking.
    }
  }
  return { ok: false, reason: `"${command}" was not found on PATH` };
}
