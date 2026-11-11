// What a text about a request says, and what a reply to one means. Texts say what the agent wants
// (the command, the file, the question and its options, the plan), with known secrets redacted, and
// take short answers: y or n for an approval or a plan, a letter for a question. Anything else is
// the person talking to the agent: it goes to the agent as their words.

import type { Request, RequestAnswer } from "../../../../shared/transcript";
import { redact } from "../../credentials";

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
      const opts = q.options.slice(0, LETTERS.length).map((o, j) => `${LETTERS[j]}) ${clip(o.label, 120)}`).join("\n");
      return `${head}${clip(q.question, 400)}${"multiSelect" in q && q.multiSelect ? " (pick any)" : ""}\n${opts}`;
    });
    const how = qs.length > 1 ? `Reply with a letter for each question, like "a c".` : "Reply with a letter, or your own answer.";
    return { status: "has a question", body: `${agent} asks:\n${shown.join("\n\n")}\n\n${how}` };
  }
  if (r.plan !== undefined) {
    return { status: "has a plan to approve", body: `${agent} has a plan:\n\n${clip(r.plan, 1500)}\n\nReply y to approve, or say what to change.` };
  }
  const input = (r.input ?? {}) as Record<string, unknown>;
  const files = Array.isArray(input.files) ? input.files.flatMap((f: any) => str(f?.path) ?? str(f) ?? []) : [];
  const path = r.path ?? str(input.file_path) ?? str(input.path) ?? files[0];
  const command = r.command ?? str(input.command);
  const kind = r.toolKind ?? (command ? "shell" : undefined);
  let status: string;
  let what: string;
  if (r.network) {
    status = "wants network access";
    what = `${agent} wants network access${r.reason ? `: ${clip(r.reason, 300)}` : "."}`;
  } else if (kind === "shell" && command) {
    status = "wants to run a command";
    what = `${agent} wants to run:\n${clip(command, 600)}`;
  } else if ((kind === "edit" || kind === "write") && (path || files.length)) {
    status = files.length > 1 ? `wants to edit ${files.length} files` : "wants to edit a file";
    what = `${agent} wants to ${kind === "write" ? "write" : "edit"} ${files.length > 1 ? files.slice(0, 5).map((f) => clip(f, 150)).join(", ") : clip(path!, 300)}`;
  } else if ((kind === "read" || kind === "search") && (path || r.title)) {
    status = "wants to read files";
    what = `${agent} wants to read ${clip(path ?? r.title!, 300)}`;
  } else if (kind === "fetch" && str(input.url)) {
    status = "wants to fetch from the web";
    what = `${agent} wants to fetch ${clip(str(input.url)!, 300)}`;
  } else {
    status = "wants to use a tool";
    const args = Object.keys(input).length ? `\n${clip(JSON.stringify(input), 300)}` : "";
    what = `${agent} wants to use ${r.tool ?? "a tool"}${r.title ? `: ${clip(r.title, 200)}` : ""}${args}`;
  }
  const why = r.reason && !r.network ? `\n(${clip(r.reason, 200)})` : "";
  const how = r.noReason ? "Reply y to allow or n to deny." : "Reply y to allow, n to deny, or tell it what to do instead.";
  return { status, body: `${what}${why}\n\n${how}` };
}

export type ReplyMeaning =
  /** an answer to the request; `ack` says what was done */
  | { answer: RequestAnswer; ack: string }
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
      if (one !== undefined) return { answer: { allow: true, answers: [one] }, ack: `answered "${clip(one, 80)}"` };
      return { answer: { allow: true, answers: [text] }, ack: "answered with your words" };
    }
    if (tokens.length === qs.length) {
      const picks = qs.map((q, i) => pick(q, tokens[i]!));
      if (picks.every((p) => p !== undefined)) return { answer: { allow: true, answers: picks as string[] }, ack: "answered" };
    }
    return r.noReason ? { problem: `Reply with a letter for each question, like "a c".` } : { talk: text };
  }
  if (YES.test(text)) return { answer: { allow: true }, ack: r.plan !== undefined ? "approved" : "allowed" };
  if (NO.test(text)) return { answer: { allow: false }, ack: "denied (the turn stops)" };
  if (r.noReason) return { problem: "This one only takes y or n." };
  return { talk: text };
}
