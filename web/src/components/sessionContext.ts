import { createContext, useContext, useState } from "react";
import { fetchFullPart } from "../../../shared/limits";
import type { Part } from "../../../shared/transcript";
import { rpc } from "../connection";

/** Which session the transcript below belongs to (for fullPart and links to subagents). */
export const SessionCtx = createContext<{ runnerId: string; sessionId: string; projectPath?: string }>({ runnerId: "", sessionId: "" });
export const useSessionCtx = () => useContext(SessionCtx);

/**
 * Parts of one message fetched whole (`fullPart`), by index: a part cut short, or one the message
 * left out. `load(i)` fetches one; loading and error say how it went.
 */
export function useFullParts(msgId: string) {
  const { runnerId, sessionId } = useSessionCtx();
  const [full, setFull] = useState<Record<number, Part>>({});
  const [loading, setLoading] = useState<number[]>([]);
  const [error, setError] = useState<string>();
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
