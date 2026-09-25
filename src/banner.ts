// The logo shown by `vantage`, `vantage --help` and `vantage doctor`.
//
// Only in a terminal wide enough for it: piped or redirected output, and
// narrow windows, get the one-line form instead. Plain ASCII, so it renders
// the same in every console and font.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SLOGAN = "See and control what your coding agent does";

const ART: string[] = [
  "                    __                          _",
  " _   ______ _____  / /_____ _____ ____   ____ _(_)",
  "| | / / __ `/ __ \\/ __/ __ `/ __ `/ _ \\ / __ `/ /",
  "| |/ / /_/ / / / / /_/ /_/ / /_/ /  __// /_/ / /",
  "|___/\\__,_/_/ /_/\\__/\\__,_/\\__, /\\___(_)__,_/_/",
  "                          /____/",
];

const ART_WIDTH = Math.max(...ART.map((l) => l.length));

export function packageVersion(): string {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string }).version ?? "";
  } catch {
    return "";
  }
}

export interface BannerOptions {
  /** Draw the logo; otherwise one line. */
  art: boolean;
  color: boolean;
  version?: string;
  /** Terminal width; the logo needs about 52 columns. */
  columns?: number;
}

export function banner(opts: BannerOptions): string {
  const version = opts.version ?? packageVersion();
  const v = version ? ` · v${version}` : "";
  // The terminal's own text color (white on a dark background, black on a
  // light one), the logo in bold.
  const bold = opts.color ? "\x1b[1m" : "";
  const reset = opts.color ? "\x1b[0m" : "";
  const tagline = `${SLOGAN}${v}`;
  const fits = !opts.columns || opts.columns >= Math.max(ART_WIDTH, tagline.length); // 0: width unknown
  if (!opts.art || !fits) return `${bold}vantage.ai${reset} · ${tagline}`;
  return [...ART.map((line) => `${bold}${line}${reset}`), tagline].join("\n");
}

// For stdout as it is now: the logo in a terminal, one line otherwise;
// color unless NO_COLOR is set.
export function bannerForStdout(): string {
  const tty = Boolean(process.stdout.isTTY);
  return banner({ art: tty, color: tty && !process.env.NO_COLOR, columns: process.stdout.columns });
}
