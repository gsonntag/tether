import { useEffect, useMemo, useState } from "react";
import type { SpawnedFamily } from "../../../shared/protocol";
import { rpc } from "../connection";
import { familyKeyOf, forgetFamilies, loadFamily, useFamilies } from "../familyStore";
import { childrenOf, mergeRows, type Row } from "../sessionList";
import { useStore } from "../store";
import { familyKey, mainIds, spawnedRows, withSpawned } from "../subagents";

// Back from a dropped link: every family is asked again.
useStore.subscribe((s, prev) => void (s.link === "open" && prev.link !== "open" && forgetFamilies()));

/**
 * A session's subagents: live ones from the broadcast summaries, past ones from the runner
 * (`listSessions {parentSessionId}`), fetched again when the live set or the parent's status changes.
 * With them, the sessions its agent started (`spawned`, useFamily).
 */
export function useChildren(runnerId: string | undefined, sessionId: string | undefined): Row[] {
  return useFamily(runnerId, sessionId).children;
}

/**
 * useChildren, and the session that started this one with tether_start (SPEC §6a), from the peers
 * module's spawnedFamily op where the runner has it (RunnerInfo.spawnedFamily). Only for the session
 * asked about, one answer shared by every caller (familyStore.ts).
 */
export function useFamily(runnerId: string | undefined, sessionId: string | undefined): { children: Row[]; parent?: SpawnedFamily["parent"] } {
  const summaries = useStore((s) => s.summaries);
  const linkOpen = useStore((s) => s.link === "open");
  const spawnable = useStore((s) => !!runnerId && !!s.runners.find((r) => r.id === runnerId)?.spawnedFamily);
  const live = useMemo(() => (runnerId && sessionId ? childrenOf(summaries, runnerId, sessionId) : []), [summaries, runnerId, sessionId]);
  const parentStatus = runnerId && sessionId ? summaries[runnerId]?.sessions[sessionId]?.status : undefined;
  const [stored, setStored] = useState<{ for: string; rows: Row[] }>({ for: "", rows: [] });
  const k = `${runnerId}\u0000${sessionId}`;
  const liveKey = live.map((r) => `${r.id}:${r.status}`).join(",");
  useEffect(() => {
    if (!runnerId || !sessionId || !linkOpen) return;
    let gone = false;
    rpc(runnerId, "listSessions", { parentSessionId: sessionId })
      .then((r) => !gone && setStored({ for: k, rows: r.sessions.map((x) => ({ ...x, runnerId })) }))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [k, liveKey, parentStatus, linkOpen]);

  // Shared with every caller for this session (familyStore.ts): asked again when the session's or
  // its family's status or archived mark changes, or a main session appears on its runner.
  const entry = useFamilies((s) => (runnerId && sessionId ? s.by[familyKeyOf(runnerId, sessionId)] : undefined));
  const f = entry?.f;
  const key = runnerId && sessionId ? familyKey(summaries, runnerId, sessionId, f) : "";
  const fresh = entry && runnerId ? mainIds(summaries, runnerId).filter((id) => !entry.seen.includes(id)).join(",") : "";
  const stale = !entry || entry.key !== key || fresh !== "";
  useEffect(() => {
    if (runnerId && sessionId && linkOpen && spawnable && stale) loadFamily(runnerId, sessionId, key, () => useStore.getState().summaries, (r, s) => rpc(r, "spawnedFamily", { sessionId: s }));
  }, [runnerId, sessionId, key, fresh, stale, linkOpen, spawnable]);
  const children = useMemo(() => withSpawned(mergeRows(stored.for === k ? stored.rows : [], live), runnerId && spawnable ? spawnedRows(f, summaries, runnerId) : []), [stored, live, k, f, summaries, runnerId, spawnable]);
  const parentTitle = f?.parent && runnerId ? (summaries[runnerId]?.sessions[f.parent.id]?.title ?? f.parent.title) : undefined;
  const parent = useMemo(() => (f?.parent ? { id: f.parent.id, title: parentTitle ?? "" } : undefined), [f?.parent?.id, parentTitle]);
  return { children, parent };
}
