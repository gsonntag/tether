// Moving sessions out of and into Codex (SPEC §15).
//
// In: `thread/inject_items` (on whichever app-server has the thread: the shared daemon, or a key's
// private one), the daemon's own call for appending to a thread's model-visible
// history. It persists to the rollout and survives thread/resume (checked on daemon 0.166). Its
// items aren't turns, so the daemon's turn lists don't show them: `importedMsgs` reads them back
// from the rollout, marked in codex-threads.json, and the transcript starts with them (which is also
// what a later move exports). Only plain messages go in: no tool call, so no made-up call id.
//
// Out: the turns, with images a TUI attached by path. A compaction's summary is encrypted by Codex,
// so only a plain `message` can travel; nothing is lost, as the turns themselves stay readable.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { LEVELS, movedHistoryStart, type Level, type PortableItem } from "../../../../shared/move";
import { tetherOrigin } from "../../../../shared/fromTether";
import type { Msg, Part } from "../../../../shared/transcript";
import type { AdapterMove } from "../../core/adapter";
import { codexHistory, readThread, threadTurns } from "./discovery";
import { dropPending } from "./driver";
import { knownMode } from "./modes";
import { sourceBilling, threadCall } from "./sources";
import { CODEX_HOME } from "./rpc";
import { remember, remembered } from "./remember";

export function itemOf(i: PortableItem) {
  return i.role === "user"
    ? { type: "message", role: "user", content: [...(i.text ? [{ type: "input_text", text: i.text }] : []), ...(i.images ?? []).map((m) => ({ type: "input_image", image_url: `data:${m.mimeType};base64,${m.data}` }))] }
    : { type: "message", role: "assistant", content: [{ type: "output_text", text: i.text }] };
}

/** Injected at a time, in case one call has a size limit of its own. */
const BATCH_BYTES = 4 * 1024 * 1024;

export function batches<T>(items: T[], size: (t: T) => number, max = BATCH_BYTES): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let n = 0;
  for (const i of items) {
    const s = size(i);
    if (cur.length && n + s > max) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(i);
    n += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The imported history as a rollout has it: from Tether's opening to the first turn. */
export function importedFrom(rollout: string): Msg[] {
  const out: Msg[] = [];
  let started = false;
  for (const line of rollout.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === "event_msg" && d.payload?.type === "task_started") break;
    const p = d.payload;
    if (d.type !== "response_item" || p?.type !== "message" || (p.role !== "user" && p.role !== "assistant")) continue;
    const text = (p.content ?? []).filter((c: any) => c.type === "input_text" || c.type === "output_text").map((c: any) => c.text).join("\n");
    if (!started && !text.startsWith(movedHistoryStart)) continue;
    started = true;
    const id = `m-${p.id ?? out.length}`;
    const ts = Date.parse(d.timestamp) || 0;
    if (p.role === "assistant") {
      out.push({ id, role: "assistant", ts, parts: [{ type: "text", text }] });
      continue;
    }
    const tether = tetherOrigin(text);
    if (tether) {
      out.push({ id, role: "user", ts, origin: tether.origin, parts: [{ type: "text", text: tether.text }] });
      continue;
    }
    const images: Part[] = (p.content ?? []).flatMap((c: any) => {
      const m = c.type === "input_image" && /^data:([\w/+.-]+);base64,(.*)$/s.exec(c.image_url ?? "");
      return m ? [{ type: "image" as const, mimeType: m[1]!, data: m[2]! }] : [];
    });
    out.push({ id, role: "user", ts, parts: [...(text ? [{ type: "text" as const, text }] : []), ...images] });
  }
  return out;
}

/** The head of a rollout never changes, so each thread's is read once. */
const cache = new Map<string, Msg[]>();

/** What was imported into a thread (nothing, for one that wasn't). */
export async function importedMsgs(nativeId: string): Promise<Msg[]> {
  if (!remembered(nativeId)?.imported) return [];
  const had = cache.get(nativeId);
  if (had) return had;
  const path = (await readThread(nativeId))?.path;
  if (!path) return [];
  const msgs = importedFrom(await readFile(path, "utf8"));
  if (msgs.length) cache.set(nativeId, msgs);
  return msgs;
}

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** A user message's images only its turns name by path (a TUI's), read now; ones gone stay "[image]". */
async function pathImages(msgs: Msg[], turns: any[]) {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  for (const t of turns)
    for (const item of t.items ?? []) {
      if (item.type !== "userMessage") continue;
      const m = byId.get(`u-${item.id}`);
      if (!m || m.parts.some((p) => p.type === "image")) continue;
      for (const c of item.content ?? []) {
        if (c.type !== "localImage" || typeof c.path !== "string") continue;
        const mimeType = MIME[extname(c.path).toLowerCase()];
        const data = mimeType && (await stat(c.path).then((s) => s.size < 20_000_000, () => false)) ? (await readFile(c.path)).toString("base64") : undefined;
        if (data) m.parts.push({ type: "image", mimeType, data });
      }
    }
}

