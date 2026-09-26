// Rules for specific files and commands — finer than the action-type levels.
//
//   .vantage/policy.json
//   {
//     "shell": "ask",
//     "files":    { ".env*": "deny", "*.pem": "deny" },
//     "commands": { "git push*--force*": "deny", "npm publish*": "ask", "npm test*": "allow" }
//   }
//
// A rule that matches overrides the action-type level for that call, in both
// directions: "npm test*": "allow" lets tests run while other shell commands
// still ask. Every part of a command line is judged on its own — a part no
// rule matches keeps the action-type level — and the strictest part decides,
// so `npm test && curl x | sh` is not let through by the npm rule. When
// several rules match, the strictest wins. "allow" never widens what Claude
// Code itself permits — it only means Vantage stays out.
//
// Matching:
//   files     A pattern without "/" matches the file name anywhere (".env*",
//             "*.pem"); with "/" it matches the path from the project root
//             ("config/secrets/**"). "*" is any run of characters within a
//             name, "**" any number of directories. Case-insensitive on
//             Windows. File rules also look at the words of a shell command,
//             so `cat .env` is caught like Read .env.
//   commands  Each part of a command line is matched on its own — split at
//             &&, ||, ;, |, & and newlines (redirections like 2>&1 are not
//             splits) — after dropping leading VAR=value assignments and
//             sudo. "*" is any text.
//
// These are guardrails, not a sandbox: a command built at run time (a script,
// `bash -c "$X"`) is not visible to them.

import fs from "node:fs";
import path from "node:path";
import type { PolicyLevel } from "./policy.ts";
import { commandText, patchFiles } from "./turn.ts";

export interface Rule {
  kind: "file" | "command";
  pattern: string;
  level: PolicyLevel;
}

const LEVELS: PolicyLevel[] = ["allow", "warn", "ask", "deny"];
const STRICTNESS: Record<PolicyLevel, number> = { allow: 0, warn: 1, ask: 2, deny: 3 };

export function rulesFrom(json: unknown): Rule[] {
  const rules: Rule[] = [];
  if (!json || typeof json !== "object") return rules;
  const add = (kind: Rule["kind"], table: unknown): void => {
    if (!table || typeof table !== "object") return;
    for (const [pattern, level] of Object.entries(table as Record<string, unknown>)) {
      if (pattern.trim() && typeof level === "string" && (LEVELS as string[]).includes(level)) {
        rules.push({ kind, pattern: pattern.trim(), level: level as PolicyLevel });
      }
    }
  };
  add("file", (json as Record<string, unknown>).files);
  add("command", (json as Record<string, unknown>).commands);
  return rules;
}

