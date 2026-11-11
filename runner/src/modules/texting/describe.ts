// What a text about a request says, and what a reply to one means. An approval's text says in plain
// words what the agent wants to do and why it was flagged (summary.ts: never the raw command or the
// harness's warning, which stay in Tether behind the text's link), at most REQUEST_MAX characters; a
// question carries its options, a plan its title. Known secrets are redacted. Texts take short answers: y or n for an approval or a plan, a letter for a question. Anything else is
// the person talking to the agent: it goes to the agent as their words.

import type { Request, RequestAnswer } from "../../../../shared/transcript";
import { redact } from "../../credentials";
import { commandWords, flagWords, shortPath, toolWords } from "./summary";

/** How long an approval's or a plan's words may be (the "[n] " stamp and the link come on top). */
export const REQUEST_MAX = 200;

export const clip = (s: string, n: number) => {
  const t = redact(s).trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A request as a text: a short status for the picker, and the body. */
export function requestText(r: Request, agent: string): { status: string; body: string } {
  if (r.kind === "question") {
    const qs = r.questions?.length ? r.questions : [{ question: r.question ?? "", options: (r.options ?? []).map((label) => ({ label })) }];
    const shown = qs.slice(0, 4).map((q, i) => {
      const head = qs.length > 1 ? `${i + 1}. ` : "";
      const opts = q.options.slice(0, LETTERS.length).map((o, j) => `${LETTERS[j]}) ${clip(o.label, 80)}`).join("\n");
      return `${head}${clip(q.question, REQUEST_MAX)}${"multiSelect" in q && q.multiSelect ? " (pick any)" : ""}\n${opts}`;
    });
    const how = qs.length > 1 ? `Reply with a letter for each question, like "a c".` : "Reply with a letter, or your own answer.";
    return { status: "has a question", body: `${agent} asks:\n${shown.join("\n\n")}\n\n${how}` };
  }
  if (r.plan !== undefined) {
    // Its first line that says something ("# Plan" doesn't).
    const title = r.plan.split("\n").map((l) => l.replace(/^(\s*([#>*-]+|\d+[.)])\s*)+/, "").trim()).find((l) => l && !/^(the\s+)?(implementation\s+)?plan:?$/i.test(l)) ?? "";
    const ask = "Approve? y, or say what to change.";
    return { status: "has a plan to approve", body: `${clip(`${agent} has a plan to approve${title ? `: ${bare(title)}` : ""}`, REQUEST_MAX - ask.length - 2)}. ${ask}` };
  }
  const input = (r.input ?? {}) as Record<string, unknown>;
  const files = Array.isArray(input.files) ? input.files.flatMap((f: any) => str(f?.path) ?? str(f) ?? []) : [];
  const path = r.path ?? str(input.file_path) ?? str(input.path) ?? files[0];
  const command = r.command ?? str(input.command);
  const kind = r.toolKind ?? (command ? "shell" : undefined);
  let status: string;
  let what: string;
  let flag: string | undefined;
  if (r.network) {
    status = "wants network access";
    what = "use the internet";
  } else if (kind === "shell" && command) {
    status = "wants to run a command";
    what = commandWords(command, str(input.description));
    flag = flagWords(r.reason, command);
  } else if ((kind === "edit" || kind === "write") && (path || files.length)) {
    status = files.length > 1 ? `wants to edit ${files.length} files` : "wants to edit a file";
    what = files.length > 1 ? `edit ${files.length} files (${files.slice(0, 3).map(shortPath).join(", ")})` : `${kind === "write" ? "write" : "edit"} ${shortPath(path!)}`;
    flag = flagWords(r.reason);
  } else if ((kind === "read" || kind === "search") && (path || r.title)) {
    status = "wants to read files";
    what = `read ${path ? shortPath(path) : r.title!}`;
    flag = flagWords(r.reason);
  } else if (kind === "fetch" && str(input.url)) {
    status = "wants to fetch from the web";
    what = `open ${hostOf(str(input.url)!)}`;
  } else {
    status = "wants to use a tool";
    what = `use ${toolWords(r.tool ?? "a tool")}${r.title ? `: ${r.title}` : ""}`;
    flag = flagWords(r.reason);
  }
  const ask = r.noReason ? "Allow? y/n" : "Safe? y/n";
  const words = `${agent} wants to ${what}${flag ? `, flagged because ${flag}` : ""}`;
  return { status, body: `${clip(bare(words), REQUEST_MAX - ask.length - 2)}. ${ask}` };
}

const bare = (s: string) => s.trim().replace(/[.!:\s]+$/, "");
const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

export type ReplyMeaning =
  /** an answer to the request (nothing is texted back: the agent answers for itself) */
  | { answer: RequestAnswer }
  /** the person talking to the agent (it goes as a denial's reason: the agent reads it and goes on) */
  | { talk: string }
  | { problem: string };

const YES = /^(y|ye|yes|yep|yeah|ok|okay|sure|allow|approve|approved|go|go ahead|do it|lgtm|👍)[.!]*$/i;
const NO = /^(n|no|nope|deny|reject|don'?t|stop)[.!]*$/i;

/** What a reply to an open request means. */
export function readReply(r: Request, raw: string): ReplyMeaning {
  const text = raw.trim();
  if (r.kind === "question") {
    const qs = r.questions?.length ? r.questions : [{ question: r.question ?? "", options: (r.options ?? []).map((label) => ({ label })), multiSelect: false }];
    const tokens = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const pick = (q: (typeof qs)[number], tok: string) => {
      const letters = q.multiSelect ? [...tok] : [tok];
      if (letters.some((l) => l.length !== 1 || LETTERS.indexOf(l) < 0 || LETTERS.indexOf(l) >= q.options.length)) return undefined;
      return letters.map((l) => q.options[LETTERS.indexOf(l)]!.label).join(", ");
    };
    if (qs.length === 1) {
      const q = qs[0]!;
      const one = tokens.length === 1 ? pick(q, tokens[0]!) : q.multiSelect && tokens.every((t) => t.length === 1) ? pick(q, tokens.join("")) : undefined;
      if (one !== undefined) return { answer: { allow: true, answers: [one] } };
      return { answer: { allow: true, answers: [text] } };
    }
    if (tokens.length === qs.length) {
      const picks = qs.map((q, i) => pick(q, tokens[i]!));
      if (picks.every((p) => p !== undefined)) return { answer: { allow: true, answers: picks as string[] } };
    }
    return r.noReason ? { problem: `Reply with a letter for each question, like "a c".` } : { talk: text };
  }
  if (YES.test(text)) return { answer: { allow: true } };
  if (NO.test(text)) return { answer: { allow: false } };
  if (r.noReason) return { problem: "This one only takes y or n." };
  return { talk: text };
}
