// A stored Claude Code session (or one of its subagents) as a transcript, read without starting
// Claude. A session's own file is read by jsonl.ts (incrementally, and across compactions, which
// the SDK's getSessionMessages stops at); a subagent's by the SDK's getSubagentMessages, with
// entryMeta reading what that API leaves out (each entry's time and flags).
//
// Message ids match what the live stream uses (stream.ts), so a session that goes from live to
// stored and back keeps its ids: an assistant message is its API message id (Claude Code writes one
// entry per content block, all with that id), a user message its entry's uuid.

import { getSubagentMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { readStore, type Entry } from "./jsonl";
import type { Msg, ToolPart } from "../../../../shared/transcript";
import { assistantPart, commandOutput, notice, toolResults, userMessage, type EntryFlags } from "./content";
import { sessionFile, splitNative, storedSubagents } from "./paths";

/** Each entry's time and the flags getSessionMessages drops, by uuid. */
export function entryMeta(text: string): { flags: Map<string, EntryFlags>; times: Map<string, number> } {
  const flags = new Map<string, EntryFlags>();
  const times = new Map<string, number>();
  // Claude Code writes `"uuid":"…","timestamp":"…"` next to each other on every entry.
  for (const m of text.matchAll(/"uuid":"([^"]+)","timestamp":"([^"]+)"/g)) {
    const t = Date.parse(m[2]!);
    if (Number.isFinite(t) && !times.has(m[1]!)) times.set(m[1]!, t);
  }
  for (const line of text.split("\n")) {
    if (!line.includes('"type":"user"') || !(line.includes('"isMeta"') || line.includes('"origin"') || line.includes('"isCompactSummary"'))) continue;
    try {
      const e = JSON.parse(line);
      if (e.uuid) flags.set(e.uuid, { isMeta: e.isMeta, isCompactSummary: e.isCompactSummary, origin: e.origin });
    } catch {}
  }
  return { flags, times };
}

/**
 * The SDK's entries as a transcript. `subagent`: a subagent's own file, whose entries all carry
 * parent_tool_use_id; in a main session those are a subagent's internals and are skipped.
 */
export function historyMessages(list: Pick<SessionMessage, "type" | "uuid" | "message" | "parent_tool_use_id">[], meta: ReturnType<typeof entryMeta>, subagent = false): Msg[] {
  const out: Msg[] = [];
  const byId = new Map<string, Msg>();
  const toolOwner = new Map<string, Msg>();
  let last = 0;
  const at = (uuid: string) => (last = meta.times.get(uuid) ?? last);
  for (const m of list) {
    if (m.parent_tool_use_id && !subagent) continue;
    const msg: any = m.message;
    const ts = at(m.uuid);
    if (m.type === "assistant" && Array.isArray(msg?.content)) {
      const id = msg.id ?? m.uuid;
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
      if (u) out.push(u);
    } else if (m.type === "system" && msg?.subtype === "compact_boundary") {
      out.push(notice(m.uuid, ts, "Context compacted."));
    } else if (m.type === "system" && msg?.subtype === "local_command" && typeof msg.content === "string") {
      const text = commandOutput(msg.content);
      if (text) out.push(notice(m.uuid, ts, text));
    }
  }
  // /compact's "Compacted (…)" output only repeats the compaction notice (the live stream never sends it).
  const isCompacted = (m?: Msg) => m?.role === "notice" && (m.parts[0] as any)?.text === "Context compacted.";
  for (let i = out.length - 1; i >= 0; i--)
    if (out[i]!.role === "notice" && /^Compacted\b/.test((out[i]!.parts[0] as any)?.text ?? "") && (isCompacted(out[i - 1]) || isCompacted(out[i - 2]))) out.splice(i, 1);
  // Claude Code writes a /compact prompt after the compaction it asked for; shown (as live) first.
  for (let i = 0; i + 1 < out.length; i++) {
    const [n, u] = [out[i]!, out[i + 1]!];
    if (n.role === "notice" && (n.parts[0] as any)?.text === "Context compacted." && u.role === "user" && /^\/compact\b/.test((u.parts[0] as any)?.text ?? "")) [out[i], out[i + 1]] = [u, n];
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

async function fileText(f: string | undefined): Promise<string> {
  return f ? Bun.file(f).text().catch(() => "") : "";
}

/** A stored session's transcript, or a subagent's (`<session>/<agent>`). */
export async function readHistory(nativeId: string, projectPath: string): Promise<Msg[]> {
  const { session, agent } = splitNative(nativeId);
  if (agent) {
    const child = storedSubagents(session, projectPath).find((c) => c.agentId === agent);
    const [list, text] = await Promise.all([getSubagentMessages(session, agent, { dir: projectPath }), fileText(child?.file)]);
    const msgs = historyMessages(list, entryMeta(text), true);
    linkSubagents(msgs, session, storedSubagents(session, projectPath));
    return msgs;
  }
  const file = sessionFile(session, projectPath);
  const msgs = file ? chainMessages((await readStore(file)).chain()) : [];
  linkSubagents(msgs, session, storedSubagents(session, projectPath));
  return msgs;
}

/** A session file's conversation (jsonl.ts, across compactions) as a transcript. */
export function chainMessages(chain: Entry[]): Msg[] {
  const meta: ReturnType<typeof entryMeta> = { flags: new Map(), times: new Map() };
  const list: Pick<SessionMessage, "type" | "uuid" | "message" | "parent_tool_use_id">[] = [];
  for (const e of chain) {
    if (e.type !== "user" && e.type !== "assistant" && e.type !== "system") continue;
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(t)) meta.times.set(e.uuid, t);
    if (e.isMeta || e.isCompactSummary || e.origin) meta.flags.set(e.uuid, { isMeta: e.isMeta, isCompactSummary: e.isCompactSummary, origin: e.origin });
    list.push({ type: e.type as SessionMessage["type"], uuid: e.uuid, message: e.type === "system" ? { subtype: e.subtype, content: e.message?.content } : e.message, parent_tool_use_id: null });
  }
  return historyMessages(list, meta);
}
