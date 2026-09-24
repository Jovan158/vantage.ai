// Alerts for Claude Code's own chat UI.
//
// While that UI owns the terminal, `vantage run` cannot print (see
// src/terminal.ts). Instead it posts each alert here, in the session folder.
// The hook Claude Code starts when a reply is finished (Stop), and before each
// tool when rules or a budget are enforced (PreToolUse), takes what is waiting
// and returns it as a `systemMessage`, which Claude Code shows in the
// conversation. Whatever is still waiting when Claude Code exits is printed
// then.

import fs from "node:fs";
import path from "node:path";

export function outboxPath(dir: string): string {
  return path.join(dir, "outbox.jsonl");
}

export interface Alert {
  level: "warn" | "critical";
  message: string;
}

export function postAlert(file: string, alert: Alert): void {
  try {
    fs.appendFileSync(file, JSON.stringify({ level: alert.level, message: alert.message }) + "\n");
  } catch {
    /* the alert is still in the event log and in `vantage watch` */
  }
}

// Takes every waiting alert, exactly once: the file is renamed away first, so
// an alert posted meanwhile starts a new file and waits for the next take.
export function takeAlerts(file: string | undefined): Alert[] {
  if (!file) return [];
  const taking = `${file}.${process.pid}.taking`;
  try {
    fs.renameSync(file, taking);
  } catch {
    return []; // nothing waiting
  }
  let text = "";
  try {
    text = fs.readFileSync(taking, "utf8");
  } catch {
    /* taken but unreadable: dropped */
  } finally {
    fs.rmSync(taking, { force: true });
  }
  const alerts: Alert[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const a = JSON.parse(line) as Partial<Alert>;
      if (typeof a.message !== "string" || alerts.some((x) => x.message === a.message)) continue;
      alerts.push({ level: a.level === "critical" ? "critical" : "warn", message: a.message });
    } catch {
      /* a torn line */
    }
  }
  return alerts;
}

// As shown in the chat, one line per alert. Claude Code puts the hook's name
// in front ("Stop says: …"), so each line says it is from Vantage.
export function chatText(alerts: Alert[]): string {
  return alerts.map((a) => `Vantage${a.level === "critical" ? " ALERT" : ""}: ${a.message}`).join("\n");
}
