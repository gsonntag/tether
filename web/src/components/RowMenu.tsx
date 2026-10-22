// Pieces the sidebar's and Home's session rows share: one context menu per list (right-click; a
// long press opens it as a sheet on touch) and the trailing "ago" that a hover action covers.

import { useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import { ContextMenu, type ContextMenuOption } from "@astryxdesign/core/ContextMenu";
import { useContainerReveal, useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";

export type RowMenuItems = { title: string; items: ContextMenuOption[] };

/** The attribute a row carries so its list's menu knows which row it was opened on. */
export const rowMenuKey = (key: string) => ({ "data-row-menu": key });

/**
 * One ContextMenu for a whole list: right-click (desktop) or long-press (touch, as a sheet) on a
 * row marked with rowMenuKey opens that row's actions.
 */
export function RowMenus({ itemsFor, children }: { itemsFor: (key: string) => RowMenuItems | undefined; children: ReactNode }) {
  const [key, setKey] = useState<string>();
  const openedAt = useRef(0);
  const touch = useRef(false);
  const open = useRef(false);
  const pick = (e: SyntheticEvent) => {
    // Presses inside the open menu (React portals bubble here) keep its row.
    if (open.current || !(e.currentTarget as HTMLElement).contains(e.target as Node)) return;
    if (e.type === "pointerdown") touch.current = (e.nativeEvent as PointerEvent).pointerType !== "mouse";
    const k = (e.target as HTMLElement | null)?.closest?.("[data-row-menu]")?.getAttribute("data-row-menu") ?? undefined;
    setKey(k);
    // Not on a row (or a row without actions): the browser's own menu.
    if (e.type === "contextmenu" && (!k || !itemsFor(k))) e.stopPropagation();
  };
  const menu = key ? itemsFor(key) : undefined;
  // The tap that ends a long press: the browser may still send its click, onto the row (opening it)
  // or the sheet's backdrop (closing it at once). A click with no press since the menu opened is that one.
  const pressedSinceOpen = useRef(true);
  const guard = {
    onPointerDownCapture: () => {
      if (open.current) pressedSinceOpen.current = true;
    },
    onClickCapture: (e: SyntheticEvent) => {
      if (touch.current && !pressedSinceOpen.current && Date.now() - openedAt.current < 1500) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };
  return (
    <VStack {...(guard as {})}>
      <ContextMenu
        label={menu?.title ?? "Session actions"}
        presentation="adaptive"
        size="md"
        menuWidth="calc(var(--spacing-12) * 4)"
        items={menu?.items ?? []}
        onOpenChange={(o) => {
          open.current = o;
          if (o) {
            openedAt.current = Date.now();
            pressedSinceOpen.current = false;
          }
        }}
        {...({ onContextMenuCapture: pick, onPointerDownCapture: pick } as {})}
      >
        {children}
      </ContextMenu>
    </VStack>
  );
}

/** Touch screens have no hover: what hover reveals is shown there, beside what it would cover. */
export const useCoarse = () => useMediaQuery("(any-pointer: coarse)");

/**
 * A row's trailing time with an action over it, shown on hover or focus (`action` is an IconButton).
 * Touch screens show both, side by side. Spread `container` (from useContainerReveal) on the row.
 */
export function AgoWithAction({ ago, action, reveal, isShown }: { ago: ReactNode; action?: ReactNode; reveal: ReturnType<typeof useContainerReveal>; isShown?: boolean }) {
  const coarse = useCoarse();
  if (!action) return <>{ago}</>;
  if (coarse)
    return (
      <HStack gap={1} vAlign="center">
        {ago}
        {action}
      </HStack>
    );
  return (
    <HStack vAlign="center" hAlign="end" style={{ position: "relative" }}>
      <HStack {...reveal.getContentRevealProps({ isRevealInverted: true, forceVisibility: isShown ? "hidden" : undefined })}>{ago}</HStack>
      <HStack
        {...reveal.getContentRevealProps({ forceVisibility: isShown ? "shown" : undefined })}
        style={{ ...reveal.getContentRevealProps({ forceVisibility: isShown ? "shown" : undefined }).style, position: "absolute", insetInlineEnd: 0 }}
      >
        {action}
      </HStack>
    </HStack>
  );
}

/**
 * A row's title that is also what opens it: the whole row hands its clicks to it (ListItem's
 * interactiveRef), so buttons inside the row stay buttons of their own.
 */
export function TitleLink({ title, onOpen, linkRef, weight = "medium" }: { title: string; onOpen: () => void; linkRef: React.RefObject<HTMLButtonElement | null>; weight?: "normal" | "medium" | "semibold" }) {
  return (
    <Link ref={linkRef as React.Ref<HTMLButtonElement>} color="primary" weight={weight} maxLines={1} display="block" onClick={onOpen}>
      {title}
    </Link>
  );
}
