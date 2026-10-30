// A stored Claude Code session (or one of its subagents) as a transcript, read without starting
// Claude. Both files are read by jsonl.ts (incrementally, across compactions, which the SDK's
// getSessionMessages stops at, and with the results of parallel tool calls, which sit beside the
// chain and the SDK's walk drops).
//
// Message ids match what the live stream uses (stream.ts), so a session that goes from live to
// stored and back keeps its ids: an assistant message is its API message id (Claude Code writes one
// entry per content block, all with that id), a user message its entry's uuid.

import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { readStore, type Entry } from "./jsonl";
import type { Msg, ToolPart } from "../../../../shared/transcript";
import { assistantPart, blockText, cleanUserText, commandOutput, joinBash, messageId, notice, toolResults, userMessage, type EntryFlags } from "./content";
import { sessionFile, splitNative, storedSubagents } from "./paths";

/** Each entry's time, and the flags Claude Code stores on it, by uuid. */
type EntryMeta = { flags: Map<string, EntryFlags>; times: Map<string, number> };

/** Store entries (as the SDK's SessionMessage) as a transcript. */
export function historyMessages(list: Pick<SessionMessage, "type" | "uuid" | "message">[], meta: EntryMeta): Msg[] {
  const out: Msg[] = [];
  const byId = new Map<string, Msg>();
  const toolOwner = new Map<string, Msg>();
  let last = 0;
  const at = (uuid: string) => (last = meta.times.get(uuid) ?? last);
  // Back to Tether quits Claude's TUI with /exit (SPEC §8): the command and its goodbye ("See
  // ya!") are how Tether left, not part of the conversation.
  let exiting = false;
  const exitShown = (m: (typeof list)[number]): boolean => {
    const msg: any = m.message;
    const text = typeof msg?.content === "string" ? msg.content : "";
    if (/^\s*<command-name>\/exit<\/command-name>/.test(text)) return (exiting = true);
    const goodbye = exiting && /^\s*<local-command-stdout>/.test(text);
    if (!/^\s*<local-command-caveat>/.test(text)) exiting = false;
    return goodbye;
  };
  for (const m of list) {
    try {
      entry(m);
    } catch (e) {
      // One malformed entry is skipped; the rest of the session still reads.
      console.error(`skipped a transcript entry (${m.uuid}):`, e);
    }
  }
  function entry(m: (typeof list)[number]) {
    if ((m.type === "user" || m.type === "system") && exitShown(m)) return;
    const msg: any = m.message;
    const ts = at(m.uuid);
    if (m.type === "assistant" && Array.isArray(msg?.content) && msg.model === "<synthetic>") {
      // Claude Code's own replies, as the live stream shows them (stream.ts): an API error is a
      // message with its error; anything else ("No response requested.") a notice.
      const text = blockText(msg.content);
      if (msg.apiError) out.push({ id: messageId(msg.id, m.uuid), role: "assistant", ts, parts: [{ type: "text", text }], error: text });
      else if (commandOutput(text)) out.push(notice(m.uuid, ts, commandOutput(text)));
    } else if (m.type === "assistant" && Array.isArray(msg?.content)) {
      const id = messageId(msg.id, m.uuid);
      let target = byId.get(id);
      if (!target) {
        target = { id, role: "assistant", parts: [], ts, ...(msg.model && !msg.model.startsWith("<") ? { model: msg.model } : {}) };
        byId.set(id, target);
        out.push(target);
      }
      for (const b of msg.content) {
        const p = assistantPart(b);
        target.parts.push(p);
        if (p.type === "tool") toolOwner.set(p.id, target);
      }
    } else if (m.type === "user" && msg) {
      for (const r of toolResults(msg.content)) {
        const owner = toolOwner.get(r.toolId);
        const i = owner?.parts.findIndex((p) => p.type === "tool" && p.id === r.toolId) ?? -1;
        if (owner && i >= 0) owner.parts[i] = { ...(owner.parts[i] as ToolPart), status: r.status, output: r.output };
      }
      const u = userMessage(msg.content, m.uuid, ts, meta.flags.get(m.uuid));
      if (u && !joinBash(out, u)) out.push(u);
    } else if (m.type === "system" && msg?.subtype === "compact_boundary") {
      out.push(notice(m.uuid, ts, "Context compacted."));
    } else if (m.type === "system" && msg?.subtype === "local_command" && typeof msg.content === "string") {
      // Claude's own TUI stores a typed local command (/model) as one of these, not as a user
      // entry like the SDK does: it reads as typed.
      if (/<command-name>/.test(msg.content)) out.push({ id: m.uuid, role: "user", ts, parts: [{ type: "text", text: cleanUserText(msg.content) }] });
      else {
        const text = commandOutput(msg.content);
        if (text) out.push(notice(m.uuid, ts, text));
      }
    }
  }
  // /compact's "Compacted (…)" output only repeats the compaction notice (the live stream never sends it).
  const isCompacted = (m?: Msg) => m?.role === "notice" && (m.parts[0] as any)?.text === "Context compacted.";
  for (let i = out.length - 1; i >= 0; i--)
    if (out[i]!.role === "notice" && /^Compacted\b/.test((out[i]!.parts[0] as any)?.text ?? "") && (isCompacted(out[i - 1]) || isCompacted(out[i - 2]))) out.splice(i, 1);
  // Claude Code writes a /compact prompt after the compaction it asked for; shown (as live) first.
  // Sometimes it also wrote the plain prompt before the compaction: then that one is shown alone.
  const userText = (m?: Msg) => (m?.role === "user" ? ((m.parts[0] as any)?.text ?? "") : undefined);
  for (let i = 0; i + 1 < out.length; i++) {
    const [n, u] = [out[i]!, out[i + 1]!];
    if (!isCompacted(n) || !/^\/compact\b/.test(userText(u) ?? "")) continue;
    if (userText(out[i - 1])?.trim() === userText(u)!.trim()) out.splice(i + 1, 1);
    else [out[i], out[i + 1]] = [u, n];
  }
  // A call left running before the last message never finished (the process stopped).
  const lastId = out.at(-1)?.id;
  for (const m of out) if (m.id !== lastId) for (const [i, p] of m.parts.entries()) if (p.type === "tool" && p.status === "running") m.parts[i] = { ...p, status: "error" };
  return out;
}

