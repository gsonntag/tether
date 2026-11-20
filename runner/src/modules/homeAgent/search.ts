// search_sessions: what sessions actually said. Each session's transcript is read straight from its
// harness's store file (Claude Code's JSONL under ~/.claude/projects, Codex's rollout JSONL), a line
// at a time, so a big transcript never sits in memory whole and a session stops being read once it
// has given enough matches. A session with no store file (a new one, not yet written) is searched in
// the messages the runner has of it instead.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Msg } from "../../../../shared/transcript";

export const SEARCH = {
  /** snippets shown per session; one more found only says "more" */
  perSession: 3,
  /** characters of context a snippet shows around its match, in all */
  snippet: 200,
  /** a store line longer than this isn't parsed: a match in it is shown from the raw line */
  maxLine: 2_000_000,
  /** the whole search's time budget: what's left unread is said so */
  budgetMs: 25_000,
  /** sessions read at once */
  parallel: 6,
};

/** One match: which message it was in, roughly when, and the text around it. */
export interface Hit {
  where: string;
  at?: number;
  snippet: string;
}

export interface Found {
  hits: Hit[];
  /** there were more matches than `perSession` */
  more: boolean;
}

interface Piece {
  where: string;
  text: string;
}

/** The text around the first match of `q` (lowercase) in `text`, on one line; undefined when there's none. */
export function snippetOf(text: string, q: string, width = SEARCH.snippet): string | undefined {
  const low = text.toLowerCase();
  const i = low.indexOf(q);
  if (i < 0) return undefined;
  const side = Math.max(20, Math.floor((width - q.length) / 2));
  const from = Math.max(0, i - side);
  const to = Math.min(text.length, i + q.length + side);
  const body = text.slice(from, to).replace(/\s+/g, " ").trim();
  return `${from > 0 ? "…" : ""}${body}${to < text.length ? "…" : ""}`;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

/** The text of a tool result's content: a string, or text blocks. */
const resultText = (c: unknown): string => (Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? str(b.text) : "")).join("\n") : str(c));

/** Codex's own context it puts in the first user message: not something anyone said. */
const CODEX_CONTEXT = /^\s*<(environment_context|user_instructions|permissions instructions|user_shell_command)>/;

/** What one store entry said, by message kind: Claude Code's entries and Codex's rollout items; nothing for bookkeeping entries. */
export function entryPieces(e: any): Piece[] {
  if (!e || typeof e !== "object") return [];
  // Claude Code
  if ((e.type === "user" || e.type === "assistant") && e.message) {
    const c = e.message.content;
    if (typeof c === "string") return [{ where: e.type === "user" ? "prompt" : "reply", text: c }];
    if (!Array.isArray(c)) return [];
    const out: Piece[] = [];
    for (const b of c) {
      if (b?.type === "text") out.push({ where: e.type === "user" ? "prompt" : "reply", text: str(b.text) });
      else if (b?.type === "tool_use") out.push({ where: `tool call${b.name ? ` (${b.name})` : ""}`, text: str(b.input) });
      else if (b?.type === "tool_result") out.push({ where: "tool result", text: resultText(b.content) });
    }
    return out;
  }
  if (e.type === "summary" && typeof e.summary === "string") return [{ where: "summary", text: e.summary }];
  // Codex
  if (e.type === "response_item" && e.payload) {
    const p = e.payload;
    if (p.type === "message" && (p.role === "user" || p.role === "assistant") && Array.isArray(p.content)) {
      const t = p.content.map((b: any) => str(b?.text)).join("\n");
      if (p.role === "user" && CODEX_CONTEXT.test(t)) return [];
      return [{ where: p.role === "user" ? "prompt" : "reply", text: t }];
    }
    if (p.type === "function_call" || p.type === "custom_tool_call") return [{ where: `tool call${p.name ? ` (${p.name})` : ""}`, text: str(p.arguments ?? p.input) }];
    if (p.type === "local_shell_call") return [{ where: "tool call (shell)", text: str(p.action) }];
    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const o = p.output;
      return [{ where: "tool result", text: o && typeof o === "object" && !Array.isArray(o) ? resultText(o.content ?? o.output ?? o) : resultText(o) }];
    }
  }
  return [];
}

const timeOf = (e: any): number | undefined => {
  const t = typeof e?.timestamp === "string" ? Date.parse(e.timestamp) : typeof e?.timestamp === "number" ? e.timestamp : NaN;
  return Number.isFinite(t) ? t : undefined;
};

/** `q` as it appears inside a JSON string, lowercased: a cheap test before a line is parsed. */
const escaped = (q: string) => JSON.stringify(q).slice(1, -1);

/**
 * The matches of `query` (any case) in a store file, read a line at a time; stops at `perSession`
 * + 1 matches, or when `stop` says to. A line too long to parse is still searched, as raw text.
 */
export async function searchFile(path: string, query: string, o: { perSession?: number; stop?: () => boolean } = {}): Promise<Found> {
  const q = query.toLowerCase();
  const esc = escaped(q);
  const cap = o.perSession ?? SEARCH.perSession;
  const hits: Hit[] = [];
  let more = false;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (o.stop?.()) break;
      const low = line.toLowerCase();
      if (!low.includes(esc) && !low.includes(q)) continue;
      if (line.length > SEARCH.maxLine) {
        const s = snippetOf(line, q);
        if (s) hits.length < cap ? hits.push({ where: "a very large entry", snippet: s }) : (more = true);
      } else {
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const at = timeOf(e);
        for (const p of entryPieces(e)) {
          const s = snippetOf(p.text, q);
          if (!s) continue;
          if (hits.length < cap) hits.push({ where: p.where, ...(at !== undefined ? { at } : {}), snippet: s });
          else more = true;
          break;
        }
      }
      if (more) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { hits, more };
}

/** The same, over messages the runner has (a session with no store file). */
export function searchMsgs(msgs: Msg[], query: string, perSession = SEARCH.perSession): Found {
  const q = query.toLowerCase();
  const hits: Hit[] = [];
  for (const m of msgs) {
    for (const p of m.parts) {
      const text = p.type === "text" ? (p as { text: string }).text : p.type === "tool" ? [str((p as any).input), str((p as any).output)].join("\n") : "";
      const s = text && snippetOf(text, q);
      if (!s) continue;
      if (hits.length >= perSession) return { hits, more: true };
      hits.push({ where: p.type === "tool" ? "tool" : m.role === "user" ? "prompt" : m.role === "assistant" ? "reply" : m.role, ...(m.ts ? { at: m.ts } : {}), snippet: s });
      break;
    }
  }
  return { hits, more: false };
}
