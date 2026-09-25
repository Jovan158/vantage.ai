// File-based, git-versioned project memory (CONCEPT.md §5, problem ⑤).
//
// Canonical store under .vantage/memory/*.md (committed, unlike the ignored
// sessions/ and worktrees/). Vantage compiles it into a single context string
// that is injected into the agent through its native mechanism — for Claude
// Code, `--append-system-prompt` (non-invasive: no file is rewritten).

import fs from "node:fs";
import path from "node:path";

// Canonical files in the order they compile into context.
const FILES = ["architecture.md", "conventions.md", "decisions.md", "glossary.md"] as const;

const TEMPLATES: Record<string, string> = {
  "architecture.md": "# Architecture\n\nSystem structure, module boundaries, key components.\n",
  "conventions.md": "# Conventions\n\nCode style and patterns — \"how we do things here\".\n",
  "decisions.md": "# Decisions\n\nArchitectural decisions and their rationale (append-only).\n",
  "glossary.md": "# Glossary\n\nDomain terms.\n",
};

export function memoryDir(cwd: string): string {
  return path.join(cwd, ".vantage", "memory");
}

export function initMemory(cwd: string): { created: string[]; existing: string[] } {
  const dir = memoryDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const created: string[] = [];
  const existing: string[] = [];
  for (const f of FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      existing.push(f);
    } else {
      fs.writeFileSync(p, TEMPLATES[f]!);
      created.push(f);
    }
  }
  return { created, existing };
}

// Concatenate the memory files into one context string, or null if there is
// nothing meaningful to inject.
export function compileMemory(cwd: string): string | null {
  const dir = memoryDir(cwd);
  if (!fs.existsSync(dir)) return null;

  const sections: string[] = [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => rank(a) - rank(b));

  for (const f of files) {
    const body = fs.readFileSync(path.join(dir, f), "utf8").trim();
    // Skip files that still only hold their template scaffold.
    if (!body || body === (TEMPLATES[f] ?? "").trim()) continue;
    sections.push(body);
  }
  if (sections.length === 0) return null;

  return (
    "The following is persistent project memory maintained across sessions " +
    "by Vantage. Treat it as authoritative project context.\n\n" +
    sections.join("\n\n")
  );
}

function rank(file: string): number {
  const i = (FILES as readonly string[]).indexOf(file);
  return i === -1 ? FILES.length : i;
}

// Append a note to a memory file, creating it (with a heading) if needed.
export function addNote(cwd: string, category: string, text: string): string {
  const dir = memoryDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = category.endsWith(".md") ? category : `${category}.md`;
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) {
    const heading = file.replace(/\.md$/, "");
    fs.writeFileSync(p, `# ${heading[0]!.toUpperCase()}${heading.slice(1)}\n`);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(p, `\n- (${stamp}) ${text.trim()}\n`);
  return p;
}
