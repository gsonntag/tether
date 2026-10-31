// Claude content blocks as transcript parts, shared by the stored history (history.ts) and the
// live stream (stream.ts), so a session reads the same either way. Ported from v1's claude.ts,
// trimmed to P1's parts (text, thinking, image, tool).

import { tetherOrigin } from "../../../../shared/fromTether";
import type { Msg, Part } from "../../../../shared/transcript";
import { toolPart } from "../toolKind";

/** The text of a tool_result's content (a string, or text blocks). */
export function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  return "";
}

/** An API message id when it is one (a non-empty string), else the fallback (the entry's uuid). */
export const messageId = (id: unknown, fallback: string): string => (typeof id === "string" && id ? id : fallback);

/** One assistant content block as a part. */
export function assistantPart(b: any): Part {
  // A malformed block (text that isn't a string) degrades to empty, never breaks the session.
  if (b?.type === "text") return { type: "text", text: typeof b.text === "string" ? b.text : "" };
  if (b?.type === "thinking") return { type: "thinking", text: typeof b.thinking === "string" ? b.thinking : "" };
  if (b?.type === "redacted_thinking") return { type: "thinking", text: "" };
  if (b?.type === "tool_use" || b?.type === "server_tool_use" || b?.type === "mcp_tool_use") return toolPart(String(b.id ?? ""), typeof b.name === "string" ? b.name : "tool", b.input ?? {});
  return { type: "text", text: "" };
}

/**
 * A final block over what streaming built for the same index: a tool call keeps its status, output
 * and child link (they arrived separately); text and thinking keep the streamed text when the final
 * block has none (Claude Code stores thinking empty).
 */
export function mergePart(old: Part | undefined, next: Part): Part {
  if (!old) return next;
  if (next.type === "tool" && old.type === "tool" && old.id === next.id)
    return { ...next, status: old.status, ...(old.output !== undefined ? { output: old.output } : {}), ...(old.childSessionId ? { childSessionId: old.childSessionId } : {}) };
  if ((next.type === "text" || next.type === "thinking") && next.type === old.type && !next.text && old.text) return old;
  return next;
}

/** Flags Claude Code stores on transcript entries (the SDK's history API drops them). */
export interface EntryFlags {
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: { kind?: string; name?: string; server?: string; from?: string; body?: string };
}

/**
 * A turn another sender put in (a peer session, a channel, …) as a message marked with its origin,
 * its text as the sender wrote it: without Claude Code's wrapper and preamble.
 */
function fromElsewhere(text: string, o: NonNullable<EntryFlags["origin"]>, id: string, ts: number): Msg {
  const wrapped = text.match(/<agent-message[^>]*>([\s\S]*?)(?:<\/agent-message>|$)/)?.[1];
  let body = o.body ?? wrapped ?? text;
  body = body.replace(/^\[Subagent hand-back\][\s\S]*?The report follows:\s*/, "").replace(/^ {2}/gm, "").trim();
  const name = o.name ?? o.server ?? o.from;
  return { id, role: "user", ts, origin: { kind: o.kind!, ...(name ? { name } : {}) }, parts: [{ type: "text", text: body }] };
}


export const notice = (id: string, ts: number, text: string, level: Msg["level"] = "info"): Msg => ({ id, role: "notice", level, ts, parts: [{ type: "text", text }] });

/**
 * Turns Claude Code adds as "user" messages that the person didn't type. Returns the notice to show,
 * null to hide it, or undefined when it is an ordinary prompt.
 */
export function injected(text: string, flags: EntryFlags, id: string, ts: number): Msg | null | undefined {
  const t = text.trimStart();
  // A message Tether sent on your behalf (an answer passed on after a restart, a command's output):
  // Tether's, not yours. Only on a turn that came in as typed (Tether's sends do): one from another
  // session or a channel that merely starts with the marker stays that session's.
  const tether = !flags.origin?.kind || flags.origin.kind === "human" ? tetherOrigin(t) : undefined;
  if (tether) return { id, role: "user", ts, origin: tether.origin, parts: [{ type: "text", text: tether.text }] };
  // A background task's report to Claude: the live stream never shows it (the subagent's own
  // session and Claude's answer do), so the stored view doesn't either.
  if (flags.origin?.kind === "task-notification" || t.startsWith("<task-notification>")) return null;
  if (t.startsWith("[Request interrupted")) return notice(id, ts, "Interrupted");
  if (flags.origin?.kind && flags.origin.kind !== "human") return fromElsewhere(text, flags.origin, id, ts);
  // The summary Claude continues from after a compaction: the boundary's "Context compacted."
  // notice marks the spot, live and stored alike.
  if (flags.isCompactSummary) return null;
  if (t.startsWith("<system-reminder>") || t.startsWith("<local-command-caveat>")) return null;
  if (t.startsWith("<local-command-stdout>") || t.startsWith("<local-command-stderr>")) {
    // As the live stream shows it: styling stripped, so /compact's "Compacted" is recognised too.
    const out = commandOutput(t);
    return out ? notice(id, ts, out) : null;
  }
  if (flags.isMeta) return null;
  return undefined;
}

/** A typed slash command reads as typed ("/compact focus"); other wrappers are left as they are. */
export function cleanUserText(text: string): string {
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return `${cmd[1]}${args ? " " + args : ""}`;
  }
  return text;
}

