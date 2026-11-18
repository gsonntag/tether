// Side chats (SPEC §16a): `/btw <question>` in a session's box, or Side chat in its menu, asks a
// fork of the session that runs read-only, beside it, so the session itself keeps working. Bring
// back asks the side chat for a summary and puts it in the session's box. Shared so the page and
// the runner word it the same.

import type { HarnessCommand } from "./commands";
import { FROM_TETHER } from "./fromTether";

/** Tether's own entry in a session's `/` menu: Tether answers it, it never reaches the harness. */
export const BTW_COMMAND: HarnessCommand = { name: "btw", args: "<question>", description: "Ask on the side: a read-only fork answers while this session works" };

/** `/btw …` typed in a session's box (any case): its question ("" for none), else undefined. */
export function parseBtw(text: string): string | undefined {
  const m = text.trim().match(/^\/btw(?:\s+([\s\S]*))?$/i);
  return m ? (m[1] ?? "").trim() : undefined;
}

/** A side chat's title: its question, short, else its session's. */
export function sideChatTitle(question: string, parentTitle: string): string {
  const q = question.replace(/\s+/g, " ").trim();
  const what = q ? (q.length > 60 ? `${q.slice(0, 59).trimEnd()}…` : q) : parentTitle.trim() || "Untitled";
  return `Side chat: ${what}`;
}

/** Bring back's turn in the side chat: Tether's, so the chat shows it as Tether's line. */
export const BRING_BACK_PROMPT = `${FROM_TETHER}Bring back: summarize this side chat for the main session in at most 5 short lines: what was asked, what you found, and what the main session should do about it, if anything. Only the summary, no preamble.`;

/** What Bring back puts in the main session's box, to edit and send. */
export const bringBackDraft = (summary: string) => `From a side chat:\n\n${summary.trim()}`;

/** Why a side chat's request to do something was refused: what its agent reads. */
export const SIDE_READ_ONLY = "This is a read-only side chat: it can't change files, run anything that changes them, or leave its mode. Answer from what you can read.";

/** Why a side chat's mode can't change. */
export const SIDE_STAYS = "A side chat stays read-only.";
