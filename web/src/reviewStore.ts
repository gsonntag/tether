// The Changes pane's comments (review.ts) as live state over this browser's storage, per session:
// the pane draws them, and the session's composer settles the ones a sent message carried.

import { useMemo } from "react";
import { create } from "zustand";
import { afterSend, readComments, reviewKey, writeComments, type LineComment } from "./review";

const useReviews = create<{ lists: Record<string, LineComment[]>; unsaved: Record<string, boolean> }>(() => ({ lists: {}, unsaved: {} }));

const current = (key: string) => useReviews.getState().lists[key] ?? readComments(localStorage, key);

export function useComments(key: string): LineComment[] {
  const l = useReviews((s) => s.lists[key]);
  return useMemo(() => l ?? readComments(localStorage, key), [l, key]);
}

/** Whether the latest change couldn't be stored (it lasts only until this page reloads). */
export const useUnsaved = (key: string) => useReviews((s) => !!s.unsaved[key]);

export function updateComments(key: string, f: (list: LineComment[]) => LineComment[]) {
  const was = current(key);
  const list = f(was);
  if (list === was) return;
  const ok = writeComments(localStorage, key, list);
  useReviews.setState((s) => ({ lists: { ...s.lists, [key]: list }, unsaved: { ...s.unsaved, [key]: !ok } }));
}

/** A message went out from the session's composer: the comments it carried are done. */
export function reviewSent(runnerId: string, sessionId: string, text: string) {
  const key = reviewKey(runnerId, sessionId);
  const list = current(key);
  const next = afterSend(list, text);
  if (next.length !== list.length) updateComments(key, () => next);
}
