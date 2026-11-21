import { useEffect, useMemo, useState } from "react";
import type { SpawnedFamily } from "../../../shared/protocol";
import { rpc } from "../connection";
import { childrenOf, mergeRows, type Row } from "../sessionList";
import { useStore } from "../store";
import { spawnedRows, withSpawned } from "../subagents";

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
 * asked about: fetched again when a session comes or goes on its runner, or its status changes.
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

  // A started session is an ordinary one: a new one shows as a new summary on the runner.
  const [family, setFamily] = useState<{ for: string; f: SpawnedFamily }>();
  const runnerSessions = runnerId ? Object.keys(summaries[runnerId]?.sessions ?? {}).length : 0;
  useEffect(() => {
    if (!runnerId || !sessionId || !linkOpen || !spawnable) return;
    let gone = false;
    rpc(runnerId, "spawnedFamily", { sessionId })
      .then((f) => !gone && setFamily({ for: k, f }))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [k, parentStatus, linkOpen, spawnable, runnerSessions]);
  const f = family?.for === k ? family.f : undefined;
  const children = useMemo(() => withSpawned(mergeRows(stored.for === k ? stored.rows : [], live), runnerId ? spawnedRows(f, summaries, runnerId) : []), [stored, live, k, f, summaries, runnerId]);
  const parentTitle = f?.parent && runnerId ? (summaries[runnerId]?.sessions[f.parent.id]?.title ?? f.parent.title) : undefined;
  const parent = useMemo(() => (f?.parent ? { id: f.parent.id, title: parentTitle ?? "" } : undefined), [f?.parent?.id, parentTitle]);
  return { children, parent };
}
