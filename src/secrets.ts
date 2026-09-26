// Warns when something that looks like a secret is sent to the API.
//
// Every request Claude Code sends carries the conversation so far: your
// messages, Claude's replies, and the output of every tool it ran. When
// Claude reads a .env file or runs a command that prints a token, that
// secret goes to Anthropic with the next request. Vantage cannot and does
// not stop that (it never changes what the agent sends), but it can tell
// you right away, name where it came from, so you can decide whether to
// rotate it.
//
// Only patterns with a low false-positive rate: well-known key formats,
// private key blocks, and .env-style assignments to names like PASSWORD or
// API_KEY. The secret itself is never stored — only its kind, a masked
// prefix and where it appeared. A request repeats the whole history, so the
// caller deduplicates by fingerprint.

import { createHash } from "node:crypto";
import { anthropicParts, type ConversationPart } from "./formats/parts.ts";

export interface SecretFinding {
  kind: string;
  /** A few leading characters and the length, never the secret. */
  masked: string;
  /** Where in the conversation it appeared, e.g. "Read .env" or "your message". */
  source: string;
  /**
   * Stable id of the secret for deduplication: a hash of the value alone, so
   * a key matched both by its format and as KEY=value is reported once —
   * by the more specific pattern, which comes first.
   */
  fingerprint: string;
}

interface Pattern {
  kind: string;
  re: RegExp;
  /** Which capture group is the secret (default: the whole match). */
  group?: number;
  /** For .env assignments, the variable name is the useful label. */
  nameGroup?: number;
}

const PATTERNS: Pattern[] = [
  { kind: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "OpenAI API key", re: /\bsk-(?:proj-)?(?!ant-)[A-Za-z0-9_-]{32,}/g },
  { kind: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "Stripe live key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // KEY=value lines as in .env files: the name says what it is. The value
  // must be long enough and not a reference or placeholder. Claude Code's
  // Read shows files with line numbers ("     2\tDB_PASSWORD=…"), so an
  // optional number prefix is allowed.
  {
    kind: "secret in an assignment",
    re: /(?:^|\n)\s*(?:\d+\s*[\t→|:]\s*)?(?:export\s+)?([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|API_KEY|APIKEY|ACCESS_KEY|AUTH_TOKEN|TOKEN|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*["']?([^\s"'$<>{}]{8,})/g,
    group: 2,
    nameGroup: 1,
  },
];

// Obvious placeholders are not secrets.
const PLACEHOLDER = /^(?:x+|\*+|changeme|change_me|your[_-].*|example.*|placeholder.*|dummy.*|test.*|<.*>|\.\.\.+)$/i;

function mask(value: string): string {
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

// A UTF-16 file — what `>` and Out-File write in Windows PowerShell 5.1 —
// reaches the API as text with a NUL after every character and its
// byte-order mark as replacement characters: "��D\0B\0_\0P\0…". Neither can
// be part of a secret, so both are dropped before matching.
const NOT_TEXT = /[\u0000\uFEFF\uFFFD]/g;

export function scanText(raw: string, source: string): SecretFinding[] {
  const text = raw.replace(NOT_TEXT, "");
  const out: SecretFinding[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const value = m[p.group ?? 0] ?? m[0];
      if (PLACEHOLDER.test(value)) continue;
      const name = p.nameGroup ? m[p.nameGroup] : undefined;
      const fingerprint = createHash("sha256").update(value).digest("hex").slice(0, 16);
      if (out.some((f) => f.fingerprint === fingerprint)) continue;
      out.push({
        kind: name ? `value of ${name}` : p.kind,
        masked: p.kind === "private key" ? m[0] : mask(value),
        source,
        fingerprint,
      });
    }
  }
  return out;
}

// Scans a request's conversation parts (src/formats/parts.ts) and attributes
// each finding: the tool call whose output carried it, your message, the
// agent's reply, or the system prompt (where CLAUDE.md and injected memory
// live).
//
// `seen` makes a long session cheap: every request repeats the whole
// history, so parts already scanned (recognized by a hash of their text) are
// skipped. The tool calls in them are still read, to name the source of a
// later tool result.
export function scanParts(parts: ConversationPart[], seen?: Set<string>): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const p of parts) {
    if (seen && p.text) {
      const key = createHash("sha1").update(p.key).update("\0").update(p.text).digest("hex");
      if (seen.has(key)) continue;
      seen.add(key);
    }
    found.push(...scanText(p.text, p.source));
  }
  return found;
}

// A Messages API request, as Claude Code sends it.
export function scanRequest(body: unknown, seen?: Set<string>, agent = "Claude"): SecretFinding[] {
  return scanParts(anthropicParts(body, agent), seen);
}
