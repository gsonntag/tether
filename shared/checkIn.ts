// The Home agent's check-in (runner/src/modules/homeAgent/checkIn.ts) asks a session to end its
// reply with a machine line, `TETHER-CHECK-IN: {json}`. Tether reads that line from the stored reply
// as it is; people never see it: the transcript, the previews of a session's last reply (list_sessions,
// session_status, reports, texts) show the reply without it, and a short status in its place.

/** The line a check-in answer ends with. */
export const ANSWER_TAG = "TETHER-CHECK-IN:";

export interface Answer {
  done: boolean;
  merged: boolean;
  /** not merged because there was nothing to keep: discarded at the person's request, local or data-only work, research */
  nothingToMerge?: boolean;
  /** no worktree it created is left; undefined: it didn't say */
  cleanedUp?: boolean;
  branch?: string;
  /** the branch the work was meant to land in (main, or e.g. a deploy branch) */
  target?: string;
  worktree?: string;
  note?: string;
}

/** The answer in a reply: its last tagged line, if that holds the fields. */
export function parseAnswer(reply: string | undefined): Answer | undefined {
  if (!reply) return undefined;
  const lines = reply.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i]!.indexOf(ANSWER_TAG);
    if (at < 0) continue;
    let json = lines[i]!.slice(at + ANSWER_TAG.length).trim().replace(/`+$/, "").trim();
    // A model sometimes puts the JSON on the following lines.
    if (!json.startsWith("{")) json = lines.slice(i + 1).join("\n").replace(/```(json)?/g, "").trim();
    try {
      const v = JSON.parse(json.slice(0, json.lastIndexOf("}") + 1));
      if (typeof v?.done !== "boolean" || typeof v?.merged !== "boolean") return undefined;
      const s = (x: unknown) => (typeof x === "string" && x.trim() && x.trim() !== "null" ? x.trim().slice(0, 300) : undefined);
      return { done: v.done, merged: v.merged, ...(v.nothing_to_merge === true ? { nothingToMerge: true } : {}), ...(typeof v.cleaned_up === "boolean" ? { cleanedUp: v.cleaned_up } : {}), branch: s(v.branch), ...(s(v.target) ? { target: s(v.target) } : {}), worktree: s(v.worktree), note: s(v.note) };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Where the JSON that follows a tag on its own line ends: the line index just past its closing brace
 * (strings and escapes skipped), or the end of the text when it never closes (a reply still
 * streaming, or a broken one). Blank lines and a ``` fence before the brace belong to it.
 */
function jsonEnd(lines: string[], from: number): number {
  let depth = 0;
  let started = false;
  let inString = false;
  let escaped = false;
  for (let i = from; i < lines.length; i++) {
    const l = lines[i]!;
    if (!started && !l.trim().startsWith("{") && !/^\s*(```\w*)?\s*$/.test(l)) return i;
    for (const ch of l) {
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = started;
      else if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}" && started && --depth === 0) return i + 1;
    }
  }
  return lines.length;
}

export interface Stripped {
  /** the reply as people read it: every tagged line (and JSON that went on the next lines) left out */
  text: string;
  /** it had at least one tagged line */
  found: boolean;
  /** the answer those lines gave (the last one counts), when it could be read */
  answer?: Answer;
}

/**
 * A reply without its check-in lines, wherever they are and however many: the tag to the end of its
 * line (text before it on the line stays), the JSON when it went on the following lines, and a code
 * fence left empty by that. The text is unchanged when it has no tag.
 */
export function stripCheckIn(reply: string): Stripped {
  if (!reply.includes(ANSWER_TAG)) return { text: reply, found: false };
  const answer = parseAnswer(reply);
  const lines = reply.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const at = l.indexOf(ANSWER_TAG);
    if (at < 0) {
      out.push(l);
      continue;
    }
    const before = l.slice(0, at).replace(/[`*_\s>-]+$/, "").trimEnd();
    // Only backticks or a list/quote mark before it: nothing worth keeping.
    if (before.replace(/[`*_\s>-]/g, "")) out.push(before);
    const rest = l.slice(at + ANSWER_TAG.length).trim();
    if (!rest.startsWith("{")) {
      const end = jsonEnd(lines, i + 1);
      const fenced = lines.slice(i + 1, end).some((x) => /^\s*```/.test(x));
      // the fence the JSON opened closes on the line after it
      i = fenced && end < lines.length && /^\s*```\s*$/.test(lines[end]!) ? end : end - 1;
    }
  }
  const text = out
    .join("\n")
    // a fence that held only the JSON
    .replace(/(^|\n)[ \t]*```[\w-]*[ \t]*\n(?:[ \t]*\n)*[ \t]*```[ \t]*(?=\n|$)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, found: true, ...(answer ? { answer } : {}) };
}

/** The answer in a few words, e.g. `done · merged · cleaned up`, `not merged: PR #12 open`. */
export function answerSummary(a: Answer | undefined): string {
  if (!a) return "answered";
  const note = a.note ? `: ${a.note}` : "";
  if (!a.done) return `not done${note}`;
  const what = a.merged ? (a.target ? `merged into ${a.target}` : "merged") : "nothing to merge";
  if (!a.merged && !a.nothingToMerge) return `done · not merged${note}`;
  if (a.cleanedUp === false) return `done · ${what} · not cleaned up${note}`;
  return `done · ${what}${a.cleanedUp ? " · cleaned up" : ""}`;
}

/** The status shown in place of the tagged lines: `Check-in: done · merged · cleaned up`. */
export const checkInStatus = (a: Answer | undefined) => `Check-in: ${answerSummary(a)}`;

/**
 * A reply as it's previewed in text (list_sessions, session_status, reports, texts): without the
 * tagged lines, the status on a line of its own at the end in their place. Unchanged without a tag.
 */
export function replyForPeople(reply: string): string {
  const s = stripCheckIn(reply);
  if (!s.found) return reply;
  return s.text ? `${s.text}\n${checkInStatus(s.answer)}` : checkInStatus(s.answer);
}
