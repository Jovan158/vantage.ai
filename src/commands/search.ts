// `vantage search`: find sessions by what was said, read, written or run.

import { knownSessions } from "../home.ts";
import { readSessionEvents } from "../watch.ts";
import { searchSession, renderSearch, type Scope, type SessionHits } from "../search.ts";
import { log } from "./output.ts";

export async function cmdSearch(argv: string[]): Promise<number> {
  let scope: Scope = "all";
  const words: string[] = [];
  for (const a of argv) {
    if (a === "--files") scope = "files";
    else if (a === "--commands") scope = "commands";
    else if (a.startsWith("--")) {
      log(`unknown flag "${a}" (--files | --commands)`);
      return 1;
    } else words.push(a);
  }
  const query = words.join(" ").trim();
  if (!query) {
    log('usage: vantage search <text> [--files | --commands]   e.g. vantage search "npm publish"');
    return 1;
  }
  const cwd = process.cwd();
  const results: SessionHits[] = [];
  for (const ref of knownSessions(cwd)) {
    const hit = searchSession(ref, readSessionEvents(ref.cwd, ref.sessionId), query, scope);
    if (hit) results.push(hit);
  }
  process.stdout.write(renderSearch(results, { query, color: process.stdout.isTTY ?? false, width: process.stdout.columns }) + "\n");
  return results.length ? 0 : 1;
}
