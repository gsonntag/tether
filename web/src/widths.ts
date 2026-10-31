// Widths the person dragged (the sidebar, the terminal panel), kept per device. Nothing stored means
// the layout's own default.

/** The transcript never gets narrower than this. */
export const TRANSCRIPT_MIN = 300;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
/** What the sidebar leaves for the panel when it is dragged wide. */
export const PANEL_MIN = 320;

/** A panel beside the transcript has at least this many columns; with less room it covers the chat. */
export const PANEL_COLS = 60;
/** What isn't columns in a side panel: its list of terminals (app.css), border, xterm's scrollbar. */
const PANEL_LIST = 172;
/** Below this height a window is a phone on its side: there is no height to share. */
export const SHORT_HEIGHT = 500;
const PHONE_WIDTH = 767;

/** The width that gives a side panel PANEL_COLS columns of `cell` px each. */
export const panelFloor = (cell: number) => Math.ceil(PANEL_LIST + PANEL_COLS * cell);

/** Whether the terminal panel goes over the chat: `row` is the width the transcript and panel share. */
export const panelCovers = (a: { row: number; width: number; height: number; cell: number }) => a.width <= PHONE_WIDTH || a.height < SHORT_HEIGHT || panelMax(a.row) < panelFloor(a.cell);

/** Within the bounds; when they cross (a tiny window) the minimum wins. */
export const clampWidth = (w: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, w)));

/** The sidebar leaves room for the transcript and a terminal panel beside it. */
export const sidebarMax = (viewport: number) => Math.min(SIDEBAR_MAX, viewport - TRANSCRIPT_MIN - PANEL_MIN);

/** The panel shares its row with the transcript only. */
export const panelMax = (row: number) => row - TRANSCRIPT_MIN;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readWidth(store: Store, key: string): number | undefined {
  try {
    const raw = store.getItem(key);
    const w = raw === null ? NaN : Number(raw);
    return Number.isFinite(w) && w > 0 ? w : undefined;
  } catch {
    return undefined;
  }
}

/** `undefined` forgets it (back to the default). */
export function writeWidth(store: Store, key: string, w: number | undefined) {
  try {
    if (w === undefined) store.removeItem(key);
    else store.setItem(key, String(w));
  } catch {}
}
