// Line comments on the Changes pane's diff (SPEC §10 Changes): what a comment is, how a selection
// of diff lines becomes one, the drafts kept in this browser per session, and the one message they
// go to the agent as (put in the composer, editable before it's sent).

import type { DiffScope, NumberedLine } from "../../shared/gitDiff";

export interface LineComment {
  id: string;
  /** from the repo's root */
  path: string;
  /** `new`: line numbers in the file as it is now; `old`: as it was (only removed lines selected) */
  side: "new" | "old";
  start: number;
  end: number;
  /** the lines it's about, as the diff showed them: "+added", "-removed", " context" */
  lines: string[];
  text: string;
  scope: DiffScope;
}

/** What a selection of diff lines points at: undefined when it holds no numbered line. */
export function selectionOf(lines: NumberedLine[], a: number, b: number): Pick<LineComment, "side" | "start" | "end" | "lines"> | undefined {
  const picked = lines.slice(Math.min(a, b), Math.max(a, b) + 1).filter((l) => l.op !== "\\");
  if (!picked.length) return undefined;
  const news = picked.flatMap((l) => (l.new === undefined ? [] : [l.new]));
  const side = news.length ? "new" : "old";
  const nums = news.length ? news : picked.flatMap((l) => (l.old === undefined ? [] : [l.old]));
  return { side, start: Math.min(...nums), end: Math.max(...nums), lines: picked.map((l) => `${l.op}${l.text}`) };
}

/** `path:12`, `path:12-15`; removed lines say so (their numbers are the old file's). */
export function location(c: Pick<LineComment, "path" | "side" | "start" | "end">): string {
  const lines = c.start === c.end ? `${c.start}` : `${c.start}-${c.end}`;
  return `${c.path}:${lines}${c.side === "old" ? " (removed)" : ""}`;
}

/** Comments in file order, then by line. */
export const inFileOrder = (list: LineComment[]) =>
  list
    .map((c, i) => [c, i] as const)
    .sort(([a, i], [b, j]) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.side !== b.side ? (a.side === "new" ? -1 : 1) : a.start - b.start || i - j))
    .map(([c]) => c);

/** A fence longer than any run of backticks in the lines. */
function fence(lines: string[]) {
  const longest = Math.max(0, ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length))));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The comments as one message: each one's `path:line` with its lines as a diff block, then what was
 * said. Empty comments are left out; "" when there's nothing to send.
 */
export function reviewMessage(list: LineComment[]): string {
  const blocks = inFileOrder(list)
    .filter((c) => c.text.trim())
    .map((c) => {
      const f = fence(c.lines);
      return `\`${location(c)}\`\n${f}diff\n${c.lines.join("\n")}\n${f}\n${c.text.trim()}`;
    });
  if (!blocks.length) return "";
  return `${blocks.length === 1 ? "A comment" : "Comments"} on the changes:\n\n${blocks.join("\n\n")}`;
}

// ---------- drafts (this browser) ----------

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const reviewKey = (runnerId: string, sessionId: string) => `tether.review.${runnerId}.${sessionId}`;

/** Comments from storage, cleaned up: what isn't a comment is dropped. */
export function cleanComments(v: unknown): LineComment[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c: any): LineComment[] => {
    if (!c || typeof c.id !== "string" || typeof c.path !== "string" || typeof c.text !== "string") return [];
    const start = Number(c.start);
    const end = Number(c.end);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return [];
    return [{
      id: c.id,
      path: c.path,
      side: c.side === "old" ? "old" : "new",
      start,
      end,
      lines: Array.isArray(c.lines) ? c.lines.filter((l: unknown) => typeof l === "string") : [],
      text: c.text,
      scope: c.scope === "branch" ? "branch" : "uncommitted",
    }];
  });
}

export function readComments(store: Store, key: string): LineComment[] {
  try {
    return cleanComments(JSON.parse(store.getItem(key) ?? "[]"));
  } catch {
    return [];
  }
}

/** None left: the key goes. */
export function writeComments(store: Store, key: string, list: LineComment[]) {
  try {
    if (list.length) store.setItem(key, JSON.stringify(list));
    else store.removeItem(key);
  } catch {}
}
