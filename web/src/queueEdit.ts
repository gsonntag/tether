// What the panel for an edit whose message left the queue may offer (components/QueueList.tsx),
// pure so it's tested without a page.
//
// A message that left the queue went out to the harness or was cancelled (LiveState.queueGone, from
// the runner) — or it is only briefly out: going out right now, or stopped while the harness started
// and about to come back. Until the runner says which, nothing can be sent or copied, or the same
// words could go twice (the original coming back, and the edit sent beside it). A runner restart
// forgets the record: after `UNKNOWN_MS` with no word, the edit is offered anyway.

import type { LiveState } from "../../shared/transcript";

export const UNKNOWN_MS = 10_000;

export type LostEdit =
  /** the message is in the queue: the edit is on it */
  | { show: false }
  /** out of the queue; `kind` once known; `ready`: Send and Copy may be offered */
  | { show: true; kind?: "sent" | "cancelled"; ready: boolean };

export function lostEdit(o: { id: string; queue: LiveState["queue"]; gone: LiveState["queueGone"]; outForMs: number }): LostEdit {
  if (o.queue.some((m) => m.id === o.id)) return { show: false };
  const kind = o.gone?.find((g) => g.id === o.id)?.how;
  return { show: true, ...(kind ? { kind } : {}), ready: !!kind || o.outForMs >= UNKNOWN_MS };
}
