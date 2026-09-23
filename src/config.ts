// Per-user settings in ~/.vantage/config.json. Today: which desktop
// notifications to send.
//
//   { "notify": false }                                  none at all
//   { "notify": { "done": false, "limits": true } }      pick kinds; unlisted stay on
//
// Precedence, strongest first: `vantage run --no-notify`, VANTAGE_NOTIFY=0/1,
// this file, then the default (on while Claude Code's chat UI is open).

import fs from "node:fs";
import path from "node:path";
import { vantageHome } from "./home.ts";

export const NOTIFY_KINDS = ["approval", "done", "limits", "budget", "secrets"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export interface VantageConfig {
  /** false turns all notifications off; an object turns single kinds off. */
  notify: boolean | Partial<Record<NotifyKind, boolean>>;
}

export const DEFAULT_CONFIG: VantageConfig = { notify: true };

export function configPath(): string {
  return path.join(vantageHome(), "config.json");
}

export interface ConfigRead {
  config: VantageConfig;
  /** Set when the file exists but could not be used; defaults apply. */
  error: string | null;
}

export function parseConfig(json: unknown): VantageConfig {
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("expected a JSON object");
  const notify = (json as Record<string, unknown>).notify;
  if (notify === undefined) return { ...DEFAULT_CONFIG };
  if (typeof notify === "boolean") return { notify };
  if (!notify || typeof notify !== "object" || Array.isArray(notify)) throw new Error('"notify" must be true, false or an object');
  const kinds: Partial<Record<NotifyKind, boolean>> = {};
  for (const [k, v] of Object.entries(notify)) {
    if (!(NOTIFY_KINDS as readonly string[]).includes(k)) throw new Error(`unknown notification kind "${k}" (${NOTIFY_KINDS.join(", ")})`);
    if (typeof v !== "boolean") throw new Error(`"notify.${k}" must be true or false`);
    kinds[k as NotifyKind] = v;
  }
  return { notify: kinds };
}

export function loadConfig(file = configPath()): ConfigRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { config: { ...DEFAULT_CONFIG }, error: null };
  }
  try {
    return { config: parseConfig(JSON.parse(raw)), error: null };
  } catch (err) {
    return { config: { ...DEFAULT_CONFIG }, error: `${file}: ${(err as Error).message}` };
  }
}

// The kinds to send, after all switches.
export function enabledNotifyKinds(
  config: VantageConfig,
  opts: { interactive: boolean; noNotifyFlag?: boolean; env?: NodeJS.ProcessEnv }
): Set<NotifyKind> {
  const env = opts.env ?? process.env;
  const none = new Set<NotifyKind>();
  if (opts.noNotifyFlag || env.VANTAGE_NOTIFY === "0") return none;
  if (config.notify === false) return env.VANTAGE_NOTIFY === "1" ? new Set(NOTIFY_KINDS) : none;
  if (env.VANTAGE_NOTIFY !== "1" && !opts.interactive) return none;
  const picked = config.notify === true ? {} : config.notify;
  return new Set(NOTIFY_KINDS.filter((k) => picked[k] !== false));
}
