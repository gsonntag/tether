// Arrow keys in a segmented choice (role="radiogroup"), as a native radio group has them: Left/Up
// picks the one before, Right/Down the one after (wrapping), and focus follows the pick.

import type { KeyboardEvent } from "react";

/** The value an arrow key moves to from `current`, or undefined for any other key. */
export function arrowPick<T>(values: readonly T[], current: T, key: string): T | undefined {
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  if (!step || !values.length) return undefined;
  const i = Math.max(0, values.indexOf(current));
  return values[(i + step + values.length) % values.length];
}

/** onKeyDown for a radiogroup of buttons in `values` order. */
export const radioKeys =
  <T,>(values: readonly T[], current: T, pick: (v: T) => void) =>
  (e: KeyboardEvent<HTMLElement>) => {
    const next = arrowPick(values, current, e.key);
    if (next === undefined) return;
    e.preventDefault();
    pick(next);
    (e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[values.indexOf(next)])?.focus();
  };
