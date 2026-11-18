// The session's PR in its header (SPEC §10 Git actions): number, state and checks, linking to it.
// Asked of the runner (gitPr, which caches gh's answer) when the session opens, again when a turn
// ends, and every 2 minutes while the Changes pane is open; nothing polls otherwise. No PR, no chip.

import { useCallback, useEffect, useRef, useState } from "react";
import type { PrLookup } from "../../../shared/gitActions";
import type { RunStatus } from "../../../shared/transcript";
import { rpc } from "../connection";
import { prChip } from "../gitActions";
import "./GitBar.css";
import { useStore } from "../store";

export const PR_POLL_MS = 2 * 60_000;

/** The session's PR, kept fresh as the top says. `enabled`: the runner has git actions. */
export function usePr(runnerId: string, sessionId: string, o: { enabled: boolean; paneOpen: boolean; status: RunStatus }) {
  const [pr, setPr] = useState<PrLookup>();
  const linkOpen = useStore((s) => s.link === "open");
  const seq = useRef(0);
  const refresh = useCallback(
    async (fresh: boolean) => {
      const n = ++seq.current;
      try {
        const l = await rpc(runnerId, "gitPr", { sessionId, ...(fresh ? { fresh: true } : {}) });
        if (n === seq.current) setPr(l);
      } catch {}
    },
    [runnerId, sessionId],
  );
  /** an action's answer, or a request to ask again */
  const update = useCallback(
    (fresh: boolean, l?: PrLookup) => {
      if (l) {
        seq.current++;
        setPr(l);
      } else void refresh(fresh);
    },
    [refresh],
  );
  useEffect(() => {
    setPr(undefined);
  }, [runnerId, sessionId]);
  useEffect(() => {
    if (o.enabled && linkOpen) void refresh(false);
  }, [o.enabled, linkOpen, refresh]);
  const busy = o.status !== "idle";
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && o.enabled) void refresh(true);
    wasBusy.current = busy;
  }, [busy]);
  useEffect(() => {
    if (!o.enabled || !o.paneOpen || !linkOpen) return;
    const t = setInterval(() => void refresh(false), PR_POLL_MS);
    return () => clearInterval(t);
  }, [o.enabled, o.paneOpen, linkOpen, refresh]);
  return { pr, update };
}

export function PrChip({ lookup }: { lookup?: PrLookup }) {
  const pr = lookup?.pr;
  if (!pr) return null;
  const c = prChip(pr);
  return (
    <a className={`t-chip t-chip-pr ${c.tone}`} href={pr.url} target="_blank" rel="noopener noreferrer" title={c.title} aria-label={`Pull request ${c.text}`}>
      {c.text}
    </a>
  );
}
