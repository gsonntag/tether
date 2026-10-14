// The sessions the sidebar and Home know, grouped by recentSessions.ts into Needs you, Working
// and Recent. Both read these hooks, so they agree.

import { useMemo, useRef, useSyncExternalStore } from "react";
import type { AgentNotice, ProjectInfo, SessionSummary } from "./shared/protocol";
import { groupSessions, mergeEntries, needCount, type Entry, type Groups, type RecentContext } from "./recentSessions";
import { useStore } from "./store";

/**
 * Every session of the sidebar's runner we know a summary for: Recent's list, the live ones from
 * listProjects, then loaded lists (pushed live by the runner, so they win). A notice for one we
 * have no summary for yet is enough to show and open it.
 */
export function knownSessions(projects: ProjectInfo[], sessions: Record<string, SessionSummary[]>, recent: SessionSummary[] = [], notices: AgentNotice[] = []) {
  const by = new Map(recent.map((s) => [s.id, s] as const));
  for (const p of projects) for (const s of p.live) by.set(s.id, s);
  for (const s of Object.values(sessions).flat()) by.set(s.id, s);
  for (const n of notices)
    if (!by.has(n.sessionId) && n.kind !== "memory")
      by.set(n.sessionId, {
        id: n.sessionId,
        harness: n.sessionId.split(":")[0] as SessionSummary["harness"],
        nativeId: n.sessionId.split(":").slice(1).join(":"),
        projectPath: n.projectPath,
        title: n.title.split(" · ").slice(1).join(" · ") || n.title,
        createdAt: n.ts,
        updatedAt: n.ts,
        live: false,
        status: "idle",
      });
  return by;
}

// One minute clock for every list, so sessions drop out of the window without a reload. The
// snapshot reads the clock itself: a list mounted after a long while (the phone sidebar opened
// again) must not start from the minute the last one saw.
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | undefined;
function subscribeMinute(l: () => void) {
  minuteListeners.add(l);
  minuteTimer ??= setInterval(() => {
    for (const f of minuteListeners) f();
  }, 60_000);
  return () => {
    minuteListeners.delete(l);
    if (!minuteListeners.size) {
      clearInterval(minuteTimer);
      minuteTimer = undefined;
    }
  };
}
export const useMinute = () => useSyncExternalStore(subscribeMinute, () => Math.floor(Date.now() / 60_000));

/** What the lists need to decide a session's state and whether it's in the window. */
export function useRecentContext(): RecentContext {
  const notices = useStore((s) => s.notices);
  const noticesSeen = useStore((s) => s.noticesSeen);
  const noticesRead = useStore((s) => s.noticesRead);
  const viewed = useStore((s) => s.viewed);
  const viewedHere = useStore((s) => s.viewedHere);
  const days = useStore((s) => s.ui.sidebarDays);
  const selected = useStore((s) => s.selected);
  const runnerId = useStore((s) => s.runnerId);
  const held = useStore((s) => s.hold);
  const hold = held?.id === selected ? held : undefined;
  const minute = useMinute();
  return useMemo(
    () => ({ notices, noticesSeen, noticesRead, viewed, viewedHere, days, selected, runnerId, hold, now: minute * 60_000 }),
    [notices, noticesSeen, noticesRead, viewed, viewedHere, days, selected, runnerId, hold, minute],
  );
}

/** Home's and the Home item's count of what waits on you: one per request to answer, one per other session, and memory conflicts. */
export function useNeedsCount(needs: Entry[]): number {
  const conflicts = useStore((s) => s.conflicts.length);
  return needs.reduce((n, e) => n + needCount(e), conflicts);
}

/**
 * The three groups. "runner": the sidebar's runner only; "all": Home, every connected runner
 * (others through their pulses). The open session stays where it was while you look at it.
 */
export function useSessionGroups(scope: "runner" | "all"): Groups<Entry> {
  const projects = useStore((s) => s.projects);
  const sessions = useStore((s) => s.sessions);
  const recent = useStore((s) => s.recent);
  const pulses = useStore((s) => s.pulses);
  const runnerId = useStore((s) => s.runnerId);
  const c = useRecentContext();
  const wasNeeds = useRef(new Set<string>());
  const groups = useMemo(() => {
    const known = knownSessions(projects, sessions, recent, c.notices).values();
    const forPulses = scope === "all" ? pulses : runnerId && pulses[runnerId] ? { [runnerId]: pulses[runnerId] } : {};
    return groupSessions(mergeEntries(runnerId, known, forPulses), { ...c, wasNeeds: wasNeeds.current });
  }, [projects, sessions, recent, pulses, runnerId, c, scope]);
  wasNeeds.current = new Set(groups.needs.filter((e) => !e.runnerId || e.runnerId === runnerId).map((e) => e.session.id));
  return groups;
}
