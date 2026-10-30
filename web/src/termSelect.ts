// Selecting in a terminal while tmux has the mouse (`mouse on`): xterm reports every press and drag
// to tmux and selects only when the press carries the force-selection modifier. So a plain press
// waits here. Released in place it is a click and goes to tmux as usual, press then release, which
// keeps clicks working in whatever runs inside; moved, it goes to xterm with that modifier and is a
// browser selection. Shift-drag and Option-drag go straight to xterm, as they always did.

/** Pixels the mouse moves before a press is a drag. */
const DRAG_PX = 4;

/** What a finished selection copies: nothing for an empty or blank one. */
export const copyable = (selection: string) => (selection.trim() ? selection : undefined);

export const isPlainPress = (e: Pick<MouseEvent, "button" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">) => e.button === 0 && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;

export const isDrag = (a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) >= DRAG_PX;

/** xterm's force-selection modifier (Alt elsewhere means a column selection). */
export const forceSelection = (platform: string): MouseEventInit => (/Mac|iPod|iPhone|iPad/.test(platform) ? { altKey: true } : { shiftKey: true });

/** `active`: tmux (or anything else) is taking the mouse now. Returns the undo. */
export function plainDragSelects(el: HTMLElement, active: () => boolean, focus: () => void): () => void {
  let held: MouseEvent | undefined;
  let replaying = false;
  const release = (init?: MouseEventInit) => {
    const e = held!;
    held = undefined;
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("mouseup", up, true);
    replaying = true;
    e.target!.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        detail: e.detail,
        button: 0,
        buttons: 1,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        ...init,
      }),
    );
    replaying = false;
  };
  const move = (e: MouseEvent) => {
    if (held && isDrag(held, e)) release(forceSelection(navigator.platform));
  };
  // Still ahead of xterm: the press reaches it first, then this same mouseup as its release.
  const up = () => held && release();
  const down = (e: MouseEvent) => {
    if (replaying || held || !isPlainPress(e) || !active()) return;
    e.stopPropagation();
    e.preventDefault();
    focus();
    held = e;
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
  };
  el.addEventListener("mousedown", down, true);
  return () => {
    el.removeEventListener("mousedown", down, true);
    document.removeEventListener("mousemove", move, true);
    document.removeEventListener("mouseup", up, true);
  };
}
