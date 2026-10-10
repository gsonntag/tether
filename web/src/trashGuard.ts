// One-click session removal in the sidebar has no confirm and no undo, by choice. But once a row
// goes, the next one slides up under a mouse that hasn't moved, trash button showing, so a
// double-click removed two sessions. Two guards:
// - a trash click on a *different* row within GRACE_MS of the last one is ignored;
// - other rows keep their trash hidden until the pointer actually moves.

import { useSyncExternalStore } from "react";

export const GRACE_MS = 500;

export type TrashGuard = { at: number; id: string; x: number; y: number; holding: boolean };
export const guard: TrashGuard = { at: 0, id: "", x: 0, y: 0, holding: false };

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Records a trash click on session `id`; false when it should be ignored. */
export function allowTrashClick(id: string, at: { x: number; y: number }, now = Date.now(), g: TrashGuard = guard): boolean {
  if (g.id && g.id !== id && now - g.at < GRACE_MS) return false;
  Object.assign(g, { at: now, id, x: at.x, y: at.y });
  return true;
}

/** Whether the pointer has left the spot of the last trash click (so hover means something again). */
export const pointerMoved = (p: { x: number; y: number }, g: TrashGuard = guard) => Math.abs(p.x - g.x) > 2 || Math.abs(p.y - g.y) > 2;

function onMove(e: PointerEvent) {
  if (!pointerMoved({ x: e.clientX, y: e.clientY })) return;
  guard.holding = false;
  window.removeEventListener("pointermove", onMove);
  notify();
}

/** After a removal by mouse: hide trash buttons on the other rows until the pointer moves. */
export function holdTrashUntilMove() {
  if (typeof window === "undefined" || !window.matchMedia("(hover: hover)").matches) return; // touch: nothing slides under a hover
  guard.holding = true;
  window.addEventListener("pointermove", onMove);
  notify();
}

/** True while trash buttons should stay hidden on rows the pointer didn't move onto. */
export const useTrashHeld = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => guard.holding,
  );
