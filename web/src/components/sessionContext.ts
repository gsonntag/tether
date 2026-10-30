import { createContext, useContext, useState } from "react";
import { fetchFullPart } from "../../../shared/limits";
import type { Part } from "../../../shared/transcript";
import { rpc } from "../connection";
import { partRev, RowStore } from "../rowStore";

/** Which session the transcript below belongs to (for fullPart and links to subagents). */
export const SessionCtx = createContext<{ runnerId: string; sessionId: string; projectPath?: string }>({ runnerId: "", sessionId: "" });
export const useSessionCtx = () => useContext(SessionCtx);

const rows = new RowStore();
const rowScope = (runnerId: string, sessionId: string) => `${runnerId}\u0000${sessionId}`;
/** The session's view closed: what its rows kept goes with it. */
export const dropRows = (runnerId: string, sessionId: string) => rows.drop(rowScope(runnerId, sessionId));

/**
 * useState for a row, under `key` (unique within the session), kept per session outside the row:
 * the transcript unmounts rows far from the viewport and mounts them again, and a card opened, a
 * part fetched whole or an image allowed must come back as the reader left it.
 */
export function useRowState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const { runnerId, sessionId } = useSessionCtx();
  const scope = rowScope(runnerId, sessionId);
  const [v, setV] = useState<T>(() => rows.get(scope, key, initial));
  const set = (next: T | ((prev: T) => T)) => {
    // from the stored value, not this render's: an async load may finish after an unmount
    const val = typeof next === "function" ? (next as (prev: T) => T)(rows.get(scope, key, initial)) : next;
    rows.set(scope, key, val);
    setV(val);
  };
  return [v, set];
}

/**
 * Parts of one message fetched whole (`fullPart`), by index: a part cut short, or one the message
 * left out. `load(i)` fetches one; loading and error say how it went. A copy of a part whose
 * content has changed since (it was still growing) is dropped: Show all fetches it again.
 */
export function useFullParts(msgId: string, parts: Part[]) {
  const { runnerId, sessionId } = useSessionCtx();
  const [stored, setStored] = useRowState<Record<number, { rev: string; part: Part }>>(`full:${msgId}`, {});
  const [loading, setLoading] = useRowState<number[]>(`loading:${msgId}`, []);
  const [error, setError] = useRowState<string | undefined>(`error:${msgId}`, undefined);
  const full: Record<number, Part> = {};
  for (const [i, e] of Object.entries(stored)) if (e.rev === partRev(parts[Number(i)])) full[Number(i)] = e.part;
  const load = async (indexes: number[]) => {
    setError(undefined);
    setLoading((l) => [...l, ...indexes]);
    try {
      for (const part of indexes) {
        const rev = partRev(parts[part]);
        const got = await fetchFullPart((offset) => rpc(runnerId, "fullPart", { sessionId, msgId, part, offset }));
        setStored((f) => ({ ...f, [part]: { rev, part: got } }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading((l) => l.filter((x) => !indexes.includes(x)));
    }
  };
  return { full, loading, error, load };
}