/** Fills each subagent call's link to its child session (from the subagents' meta files). */
export function linkSubagents(msgs: Msg[], session: string, children: { agentId: string; meta: { toolUseId?: string } }[]) {
  const byTool = new Map(children.filter((c) => c.meta.toolUseId).map((c) => [c.meta.toolUseId!, c.agentId]));
  if (!byTool.size) return;
  for (const m of msgs)
    for (const [i, p] of m.parts.entries())
      if (p.type === "tool" && byTool.has(p.id)) m.parts[i] = { ...p, childSessionId: `claude:${session}/${byTool.get(p.id)}` };
}

/** A stored session's transcript, or a subagent's (`<session>/<agent>`). */
export async function readHistory(nativeId: string, projectPath: string): Promise<Msg[]> {
  const { session, agent } = splitNative(nativeId);
  const children = storedSubagents(session, projectPath);
  const file = agent ? children.find((c) => c.agentId === agent)?.file : sessionFile(session, projectPath);
  const msgs = file ? chainMessages((await readStore(file)).chain()) : [];
  linkSubagents(msgs, session, children);
  return msgs;
}

/** A session file's conversation (jsonl.ts, across compactions) as a transcript. */
export function chainMessages(chain: Entry[]): Msg[] {
  const meta: EntryMeta = { flags: new Map(), times: new Map() };
  const list: Pick<SessionMessage, "type" | "uuid" | "message">[] = [];
  for (const e of chain) {
    if (e.type !== "user" && e.type !== "assistant" && e.type !== "system") continue;
    const uuid = e.messageId ?? e.uuid;
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(t)) meta.times.set(uuid, t);
    if (e.isMeta || e.isCompactSummary || e.origin) meta.flags.set(uuid, { isMeta: e.isMeta, isCompactSummary: e.isCompactSummary, origin: e.origin });
    list.push({ type: e.type as SessionMessage["type"], uuid, message: e.type === "system" ? { subtype: e.subtype, content: e.message?.content } : e.message });
  }
  return historyMessages(list, meta);
}
