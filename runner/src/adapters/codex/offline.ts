// A private daemon may be gone while its native store remains. Listing/opening reads that store
// directly; discovery must never start a process, particularly after a key is unset.
import { stat } from "node:fs/promises";
import { remembered } from "./remember";
import { sourceHome, type PrivateSource } from "./sources";

const MAX = 256 * 1024 * 1024;
const paths = new Map<string, string>();
export async function privateRolloutPath(nativeId: string, source: PrivateSource): Promise<string | undefined> {
  const cached = paths.get(nativeId);
  if (cached && await Bun.file(cached).exists()) return cached;
  for await (const path of new Bun.Glob("sessions/**/*.jsonl").scan({ cwd: sourceHome(source), absolute: true })) {
    if (path.endsWith(`${nativeId}.jsonl`)) { paths.set(nativeId, path); return path; }
  }
}
const textOf = (content: any) => Array.isArray(content) ? content.map((c: any) => typeof c?.text === "string" ? c.text : "").filter(Boolean).join("\n") : "";
const parseArgs = (v: unknown) => { if (typeof v !== "string") return v ?? {}; try { return JSON.parse(v); } catch { return { input: v }; } };

/** Translate the native response/event records into the app-server's turn items. */
export function parsePrivateRollout(text: string, nativeId: string, source: PrivateSource): { thread: any; turns: any[] } {
  const turns: any[] = [];
  let turn: any;
  let meta: any = {};
  let latest: any = {};
  let preview = "";
  let updated = 0;
  const calls = new Map<string, any>();
  const start = (id: string, at: number) => {
    if (turn?.id === id) return turn;
    turn = { id, startedAt: at / 1000, completedAt: at / 1000, status: "completed", items: [] };
    turns.push(turn);
    return turn;
  };
  const add = (item: any, at: number) => { (turn ?? start(`offline-turn-${turns.length}`, at)).items.push(item); };
  const records: any[] = [];
  for (const line of text.split("\n")) try { records.push(JSON.parse(line)); } catch {}
  const hasUserEvents = records.some((r) => r.type === "event_msg" && r.payload?.type === "user_message");
  // A move's import comes before its first turn, and isn't a turn (move.ts importedMsgs).
  const firstTurn = remembered(nativeId)?.imported ? records.findIndex((r) => r.type === "event_msg" && (r.payload?.type === "task_started" || r.payload?.type === "turn_started")) : 0;
  for (let i = 0; i < records.length; i++) {
    const m = records[i]; const p = m.payload ?? {}; const at = Date.parse(m.timestamp ?? "") || 0;
    updated = Math.max(updated, at);
    const id = p.id ?? p.call_id ?? `offline-${m.ordinal ?? i}`;
    if (m.type === "session_meta") { meta = p; continue; }
    if (m.type === "turn_context") { latest = p; if (p.turn_id) start(p.turn_id, at); continue; }
    if (m.type === "compacted") { add({ type: "contextCompaction", id }, at); continue; }
    if (m.type === "event_msg") {
      if (p.type === "task_started" || p.type === "turn_started") { start(p.turn_id ?? `offline-turn-${i}`, at); continue; }
      if (p.type === "user_message") {
        preview ||= p.message ?? "";
        add({ type: "userMessage", id, content: [{ type: "text", text: p.message ?? "" }, ...(p.images ?? []).map((url: string) => ({ type: "image", url })), ...(p.local_images ?? []).map((path: string) => ({ type: "localImage", path }))] }, at);
      } else if (p.type === "exec_command_end") {
        const call = calls.get(p.call_id);
        if (call) Object.assign(call, { type: "commandExecution", command: call.arguments?.cmd ?? call.arguments?.command ?? (p.command ?? []).join(" "), aggregatedOutput: p.aggregated_output ?? p.stdout ?? "", exitCode: p.exit_code, status: "completed" });
      } else if (p.type === "error" && turn) {
        turn.status = "failed"; turn.error = { message: p.message ?? p.error?.message ?? "The Codex turn failed." };
      } else if (p.type === "turn_aborted" && turn) turn.status = "interrupted";
      else if ((p.type === "task_complete" || p.type === "turn_complete") && turn) turn.completedAt = at / 1000;
      continue;
    }
    if (m.type !== "response_item" || firstTurn < 0 || i < firstTurn) continue;
    if (p.type === "message" && p.role === "user" && !hasUserEvents) {
      const body = textOf(p.content);
      if (body.startsWith("<environment_context>")) continue;
      preview ||= body;
      add({ type: "userMessage", id, content: [{ type: "text", text: body }] }, at);
    } else if (p.type === "message" && p.role === "assistant") add({ type: "agentMessage", id, text: textOf(p.content), phase: p.phase }, at);
    else if (p.type === "reasoning") add({ type: "reasoning", id, summary: (p.summary ?? []).map((c: any) => c.text ?? ""), content: (p.content ?? []).map((c: any) => c.text ?? "") }, at);
    else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const item = { type: "dynamicToolCall", id: p.call_id ?? id, tool: p.name, arguments: p.type === "custom_tool_call" ? { input: p.input } : parseArgs(p.arguments), contentItems: [], status: "completed" };
      calls.set(p.call_id ?? id, item); add(item, at);
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const call = calls.get(p.call_id);
      if (call && call.type !== "commandExecution") call.contentItems = [{ type: "inputText", text: typeof p.output === "string" ? p.output : JSON.stringify(p.output) }];
    } else if (p.type === "web_search_call") add({ type: "webSearch", id, action: p.action, status: "completed" }, at);
  }
  const rememberedStart = remembered(nativeId)?.start;
  return {
    thread: { id: nativeId, cwd: meta.cwd ?? source.projectPath, modelProvider: meta.model_provider, path: undefined, preview, name: meta.name, createdAt: (Date.parse(meta.timestamp ?? "") || updated) / 1000, updatedAt: updated / 1000, status: { type: "idle" }, model: latest.model ?? rememberedStart?.model, reasoningEffort: latest.effort ?? rememberedStart?.effort, ...(meta.source?.subAgent?.thread_spawn?.parent_thread_id ? { parentThreadId: meta.source.subAgent.thread_spawn.parent_thread_id } : {}), source: meta.source },
    turns,
  };
}

export async function readPrivateRollout(nativeId: string, source: PrivateSource): Promise<{ thread: any; turns: any[] }> {
  const path = await privateRolloutPath(nativeId, source);
  if (!path) return { thread: { id: nativeId, cwd: source.projectPath, preview: "", modelProvider: undefined, updatedAt: (remembered(nativeId)?.at ?? 0) / 1000 }, turns: [] };
  const f = Bun.file(path);
  if (f.size > MAX) throw new Error("This Codex rollout is too large to read while its private process is offline.");
  const parsed = parsePrivateRollout(await f.text(), nativeId, source);
  parsed.thread.path = path;
  const st = await stat(path);
  parsed.thread.updatedAt = Math.max(parsed.thread.updatedAt, st.mtimeMs / 1000);
  return parsed;
}
