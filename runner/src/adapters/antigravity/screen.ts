// Reads Antigravity's TUI (`agy`, checked on 1.5.13) for the terminal handoff (SPEC §8): whether a
// question is up, and whether it sits at its prompt. Conservative, like Claude's: only a clearly
// recognized prompt box counts.
//
// At its prompt, the bottom of the screen is a rule, the box ("> " and what's typed), a rule, and a
// status line: "? for shortcuts" when idle, "esc to cancel" while it works (a braille spinner above
// the box too). A permission prompt or the trust question replaces the box with a numbered list and
// "↑/↓ Navigate".

import type { QuitStep, ScreenRead } from "../../core/adapter";

const RULE = /^\s*─{8,}\s*$/;
const SPINNER = /^\s*[⠁-⣿]\s+\S/u;
/** The empty box's hint after a mode change ("Accept-edits mode: file edits auto-approved (shift+tab to cycle)"), which isn't typed text. */
const PLACEHOLDER = /^[\w-]+ mode: .*\(shift\+tab to cycle\)$/i;
const ASKING = /Requesting permission|trust this folder|Run this command\?|Allow this|Do you want to/i;

export function agyScreen(screen: string): ScreenRead {
  const lines = screen.replace(/\s+$/, "").split("\n");
  // The box: the last "> " line right under a rule, closed by a rule with at most a few lines under it.
  let box = -1;
  let close = -1;
  for (let i = lines.length - 1; i > 0 && box < 0; i--) {
    if (!/^\s*>(\s|$)/.test(lines[i]!) || !RULE.test(lines[i - 1]!)) continue;
    let k = i + 1;
    while (k < Math.min(lines.length, i + 20) && !RULE.test(lines[k]!)) k++;
    if (k >= lines.length || lines.length - k - 1 > 3) continue;
    box = i;
    close = k;
  }
  if (box < 0) {
    const tail = lines.slice(-30);
    if (tail.some((l) => /↑\/↓ Navigate/.test(l))) return { state: tail.some((l) => ASKING.test(l)) ? "asking" : "picker" };
    return { state: "unknown" };
  }
  const status = lines.slice(close + 1).join("\n");
  let typed = lines
    .slice(box, close)
    .map((l, n) => l.replace(n === 0 ? /^\s*>\s?/ : /^\s+/, ""))
    .join("\n")
    .trim();
  if (PLACEHOLDER.test(typed)) typed = "";
  const busy = /esc to cancel/i.test(status) || lines.slice(Math.max(0, box - 6), box - 1).some((l) => SPINNER.test(l));
  return { state: busy ? "busy" : "idle", input: typed, prompt: "normal" };
}

/**
 * Quitting the TUI whatever it shows: Esc closes a dialog (declining a permission prompt) or stops a
 * turn; Ctrl-C clears what's typed, the next arms "press ctrl+c again to exit", and the last exits.
 */
export const AGY_QUIT: QuitStep[] = [{ keys: ["Escape"] }, { waitMs: 400 }, { keys: ["C-c"] }, { waitMs: 400 }, { keys: ["C-c"] }, { waitMs: 400 }, { keys: ["C-c"] }];
/** At its plain, empty prompt: two Ctrl-Cs. */
export const AGY_EXIT: QuitStep[] = [{ keys: ["C-c"] }, { waitMs: 300 }, { keys: ["C-c"] }];
