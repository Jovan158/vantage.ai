// `vantage watch`: the live view, meant for a second terminal next to the one
// Claude Code runs in.

import path from "node:path";
import { EventTail, sessionEventsPath, type VantageEvent } from "../events.ts";
import { renderLive, renderOverview, findWatchTarget } from "../watch.ts";
import { findSession, sessionRunning, SessionList, type SessionRef } from "../home.ts";

export async function cmdWatch(argv: string[]): Promise<number> {
  const cwd = process.cwd();
  const pinned = argv[0];
  const interval = 500;

  // Renders into THIS terminal only — the agent's own terminal is never
  // touched, which is the whole point of watching from a second pane.
  const draw = (body: string): void => {
    process.stdout.write("\x1b[H\x1b[J" + body + "\n"); // home, clear to end
  };

  const waiting = "waiting for a session…  (start one with `vantage run claude`)";
  const key = (r: SessionRef): string => `${path.resolve(r.cwd)}|${r.sessionId}`;
  // Logs are followed, not re-read: each tick parses only what was appended.
  const tails = new Map<string, EventTail>();
  const eventsOf = (ref: SessionRef): VantageEvent[] => {
    let tail = tails.get(key(ref));
    if (!tail) tails.set(key(ref), (tail = new EventTail(sessionEventsPath(ref.cwd, ref.sessionId))));
    return tail.read();
  };
  // Sessions seen ended stay ended; no need to look at them again.
  const ended = new Set<string>();
  const list = new SessionList(cwd);
  const running = (): SessionRef[] =>
    list.get().filter((r) => {
      if (ended.has(key(r))) return false;
      if (sessionRunning(r)) return true;
      ended.add(key(r));
      return false;
    });
  // The session to show when none runs changes only when the list does.
  let fallbackFor: SessionRef[] | null = null;
  let fallback: SessionRef | null = null;
  const lastSession = (): SessionRef | null => {
    const refs = list.get();
    if (refs !== fallbackFor) {
      fallbackFor = refs;
      fallback = findWatchTarget(cwd);
    }
    return fallback;
  };

  const detail = (ref: SessionRef, events = eventsOf(ref)): string | null => {
    if (events.length === 0) return null;
    return renderLive(events, {
      sessionId: ref.sessionId,
      project: path.resolve(ref.cwd) === path.resolve(cwd) ? undefined : ref.cwd,
      color: process.stdout.isTTY ?? false,
      width: process.stdout.columns,
    });
  };

  return await new Promise<number>((resolve) => {
    // The first tick runs right away and may already stop (a pinned session
    // that has ended), before the interval exists.
    let timer: ReturnType<typeof setInterval> | undefined;
    let pinnedRef: SessionRef | null = null;
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      if (timer) clearInterval(timer);
      process.stdout.write("\n");
      resolve(0);
    };
    process.on("SIGINT", stop);

    const tick = (): void => {
      // A pinned session: found here or anywhere this machine recorded it;
      // watching ends with it.
      if (pinned) {
        pinnedRef ??= findSession(pinned, cwd);
        if (!pinnedRef) return draw(`no session ${pinned} found — see \`vantage sessions\` or \`vantage search\``);
        const events = eventsOf(pinnedRef);
        const frame = detail(pinnedRef, events);
        if (frame) draw(frame);
        // Ended, or its vantage process is gone (crashed without an end).
        if (events.some((e) => e.type === "session_end") || !sessionRunning(pinnedRef)) stop();
        return;
      }
      // Otherwise: several running sessions side by side, one running
      // session in detail, or the last one when none runs.
      const live = running();
      if (live.length >= 2) {
        const items = live.map((ref) => ({ ref, events: eventsOf(ref) }));
        return draw(renderOverview(items, { color: process.stdout.isTTY ?? false, width: process.stdout.columns }));
      }
      const target = live[0] ?? lastSession();
      if (!target) return draw(waiting);
      const frame = detail(target);
      if (frame) draw(frame);
    };
    tick();
    if (!stopped) timer = setInterval(tick, interval);
  });
}
