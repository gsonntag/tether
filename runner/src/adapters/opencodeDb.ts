// opencode's own store: a SQLite database (~/.local/share/opencode/opencode.db) with tables
// session, message and part, each row's content as JSON in `data`. Reading it read-only shows a
// stored conversation without starting `opencode acp` just to replay it (acp.ts loadSession).
// Anything unexpected (no database, another schema, a session it doesn't have) reads as undefined:
// the caller falls back to that replay.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextUsage, Msg, Part } from "../../../web/src/shared/protocol";
import { userParts } from "../../../web/src/shared/bash";
import { checklistMarkdown } from "../../../web/src/shared/plan";
import { mergeContext } from "../contextWindow";
import type { StoredHistory } from "./types";

export function opencodeDbPath(): string {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  const data = process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), ".local", "share");
  return join(data, "opencode", "opencode.db");
}

const NEEDED: Record<string, string[]> = {
  session: ["id"],
  message: ["id", "session_id", "time_created", "data"],
  part: ["id", "message_id", "session_id", "data"],
};

/** The tables and columns this reader uses are all there. */
function schemaOk(db: Database): boolean {
  for (const [table, cols] of Object.entries(NEEDED)) {
    const have = new Set((db.query(`select name from pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name));
    if (!cols.every((c) => have.has(c))) return false;
  }
  return true;
}

const json = (s: unknown): any => {
  try {
    return typeof s === "string" ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
};

/** Reads one session; undefined when the database, its schema or the session isn't as expected. */
export function readOpencodeSession(nativeId: string, path = opencodeDbPath()): StoredHistory | undefined {
  if (!existsSync(path)) return undefined;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    if (!schemaOk(db)) return undefined;
    if (!db.query("select id from session where id = ?").get(nativeId)) return undefined;
    const messages = db.query("select id, time_created, data from message where session_id = ? order by time_created, id").all(nativeId) as { id: string; time_created: number; data: string }[];
    const parts = db.query("select id, message_id, data from part where session_id = ? order by message_id, id").all(nativeId) as { id: string; message_id: string; data: string }[];
    const byMsg = new Map<string, any[]>();
    for (const p of parts) {
      const d = json(p.data);
      if (!d || typeof d !== "object") continue;
      const list = byMsg.get(p.message_id) ?? [];
      list.push({ ...d, id: d.id ?? p.id });
      byMsg.set(p.message_id, list);
    }
    return opencodeHistory(messages.map((m) => ({ id: m.id, time: m.time_created, info: json(m.data) ?? {}, parts: byMsg.get(m.id) ?? [] })));
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export interface OpencodeRow {
  id: string;
  /** message.time_created (ms) */
  time: number;
  /** message.data */
  info: any;
  /** part.data of its parts, in order */
  parts: any[];
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const modelOf = (info: any) => (info?.modelID ? [info.providerID, info.modelID].filter(Boolean).join("/") : info?.model?.modelID ? [info.model.providerID, info.model.modelID].filter(Boolean).join("/") : undefined);

/** opencode's tool state as a Tether tool part, shaped like the ACP replay shows it (acp.ts toolPatch). */
function toolPart(p: any): Part {
  const st = p.state ?? {};
  const raw = st.input ?? {};
  const name = str(p.tool) || "tool";
  let input: unknown = raw;
  // Edits show as their diff; a write is its content.
  if (name === "edit" && (raw.oldString !== undefined || raw.newString !== undefined))
    input = { path: raw.filePath ?? raw.path, edits: [{ oldText: raw.oldString ?? "", newText: raw.newString ?? "" }] };
  const status = st.status === "completed" ? "done" : st.status === "error" ? "error" : "error"; // stored: nothing still runs
  const output = st.status === "error" ? str(st.error) : typeof st.output === "string" ? st.output : st.output !== undefined ? JSON.stringify(st.output, null, 2) : undefined;
  return { type: "tool", id: str(p.callID) || str(p.id) || "tool", name, input, status, ...(output ? { output } : {}) } as Part;
}

/** A user message's text (opencode's synthetic parts, like files it read for you, aren't what you typed). */
function userMsg(r: OpencodeRow): Msg | undefined {
  const parts: Part[] = [];
  const text = r.parts
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n\n");
  if (text.trim()) parts.push(...userParts(text, r.id));
  for (const p of r.parts) {
    const m = typeof p.url === "string" && p.url.match(/^data:(image\/[\w.+-]+);base64,(.*)$/s);
    if (p.type === "file" && m) parts.push({ type: "image", mimeType: m[1]!, data: m[2]! });
  }
  return parts.length ? { id: r.id, role: "user", parts, ts: r.info?.time?.created ?? r.time ?? 0 } : undefined;
}

function assistantMsg(r: OpencodeRow): Msg | undefined {
  const parts: Part[] = [];
  for (const p of r.parts) {
    if (p.type === "text" && typeof p.text === "string" && p.text && !p.synthetic) parts.push({ type: "text", text: p.text });
    else if (p.type === "reasoning" && typeof p.text === "string" && p.text.trim()) parts.push({ type: "thinking", text: p.text });
    else if (p.type === "tool") {
      parts.push(toolPart(p));
      // The todo list is opencode's plan (ACP sends it as one): its checklist follows the call.
      const todos = p.tool === "todowrite" ? p.state?.input?.todos : undefined;
      if (Array.isArray(todos) && todos.length)
        parts.push({ type: "plan", id: `plan-${str(p.callID) || str(p.id)}`, text: checklistMarkdown(todos.map((t: any) => ({ content: String(t.content ?? ""), status: t.status }))), checklist: true });
    }
  }
  const err = r.info?.error;
  const error = err ? str(err.data?.message) || str(err.message) || str(err.name) || "The turn failed." : undefined;
  if (!parts.length && !error) return undefined;
  return { id: r.id, role: "assistant", parts, ts: r.info?.time?.created ?? r.time ?? 0, model: modelOf(r.info), ...(error ? { error: err?.name === "MessageAbortedError" ? "aborted" : error } : {}) };
}

/** The rows of one session (oldest first) as a Tether transcript, with its last context fill and settings. */
export function opencodeHistory(rows: OpencodeRow[]): StoredHistory {
  const messages: Msg[] = [];
  let context: ContextUsage | undefined;
  let model: string | undefined;
  let mode: string | undefined;
  for (const r of rows) {
    const role = r.info?.role;
    const m = role === "user" ? userMsg(r) : role === "assistant" ? assistantMsg(r) : undefined;
    if (m) messages.push(m);
    if (role === "user" || role === "assistant") {
      model = modelOf(r.info) ?? model;
      mode = str(r.info?.agent) ?? str(r.info?.mode) ?? mode;
    }
    const t = role === "assistant" ? r.info?.tokens : undefined;
    if (t && typeof t === "object") {
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const used = n(t.total) || n(t.input) + n(t.output) + n(t.reasoning) + n(t.cache?.read) + n(t.cache?.write);
      if (used) context = mergeContext(undefined, { used, input: n(t.input), cacheRead: n(t.cache?.read), cacheWrite: n(t.cache?.write), ...(modelOf(r.info) ? { model: modelOf(r.info) } : {}) });
    }
  }
  return { messages, context, model, permissionMode: mode };
}
