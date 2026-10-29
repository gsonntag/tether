// Claude content blocks as transcript parts, shared by the stored history (history.ts) and the
// live stream (stream.ts), so a session reads the same either way. Ported from v1's claude.ts,
// trimmed to P1's parts (text, thinking, image, tool).

import type { Msg, Part } from "../../../../shared/transcript";
import { toolPart } from "../toolKind";

/** The text of a tool_result's content (a string, or text blocks). */
export function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (b?.type === "text" ? b.text : b?.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
  return "";
}

/** One assistant content block as a part. */
export function assistantPart(b: any): Part {
  if (b?.type === "text") return { type: "text", text: b.text ?? "" };
  if (b?.type === "thinking") return { type: "thinking", text: b.thinking ?? "" };
  if (b?.type === "redacted_thinking") return { type: "thinking", text: "" };
  if (b?.type === "tool_use" || b?.type === "server_tool_use" || b?.type === "mcp_tool_use") return toolPart(b.id, b.name, b.input ?? {});
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

const tag = (text: string, name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

export const notice = (id: string, ts: number, text: string, level: Msg["level"] = "info"): Msg => ({ id, role: "notice", level, ts, parts: [{ type: "text", text }] });

/**
 * Turns Claude Code adds as "user" messages that the person didn't type. Returns the notice to show,
 * null to hide it, or undefined when it is an ordinary prompt.
 */
export function injected(text: string, flags: EntryFlags, id: string, ts: number): Msg | null | undefined {
  const t = text.trimStart();
  // A background task's report to Claude: the live stream never shows it (the subagent's own
  // session and Claude's answer do), so the stored view doesn't either.
  if (flags.origin?.kind === "task-notification" || t.startsWith("<task-notification>")) return null;
  if (t.startsWith("[Request interrupted")) return notice(id, ts, "Interrupted");
  if (flags.origin?.kind && flags.origin.kind !== "human") return fromElsewhere(text, flags.origin, id, ts);
  // The summary Claude continues from after a compaction: the boundary's "Context compacted."
  // notice marks the spot, live and stored alike.
  if (flags.isCompactSummary) return null;
  if (t.startsWith("<system-reminder>") || t.startsWith("<local-command-caveat>")) return null;
  if (t.startsWith("<local-command-stdout>")) {
    const out = tag(t, "local-command-stdout");
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

/**
 * A user entry's visible message (its text and images), a notice for an injected turn, or
 * undefined. Tool results in it are applied separately (`toolResults`).
 */
export function userMessage(content: unknown, id: string, ts: number, flags: EntryFlags = {}): Msg | undefined {
  const blocks: any[] = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const whole = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  if (whole) {
    const inj = injected(whole, flags, id, ts);
    if (inj === null) return undefined;
    if (inj) return inj;
  }
  const parts: Part[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && b.text) parts.push({ type: "text", text: cleanUserText(b.text) });
    else if (b?.type === "image" && b.source?.type === "base64") parts.push({ type: "image", mimeType: b.source.media_type, data: b.source.data });
  }
  return parts.length ? { id, role: "user", parts, ts } : undefined;
}

/** The tool_result blocks of a user entry: which call, done or failed, and its output. */
export function toolResults(content: unknown): { toolId: string; status: "done" | "error"; output: string }[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b: any) => b?.type === "tool_result" && typeof b.tool_use_id === "string").map((b: any) => ({ toolId: b.tool_use_id, status: b.is_error ? ("error" as const) : ("done" as const), output: blockText(b.content) }));
}

/** A slash command's output as Claude Code stores it (inside <local-command-stdout>), plain. */
export function commandOutput(text: string): string {
  const inner = text.match(/<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/)?.[1] ?? text;
  // Terminal styling (dim, bold) means nothing here.
  return inner.replace(/\u001b\[[0-9;]*m/g, "").trim();
}
