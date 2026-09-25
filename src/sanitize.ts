// Text from outside — file names, commands, prompts, replies, tool output —
// can carry terminal control sequences. Shown as is, a file named
// "a\x1b]0;x\x07.ts" retitles the window, "\x1b[2J" clears the screen, and in
// some terminals OSC 52 writes to the clipboard. Everything Vantage prints that
// it did not write itself goes through plain() first; Claude Code does the same
// in its own UI.

// Whole sequences first, so their parameters do not linger as text: CSI
// (colors, cursor), OSC (title, clipboard, links), DCS/SOS/PM/APC, two-byte
// escapes, and the single-byte C1 forms of CSI and OSC.
const SEQUENCES =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[P^_X][^\x1b]*(?:\x1b\\)?|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]|\x9d[^\x07\x9c]*[\x07\x9c]?/g;
// Then every control character left, except the line break. A tab becomes a
// space; a carriage return could overwrite what is already on the line.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function plain(text: string): string {
  return text.replace(SEQUENCES, "").replace(/\t/g, " ").replace(CONTROLS, "");
}

// plain() on every string inside a parsed value (an event from the log).
export function plainDeep<T>(value: T): T {
  if (typeof value === "string") return plain(value) as T;
  if (Array.isArray(value)) return value.map((v) => plainDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = plainDeep(v);
    return out as T;
  }
  return value;
}
