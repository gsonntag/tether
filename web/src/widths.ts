// Widths the person dragged (the sidebar, the terminal panel), kept per device. Nothing stored means
// the layout's own default.

/** The transcript never gets narrower than this. */
export const TRANSCRIPT_MIN = 300;
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const PANEL_MIN = 320;

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