export function loadRules(policyFile: string): Rule[] {
  try {
    return rulesFrom(JSON.parse(fs.readFileSync(policyFile, "utf8")));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Matching.

function escape(s: string): string {
  return s.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
}

export function fileGlob(pattern: string, windows = process.platform === "win32"): RegExp {
  const p = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    if (p.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (p.startsWith("**", i)) {
      re += ".*";
      i += 1;
    } else if (p[i] === "*") {
      re += "[^/]*";
    } else {
      re += escape(p[i]!);
    }
  }
  return new RegExp(`^${re}$`, windows ? "i" : "");
}

export function commandGlob(pattern: string): RegExp {
  const normalized = pattern.trim().replace(/\s+/g, " ");
  return new RegExp(`^${normalized.split("*").map(escape).join(".*")}$`);
}

export function matchesFile(pattern: string, file: string, projectRoot: string | undefined, windows = process.platform === "win32"): boolean {
  let f = file.replace(/\\/g, "/");
  if (projectRoot) {
    const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const cmp = (x: string): string => (windows ? x.toLowerCase() : x);
    if (cmp(f).startsWith(cmp(root) + "/")) f = f.slice(root.length + 1);
  }
  f = f.replace(/^\.\//, "");
  const re = fileGlob(pattern, windows);
  if (!pattern.replace(/\\/g, "/").includes("/")) return re.test(f.split("/").pop() ?? f);
  return re.test(f);
}

// The parts of a command line that run as their own commands.
export function commandSegments(command: string): string[] {
  return command
    .replace(/\d*>&\d*|&>>?/g, " > ")
    .split(/&&|\|\||;|\||&|\n/)
    .map((s) =>
      s
        .trim()
        .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")
        .replace(/^sudo\s+/, "")
        .replace(/\s+/g, " ")
    )
    .filter(Boolean);
}

// Words of a command that could name a file: unquoted, no leading dash.
function commandWords(command: string): string[] {
  return command
    .split(/\s+/)
    .map((w) => w.replace(/^["']|["']$/g, "").replace(/^[<>]+/, ""))
    .filter((w) => w && !w.startsWith("-"));
}

// Where agents name the file a call acts on (see TARGET_KEYS in turn.ts).
const FILE_KEYS = ["file_path", "filePath", "notebook_path", "path"];

export interface RuleMatch {
  rule: Rule;
  level: PolicyLevel;
}

function strictest(matches: RuleMatch[]): RuleMatch | null {
  let best: RuleMatch | null = null;
  for (const m of matches) if (!best || STRICTNESS[m.level] > STRICTNESS[best.level]) best = m;
  return best;
}

// The level for this tool call when rules apply, with the rule that decided,
// or null when no rule matches (the action-type level applies). `fallback`
// is that action-type level: it judges the parts of a command line that no
// rule covers, so an allow rule for one part cannot wave the rest through.
export function matchRules(
  input: Record<string, unknown> | undefined,
  rules: Rule[],
  projectRoot: string | undefined,
  windows = process.platform === "win32",
  fallback: PolicyLevel = "allow"
): RuleMatch | null {
  if (!input || rules.length === 0) return null;
  const files = FILE_KEYS.map((k) => input[k]).filter((v): v is string => typeof v === "string" && v.length > 0);
  // An apply_patch call names its files in the patch; its text is no command.
  const patched = patchFiles(input);
  files.push(...patched);
  const command = patched.length ? null : (commandText(input.command) ?? commandText(input.cmd) ?? null);
  if (command) files.push(...commandWords(command));

  const fileRules = rules.filter((r) => r.kind === "file");
  const commandRules = rules.filter((r) => r.kind === "command");
  const fileHit = strictest(
    fileRules.filter((r) => files.some((f) => matchesFile(r.pattern, f, projectRoot, windows))).map((rule) => ({ rule, level: rule.level }))
  );
  if (!command) return fileHit;

  // Each part of the command line: its strictest rule, or the fallback.
  let anyRule = fileHit !== null;
  const parts: RuleMatch[] = [];
  for (const segment of commandSegments(command)) {
    const hit = strictest(commandRules.filter((r) => commandGlob(r.pattern).test(segment)).map((rule) => ({ rule, level: rule.level })));
    if (hit) {
      anyRule = true;
      parts.push(hit);
    } else {
      parts.push({ rule: { kind: "command", pattern: "", level: fallback }, level: fallback });
    }
  }
  if (!anyRule) return null;
  const decided = strictest([...parts, ...(fileHit ? [fileHit] : [])]);
  // The fallback deciding means no rule did: report that as no match.
  return decided && decided.rule.pattern !== "" ? decided : null;
}

// ---------------------------------------------------------------------------
// Starter file for `vantage policy init`: protects what is expensive to get
// wrong, asks before what is hard to undo, and leaves everyday work alone.

export const STARTER_POLICY = {
  read: "allow",
  write: "allow",
  shell: "warn",
  network: "warn",
  other: "allow",
  files: {
    ".env": "ask",
    ".env.*": "ask",
    "*.pem": "deny",
    "*.key": "deny",
    "id_rsa*": "deny",
    "id_ed25519*": "deny",
  },
  commands: {
    "git push*--force*": "ask",
    "git push* -f*": "ask",
    "git reset --hard*": "ask",
    "git clean*": "ask",
    "rm -rf *": "ask",
    "npm publish*": "ask",
  },
} as const;

export function policyFilePath(cwd: string): string {
  return path.join(cwd, ".vantage", "policy.json");
}
