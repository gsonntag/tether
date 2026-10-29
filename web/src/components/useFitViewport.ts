import { useEffect, type RefObject } from "react";

/**
 * Keeps an element's bottom within what is actually visible: with a phone's keyboard open the
 * visual viewport is shorter than the layout, and the composer must stay fully on screen.
 */
export function useFitViewport(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      const room = vv.offsetTop + vv.height - el.getBoundingClientRect().top;
      el.style.maxHeight = room > 0 ? `${Math.floor(room)}px` : "";
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, [ref]);
}
