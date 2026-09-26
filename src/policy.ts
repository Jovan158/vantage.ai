// Action-type policy for problem ② — granular control by action type.
// Every tool call is classified into read / write / shell / network / other and
// judged against a configurable policy:
//
//   allow  no interference        warn  observe-only notice
//   ask    human must approve     deny  blocked outright
//
// "warn" is surfaced from the proxy's observation of the response stream.
// "ask"/"deny" are ENFORCED in src/hook.ts through the agent's PreToolUse hook —
// the proxy cannot do it, because a tool executes inside the agent and never
// travels through the proxy (CONCEPT.md §6b/c).

import fs from "node:fs";
import path from "node:path";

export type ActionType = "read" | "write" | "shell" | "network" | "other";
// allow  — no interference
// warn   — observe-only notice (no enforcement)
// ask    — the agent must get human approval before running it
// deny   — blocked outright
export type PolicyLevel = "allow" | "warn" | "ask" | "deny";

export type Policy = Record<ActionType, PolicyLevel>;

// Known tool names → action type: Claude Code's (which Copilot CLI reports
// too), then the ones the name patterns below would get wrong.
const TOOL_TYPES: Record<string, ActionType> = {
  Read: "read",
  NotebookRead: "read",
  Glob: "read",
  Grep: "read",
  LS: "read",
  Write: "write",
  Edit: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
  Bash: "shell",
  BashOutput: "shell",
  KillBash: "shell",
  KillShell: "shell",
  WebFetch: "network",
  WebSearch: "network",
  ls: "read", // pi
  codesearch: "network", // OpenCode: searches the web for code
};

export function classifyTool(name: string): ActionType {
  const known = TOOL_TYPES[name];
  if (known) return known;
  const n = name.toLowerCase();
  if (n.startsWith("mcp__")) return "network"; // MCP tools reach external services
  if (/(write|edit|create|delete|remove|move|rename|patch|apply)/.test(n)) return "write";
  if (/(fetch|http|url|web|curl|request|download|upload)/.test(n)) return "network";
  if (/(bash|shell|exec|command|terminal|process)/.test(n)) return "shell";
  if (/(read|list|glob|grep|search|find|view|cat|show)/.test(n)) return "read";
  return "other";
}

export const DEFAULT_POLICY: Policy = {
  read: "allow",
  write: "allow",
  shell: "warn",
  network: "warn",
  other: "allow",
};

const TYPES: ActionType[] = ["read", "write", "shell", "network", "other"];

const LEVELS: PolicyLevel[] = ["allow", "warn", "ask", "deny"];

function coerceLevel(v: unknown): PolicyLevel | null {
  return typeof v === "string" && (LEVELS as string[]).includes(v) ? (v as PolicyLevel) : null;
}

/** True when any action type is set to an enforcing level. */
export function needsEnforcement(policy: Policy): boolean {
  return Object.values(policy).some((l) => l === "ask" || l === "deny");
}

// Load policy from .vantage/policy.json, then apply the VANTAGE_POLICY env
// override ("shell:warn,network:allow"). Unknown keys/levels are ignored.
export function loadPolicy(cwd: string, env = process.env): Policy {
  const policy: Policy = { ...DEFAULT_POLICY };

  const file = path.join(cwd, ".vantage", "policy.json");
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const t of TYPES) {
        const lvl = coerceLevel(parsed[t]);
        if (lvl) policy[t] = lvl;
      }
    } catch {
      /* ignore malformed policy file */
    }
  }

  const raw = env.VANTAGE_POLICY;
  if (raw) {
    for (const pair of raw.split(",")) {
      const [k, v] = pair.split(":").map((s) => s.trim());
      if (k && TYPES.includes(k as ActionType)) {
        const lvl = coerceLevel(v);
        if (lvl) policy[k as ActionType] = lvl;
      }
    }
  }
  return policy;
}

export interface PolicyNotice {
  type: ActionType;
  tool: string;
  level: PolicyLevel;
  message: string;
}

// Emits a heads-up the first time each "warn" action type is observed in a
// session (no per-call spam).
export class PolicyWatcher {
  private seen = new Set<ActionType>();
  private readonly policy: Policy;

  constructor(policy: Policy) {
    this.policy = policy;
  }

  observe(toolNames: string[]): PolicyNotice[] {
    const out: PolicyNotice[] = [];
    for (const tool of toolNames) {
      const type = classifyTool(tool);
      const level = this.policy[type];
      if (level === "allow" || this.seen.has(type)) continue;
      this.seen.add(type);
      out.push({
        type,
        tool,
        level,
        message:
          level === "warn"
            ? `${type} action used (${tool}) — policy 'warn' (observe-only, not blocked)`
            : `${type} action used (${tool}) — policy '${level}' (enforced via agent hook)`,
      });
    }
    return out;
  }
}

export function summarizeActions(toolNames: string[]): Record<ActionType, number> {
  const counts: Record<ActionType, number> = { read: 0, write: 0, shell: 0, network: 0, other: 0 };
  for (const name of toolNames) counts[classifyTool(name)] += 1;
  return counts;
}

export function formatActionSummary(counts: Record<ActionType, number>): string | null {
  const parts = TYPES.filter((t) => counts[t] > 0).map((t) => `${t}×${counts[t]}`);
  return parts.length ? parts.join(" · ") : null;
}
