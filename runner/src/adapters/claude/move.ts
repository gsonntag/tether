// Moving sessions out of and into Claude Code (SPEC §15).
//
// Out: the store's transcript, plus what the view leaves out: each compaction's summary.
//
// In: Claude Code has no import call. The Agent SDK's SessionStore takes the same private entries
// and only adds an alpha API and a temporary copy, so the session is written where Claude Code keeps
// them: a linear chain of user and assistant entries, the smallest shape `resume` reads (checked on
// 2.1.316). The risk is that format changing, so nothing else is written, the SDK's public reader
// must read every entry back (`imported`), and if it doesn't the module uses the file route. Titles
// go through the SDK's renameSession.

import { getSessionMessages, renameSession } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEVELS, type Level, type PortableItem } from "../../../../shared/move";
import type { Msg } from "../../../../shared/transcript";
import type { AdapterMove, ImportRequest } from "../../core/adapter";
import { movedDir } from "../../core/moved";
import { windowOf } from "./context";
import { readHistory } from "./history";
import { readStore, type Entry } from "./jsonl";
import { claudeModels } from "./models";
import { projectsDir, sessionFile } from "./paths";

/** An imported reply's model: no real model said it, and readers treat "<…>" as nothing to show or keep. */
export const IMPORTED_MODEL = "<moved>";

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

const contentOf = (i: PortableItem) => {
  const images = (i.images ?? []).map((m) => ({ type: "image", source: { type: "base64", media_type: m.mimeType, data: m.data } }));
  return [...(i.text ? [{ type: "text", text: i.text }] : []), ...images];
};

/** The items as store lines, each the parent of the next. */
export function entriesOf(r: Pick<ImportRequest, "nativeId" | "projectPath" | "items">, version?: string): string[] {
  let parentUuid: string | null = null;
  return r.items.map((i, n) => {
    const uuid = randomUUID();
    const base = { parentUuid, isSidechain: false, userType: "external", entrypoint: "sdk-ts", cwd: r.projectPath, sessionId: r.nativeId, ...(version ? { version } : {}), uuid, timestamp: new Date(i.ts || Date.now() + n).toISOString() };
    parentUuid = uuid;
    return JSON.stringify(
      i.role === "user"
        ? { ...base, type: "user", message: { role: "user", content: contentOf(i) } }
        : { ...base, type: "assistant", message: { id: randomUUID(), type: "message", role: "assistant", model: IMPORTED_MODEL, content: contentOf(i), stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
    );
  });
}

/** Each compaction's summary, on its "Context compacted." notice. */
export function withSummaries(msgs: Msg[], chain: Entry[]): Msg[] {
  const summaries = chain.filter((e) => e.isCompactSummary).map((e) => {
    const c = e.message?.content;
    return typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b?.text ?? "").join("\n") : "";
  });
  let n = 0;
  return msgs.map((m) => (m.role === "notice" && (m.parts[0] as any)?.text === "Context compacted." && summaries[n] ? { ...m, compactSummary: summaries[n++] } : m));
}

const MODES: { mode: string; level: Level }[] = [
  { mode: "plan", level: LEVELS.readOnly },
  { mode: "default", level: LEVELS.ask },
  { mode: "acceptEdits", level: LEVELS.edits },
  { mode: "bypassPermissions", level: LEVELS.full },
];

export const claudeMove: AdapterMove = {
  modes: MODES,
  levelOf(mode) {
    // Modes it's never moved *into*: auto depends on the model, and don't-ask on the person's rules.
    if (mode === "auto") return LEVELS.judged;
    if (mode === "dontAsk") return LEVELS.ask;
    return undefined;
  },

  async exportHistory(nativeId, projectPath) {
    const msgs = await readHistory(nativeId, projectPath);
    const file = sessionFile(nativeId, projectPath);
    return file ? withSummaries(msgs, (await readStore(file)).chain()) : msgs;
  },

  async importHistory(r) {
    const dir = join(projectsDir(), encode(r.projectPath));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${r.nativeId}.jsonl`);
    try {
      writeFileSync(file, `${entriesOf(r).join("\n")}\n`, { mode: 0o600, flag: "wx" });
      await renameSession(r.nativeId, r.title, { dir: r.projectPath });
    } catch (e) {
      rmSync(file, { force: true });
      throw e;
    }
  },

  async imported(r) {
    const n = (await getSessionMessages(r.nativeId, { dir: r.projectPath }).catch(() => [])).length;
    const ok = n === r.items.length;
    if (!ok) {
      const f = sessionFile(r.nativeId, r.projectPath);
      if (f) rmSync(f, { force: true });
    }
    return ok;
  },


  setTitle: (nativeId, projectPath, title) => renameSession(nativeId, title, { dir: projectPath }),

  async contextWindow(model) {
    if (!model) return undefined;
    const resolved = (await claudeModels()).models.find((m) => m.id === model)?.resolved ?? model;
    return windowOf(resolved.replace(/\[1m\]$/, ""), "");
  },
};

/** The rule that lets a moved session read its own history without asking; nothing else is opened. */
export const movedReadRule = (nativeId: string) => `Read(/${movedDir(`claude:${nativeId}`)}/**)`;