/** A compaction's plain summary, in order; Codex's own are encrypted and read as empty. */
function compactions(rollout: string): string[] {
  const out: string[] = [];
  for (const line of rollout.split("\n")) {
    if (!line.includes('"compacted"')) continue;
    try {
      const d = JSON.parse(line);
      if (d.type === "compacted") out.push(typeof d.payload?.message === "string" ? d.payload.message : "");
    } catch {}
  }
  return out;
}

const windows = async (): Promise<Record<string, number>> => {
  const file = join(CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
  const list = JSON.parse(await readFile(file, "utf8"))?.models ?? [];
  return Object.fromEntries(list.filter((m: any) => m?.slug && m?.context_window).map((m: any) => [m.slug, m.context_window]));
};

/** A thread whose import failed leaves no row. */
const forget = (nativeId: string) => threadCall(nativeId, "thread/archive", { threadId: nativeId }).catch(() => undefined);

const PRESETS: { mode: string; level: Level }[] = [
  { mode: "read-only", level: LEVELS.readOnly },
  { mode: "untrusted", level: LEVELS.ask },
  { mode: "auto", level: LEVELS.sandboxed },
  { mode: "full-access", level: LEVELS.full },
];

export const codexMove: AdapterMove = {
  modes: PRESETS,

  /** A combination, by its tighter side: a read-only sandbox never gets past read-only, and asking is asking. */
  levelOf(mode) {
    const m = knownMode(mode);
    if (!m) return undefined;
    if (m.sandbox === "read-only") return LEVELS.readOnly;
    if (m.approvalPolicy === "untrusted") return LEVELS.ask;
    return m.sandbox === "workspace-write" ? LEVELS.sandboxed : m.approvalPolicy === "never" ? LEVELS.full : LEVELS.sandboxed;
  },

  async exportHistory(nativeId, projectPath) {
    const msgs = await codexHistory(nativeId, projectPath);
    const t = await readThread(nativeId);
    await pathImages(msgs, await threadTurns(nativeId));
    const summaries = t?.path ? compactions(await readFile(t.path, "utf8").catch(() => "")) : [];
    let n = 0;
    const own = msgs.map((m) => {
      if (!m.id.startsWith("c-")) return m;
      const s = summaries[n++];
      return s ? { ...m, compactSummary: s } : m;
    });
    return [...(await importedMsgs(nativeId)), ...own];
  },

  async importHistory(r) {
    try {
      for (const b of batches(r.items.map(itemOf), (i) => JSON.stringify(i).length)) await threadCall(r.nativeId, "thread/inject_items", { threadId: r.nativeId, items: b }, 60_000);
      await threadCall(r.nativeId, "thread/name/set", { threadId: r.nativeId, name: r.title });
      remember(r.nativeId, { imported: true });
    } catch (e) {
      await forget(r.nativeId);
      throw e;
    } finally {
      // Nothing to wait for: it's on disk, and its first send joins it like any stored thread.
      dropPending(r.nativeId);
    }
  },

  async imported(r) {
    const ok = (await importedMsgs(r.nativeId)).length === r.items.length;
    if (!ok) await forget(r.nativeId);
    return ok;
  },

  setTitle: async (nativeId, _projectPath, title) => void (await threadCall(nativeId, "thread/name/set", { threadId: nativeId, name: title })),

  billingOf: (source) => (source === "openai" || source === "azure" ? sourceBilling(source) : { kind: "plan", label: "ChatGPT plan" }),

  async contextWindow(model) {
    const w = await windows();
    if (model && model !== "default") return w[model];
    const all = Object.values(w);
    return all.length ? Math.min(...all) : undefined;
  },

  async busy(nativeId) {
    return (await readThread(nativeId))?.status?.type === "active";
  },
};
