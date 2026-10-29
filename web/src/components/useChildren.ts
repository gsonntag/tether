import { useEffect, useMemo, useState } from "react";
import { rpc } from "../connection";
import { childrenOf, mergeRows, type Row } from "../sessionList";
import { useStore } from "../store";

/**
 * A session's subagents: live ones from the broadcast summaries, past ones from the runner
 * (`listSessions {parentSessionId}`), fetched again when the live set or the parent's status changes.
 */
export function useChildren(runnerId: string | undefined, sessionId: string | undefined): Row[] {
  const summaries = useStore((s) => s.summaries);
  const linkOpen = useStore((s) => s.link === "open");
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
  return useMemo(() => mergeRows(stored.for === k ? stored.rows : [], live), [stored, live, k]);
}