/** Text that is nothing but Claude Code's own markup for a typed slash command. */
export const isCommandEntry = (text: string) => /<command-name>/.test(text) && !text.replace(/<command-(name|message|args)>[^<]*<\/command-\1>/g, "").trim();

/**
 * A user entry's visible message (its text and images), a notice for an injected turn, or
 * undefined. Tool results in it are applied separately (`toolResults`).
 */
export function userMessage(content: unknown, id: string, ts: number, flags: EntryFlags = {}): Msg | undefined {
  const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const whole = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
  if (whole) {
    const inj = injected(whole, flags, id, ts);
    if (inj === null) return undefined;
    if (inj) return inj;
  }
  const parts: Part[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string" && b.text) parts.push(...(bashParts(b.text, id) ?? [{ type: "text" as const, text: cleanUserText(b.text) }]));
    else if (b?.type === "image" && b.source?.type === "base64") parts.push({ type: "image", mimeType: b.source.media_type, data: b.source.data });
  }
  return parts.length ? { id, role: "user", parts, ts, ...(isCommandEntry(whole) ? { localCommand: true } : {}) } : undefined;
}

const BASH = /<bash-input>([\s\S]*?)<\/bash-input>|<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?|<bash-stderr>([\s\S]*?)<\/bash-stderr>/g;
const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };
const unescape = (s: string) => s.replace(/&(?:lt|gt|amp|quot|#39);/g, (e) => ENTITIES[e]!);

/**
 * A command you ran with `!` in Claude Code, as it shows it: "! cmd", then its output (a shell
 * card; done, as the exit code isn't stored, and tools write to stderr when they succeed). Claude
 * Code stores the command and its output as two entries (sometimes one, after text you typed);
 * `joinBash` puts an output under its command. Undefined when the text has none.
 */
export function bashParts(text: string, id: string): Part[] | undefined {
  if (!/<bash-(?:input|stdout|stderr)>/.test(text)) return undefined;
  const parts: Part[] = [];
  let last = 0;
  let n = 0;
  let cmd: string | undefined;
  const prose = (t: string) => void (t.trim() && parts.push({ type: "text", text: t.trim() }));
  for (const m of text.matchAll(BASH)) {
    prose(text.slice(last, m.index));
    last = m.index! + m[0].length;
    if (m[1] !== undefined) {
      cmd = unescape(m[1].trim());
      parts.push({ type: "text", text: `! ${cmd}` });
      continue;
    }
    const out = unescape((m[2] ?? "").trim());
    const err = unescape((m[3] ?? m[4] ?? "").trim());
    parts.push({ type: "tool", id: `${id}:bash${n++}`, name: "Bash", kind: "shell", input: cmd ? { command: cmd } : {}, ...(cmd ? { command: cmd } : {}), status: "done", output: [out, err].filter(Boolean).join("\n") });
  }
  prose(text.slice(last));
  return parts;
}

/**
 * A `!` command's output (a message of only its shell card) joins the "! cmd" message just before
 * it, with the command filled in. True when it did.
 */
export function joinBash(out: Msg[], m: Msg): boolean {
  const prev = out.at(-1);
  const card = m.parts[0];
  if (m.role !== "user" || m.parts.length !== 1 || card?.type !== "tool" || !card.id.startsWith(`${m.id}:bash`) || card.command) return false;
  const last = prev?.role === "user" && !prev.origin ? prev.parts.at(-1) : undefined;
  if (last?.type !== "text" || !last.text.startsWith("! ")) return false;
  const command = last.text.slice(2);
  prev!.parts.push({ ...card, input: { command }, command });
  return true;
}

/** The tool_result blocks of a user entry: which call, done or failed, and its output. */
export function toolResults(content: unknown): { toolId: string; status: "done" | "error"; output: string }[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === "tool_result" && typeof b.tool_use_id === "string")
    .map((b: any) => {
      const output = blockText(b.content);
      // A permission prompt cut off by its process closing (a runner restart, the terminal taking
      // over): the SDK's abort error says nothing useful; the request itself lives on.
      return { toolId: b.tool_use_id, status: b.is_error ? ("error" as const) : ("done" as const), output: b.is_error && ABORTED_PROMPT.test(output) ? "" : output };
    });
}

const ABORTED_PROMPT = /^Tool permission request failed: (?:Error: )?(?:AbortError|.*aborted)/i;

/** A slash command's output as Claude Code stores it (inside <local-command-stdout>), plain. */
export function commandOutput(text: string): string {
  const inner = text.match(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/)?.[1] ?? text;
  // Terminal styling (dim, bold) means nothing here.
  return inner.replace(/\u001b\[[0-9;]*m/g, "").trim();
}

/**
 * Slash commands Claude Code stores under another name (it writes `/usage` for `/cost`). The live
 * view shows the stored name too, so a session going stored reads the same.
 */
const COMMAND_ALIASES: Record<string, string> = { cost: "usage" };

export function canonicalCommand(text: string): string {
  const m = text.match(/^\/([\w-]+)(?=\s|$)/);
  const to = m && COMMAND_ALIASES[m[1]!];
  return to ? `/${to}${text.slice(m![0].length)}` : text;
}
