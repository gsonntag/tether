// The Home agent's chat expanded to the whole window (HomeChat.tsx), kept per device.

const KEY = "tether.homeChatExpanded";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const local = (): Store | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

export function loadExpanded(s: Store | undefined = local()): boolean {
  try {
    return s?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveExpanded(on: boolean, s: Store | undefined = local()) {
  try {
    if (on) s?.setItem(KEY, "1");
    else s?.removeItem(KEY);
  } catch {}
}

/**
 * Whether an Escape keydown collapses it: not one something else took (the composer stopping a
 * turn, a menu closing), and not one meant for a popover or dialog that's open over it.
 */
export function escapeCollapses(e: { key: string; defaultPrevented: boolean; isComposing?: boolean }, layerOpen: boolean): boolean {
  return e.key === "Escape" && !e.defaultPrevented && !e.isComposing && !layerOpen;
}
