// Desktop notifications for the moments that need you while Claude Code's
// chat has the terminal (Vantage stays silent there, see src/terminal.ts):
// a question waiting for your approval, a long task finished, a limit or
// budget reached.
//
// No dependencies: each OS's own notifier is started as a child process.
// Title and text travel in environment variables, never inside a command
// string, so a file name or reply with quotes cannot inject anything. A
// notifier that is missing or fails is ignored — a notification is a
// convenience and must never disturb the session.

import { spawn } from "node:child_process";
import type { NotifyKind } from "./config.ts";

export interface NotifyCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

// Windows: a toast through PowerShell's WinRT bridge. Toasts need a
// registered app id; PowerShell's own is present on every Windows 10/11.
const WINDOWS_TOAST = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
  "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$text = $xml.GetElementsByTagName('text')",
  "$text.Item(0).AppendChild($xml.CreateTextNode($env:VANTAGE_NOTIFY_TITLE)) > $null",
  "$text.Item(1).AppendChild($xml.CreateTextNode($env:VANTAGE_NOTIFY_BODY)) > $null",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)",
].join("; ");

export function notifyCommand(platform: NodeJS.Platform, title: string, body: string): NotifyCommand | null {
  const env = { VANTAGE_NOTIFY_TITLE: title, VANTAGE_NOTIFY_BODY: body };
  switch (platform) {
    case "win32":
      return {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_TOAST],
        env,
      };
    case "darwin":
      return {
        command: "osascript",
        args: ["-e", 'display notification (system attribute "VANTAGE_NOTIFY_BODY") with title (system attribute "VANTAGE_NOTIFY_TITLE")'],
        env,
      };
    case "linux":
    case "freebsd":
    case "openbsd":
      // notify-send takes them as plain arguments; no shell is involved.
      return { command: "notify-send", args: ["--app-name=vantage", title, body], env };
    default:
      return null;
  }
}

export type Send = (title: string, body: string) => void;

// Fire and forget: detached, output ignored, errors swallowed.
export function systemSend(platform: NodeJS.Platform = process.platform): Send {
  return (title, body) => {
    const cmd = notifyCommand(platform, title, body);
    if (!cmd) return;
    try {
      const child = spawn(cmd.command, cmd.args, {
        env: { ...process.env, ...cmd.env },
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => {
        /* no notifier installed */
      });
      child.unref();
    } catch {
      /* never let a notification break the session */
    }
  };
}

export interface NotifierOptions {
  /** Kinds to send (see config.ts); others are dropped. */
  kinds: Set<NotifyKind>;
  /** Shown first in every title, so parallel sessions can be told apart. */
  project?: string;
  cooldownMs?: number;
}

// Sends only the enabled kinds, titled with the project, and deduplicates by
// key: each event notifies once per cooldown, so a quota hovering at 90%
// does not fire on every request.
export class Notifier {
  private readonly send: Send;
  private readonly opts: NotifierOptions;
  private readonly last = new Map<string, number>();

  constructor(send: Send, opts: NotifierOptions) {
    this.send = send;
    this.opts = opts;
  }

  notify(kind: NotifyKind, key: string, title: string, body: string, nowMs = Date.now()): boolean {
    if (!this.opts.kinds.has(kind)) return false;
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < (this.opts.cooldownMs ?? 10 * 60_000)) return false;
    this.last.set(key, nowMs);
    this.send(this.opts.project ? `${this.opts.project} · ${title}` : title, body);
    return true;
  }
}
