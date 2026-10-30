import { createContext, useContext, useState } from "react";
import { fetchFullPart } from "../../../shared/limits";
import type { Part } from "../../../shared/transcript";
import { rpc } from "../connection";
import { RowStore } from "../rowStore";

/** Which session the transcript below belongs to (for fullPart and links to subagents). */
export const SessionCtx = createContext<{ runnerId: string; sessionId: string; projectPath?: string }>({ runnerId: "", sessionId: "" });
export const useSessionCtx = () => useContext(SessionCtx);

const rows = new RowStore();

/**
 * useState for a row, under `key` (unique within the session), kept per session outside the row:
 * the transcript unmounts rows far from the viewport and mounts them again, and a card opened, a
 * part fetched whole or an image allowed must come back as the reader left it.
 */
export function useRowState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const { runnerId, sessionId } = useSessionCtx();
  const k = `${runnerId}\u0000${sessionId}\u0000${key}`;
  const [v, setV] = useState<T>(() => rows.get(k, initial));
  const set = (next: T | ((prev: T) => T)) => {
    // from the stored value, not this render's: an async load may finish after an unmount
    const val = typeof next === "function" ? (next as (prev: T) => T)(rows.get(k, initial)) : next;
    rows.set(k, val);
    setV(val);
  };
  return [v, set];
}

/**
 * Parts of one message fetched whole (`fullPart`), by index: a part cut short, or one the message
 * left out. `load(i)` fetches one; loading and error say how it went.
 */
export function useFullParts(msgId: string) {
  const { runnerId, sessionId } = useSessionCtx();
  const [full, setFull] = useRowState<Record<number, Part>>(`full:${msgId}`, {});
  const [loading, setLoading] = useRowState<number[]>(`loading:${msgId}`, []);
  const [error, setError] = useRowState<string | undefined>(`error:${msgId}`, undefined);
  const load = async (indexes: number[]) => {
    setError(undefined);
    setLoading((l) => [...l, ...indexes]);
    try {
      for (const part of indexes) {
        const got = await fetchFullPart((offset) => rpc(runnerId, "fullPart", { sessionId, msgId, part, offset }));
        setFull((f) => ({ ...f, [part]: got }));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading((l) => l.filter((x) => !indexes.includes(x)));
    }
  };
  return { full, loading, error, load };
}
