// Antigravity's store and the reader that reads it (SPEC §6). Conversations live in
// ~/.gemini/antigravity-cli/conversations/<id>.db: SQLite whose rows are undocumented protobuf, so
// Tether doesn't parse them. It asks Antigravity instead, through one shared `agy acp` process: `session/list` for
// discovery, and `session/load`, which replays a conversation as `session/update`s, for history.
// That process starts on first use and quits after a while idle. The files themselves only say
// whether a conversation exists and when it last changed.

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextUse, Msg } from "../../../../shared/transcript";
import { AcpClient, type AcpUpdate } from "../acp/client";
import { AcpTranscript } from "../acp/transcript";
import { HARNESS_BINS } from "../detect";
import { registerLanguageServer, unregisterLanguageServer } from "./quota";

/** Antigravity's own folder (read each time, so tests can point it elsewhere). */
export const agyHome = () => process.env.AGY_HOME || join(homedir(), ".gemini", "antigravity-cli");
export const conversationFile = (nativeId: string) => join(agyHome(), "conversations", `${nativeId}.db`);

/** Deletes a conversation's SQLite store files and brain directory (used for throwaway probes and discarded forks). */
export function discardStore(nativeId: string) {
  for (const f of [conversationFile(nativeId), `${conversationFile(nativeId)}-wal`, `${conversationFile(nativeId)}-shm`]) rmSync(f, { force: true });
  rmSync(join(agyHome(), "brain", nativeId), { recursive: true, force: true });
}

/** The process Tether starts for ACP: `agy acp`. */
export const acpArgv = () => [HARNESS_BINS.antigravity, "acp"];

/** When a conversation's store last changed (ms), with its write-ahead log; undefined if it has none. */
export function storeStamp(nativeId: string): { at: number; rev: string } | undefined {
  let at = 0;
  const rev: string[] = [];
  for (const f of [conversationFile(nativeId), `${conversationFile(nativeId)}-wal`]) {
    try {
      const s = statSync(f);
      at = Math.max(at, s.mtimeMs);
      rev.push(`${s.ino}:${s.mtimeMs}:${s.size}`);
    } catch {}
  }
  return rev.length ? { at, rev: rev.join("|") } : undefined;
}

export const hasStore = (nativeId: string) => existsSync(conversationFile(nativeId));

// ---------- message dates ----------

/**
 * Antigravity keeps no time per message. A message is dated when Tether first sees it: live, when
 * it happens; read from the store, the store's last change. Kept in memory so a later read dates it the same.
 */
const stamps = new Map<string, number[]>();
export function stampOf(nativeId: string, fallback: () => number) {
  let list = stamps.get(nativeId);
  if (!list) stamps.set(nativeId, (list = []));
  return (n: number) => (list![n] ??= fallback());
}

// ---------- what a session last showed of itself ----------

/** A session's settings as Antigravity last reported them (a load, a live process). */
export interface AgySettings {
  model?: string;
  effort?: string;
  permissionMode?: string;
}
export const seenSettings = new Map<string, AgySettings>();
export const seenContext = new Map<string, ContextUse>();
/** Titles Antigravity gave sessions, newer than a cached listing. */
export const seenTitles = new Map<string, string>();

/** The settings in a `configOptions` list (and modes), as Tether names them. */
export function settingsOf(config: any[] | undefined, mode?: string): AgySettings {
  const value = (id: string) => {
    const o = config?.find((c) => c?.id === id || c?.category === id);
    return typeof o?.currentValue === "string" ? o.currentValue : undefined;
  };
  const model = value("model");
  const effort = value("thought_level");
  const permissionMode = mode ?? value("mode");
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) };
}

/** How long a cached model/option list is reused before asking `agy acp` again. */
const CONFIG_MS = 10 * 60_000;

/** The options Antigravity offers (models, thinking levels, modes), from the latest session it opened. */
export let lastConfig: any[] | undefined;
let lastConfigAt = 0;
/** Full per-variant model list (`models.availableModels`) from the latest session opened. */
export let lastAvailableModels: { modelId?: string; name?: string }[] | undefined;
/** Its account's tier ("Google AI Pro"), when it says. */
export let lastTier: string | undefined;
/** Its commands and skills, as a session last listed them. */
export let lastCommands: { name: string; description?: string }[] | undefined;

/** Notes what a `session/new` or `session/load` answered. */
export function noteOpened(r: any) {
  if (Array.isArray(r?.configOptions)) {
    lastConfig = r.configOptions;
    lastConfigAt = Date.now();
  }
  if (Array.isArray(r?.models?.availableModels)) lastAvailableModels = r.models.availableModels;
  const tier = r?._meta?.antigravity?.tier?.name;
  if (typeof tier === "string" && tier) lastTier = tier;
}
export const noteCommands = (list: { name: string; description?: string }[]) => void (lastCommands = list);

// ---------- the reader ----------

export interface AgySession {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

/** How long a listing is reused (a listing takes Antigravity about a second). */
const LIST_MS = 10_000;
/** After a replay's answer: the updates that follow it (context, title) arrive within this. */
const TRAILING_MS = 150;
/** How many reader processes may run at once. */
const MAX_READERS = 3;

/** An RFC 3339 time as ms; Antigravity says "0001-01-01T00:00:00Z" (Go's zero time) for none. */
const timeOf = (v: unknown) => {
  const at = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(at) && at > 0 ? at : undefined;
};

/**
 * Reads through a fresh `agy acp` for each call: a process keeps the conversations it has seen in
 * memory and never sees another process's turns (checked on 1.5.13), so a long-lived one would read
 * stale history. One starts in about 160 ms.
 */
class Reader {
  private running = 0;
  private waiting: (() => void)[] = [];
  private listed?: { at: number; list: Promise<AgySession[]> };
  private clients = new Set<AcpClient>();

  private async use<T>(f: (c: AcpClient, onUpdate: (h: (sid: string, u: AcpUpdate) => void) => void) => Promise<T>): Promise<T> {
    if (this.running >= MAX_READERS) await new Promise<void>((ok) => this.waiting.push(ok));
    this.running++;
    let handler: ((sid: string, u: AcpUpdate) => void) | undefined;
    const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN || randomUUID();
    const c = new AcpClient({
      argv: acpArgv(),
      cwd: homedir(),
      env: { ANTIGRAVITY_CSRF_TOKEN: csrfToken },
      name: "Antigravity",
      onUpdate: (sid, u) => {
        handler?.(sid, u);
        if (u.sessionUpdate === "available_commands_update" && Array.isArray(u.availableCommands)) noteCommands(u.availableCommands.filter((x: any) => typeof x?.name === "string").map((x: any) => ({ name: x.name, ...(typeof x.description === "string" ? { description: x.description } : {}) })));
      },
      // A reader asks nothing; were it asked, it refuses.
      onRequest: async (method) => (method === "session/request_permission" ? { outcome: { outcome: "cancelled" } } : Promise.reject(new Error("Not supported."))),
    });
    this.clients.add(c);
    registerLanguageServer(c.pid, csrfToken);
    try {
      await c.initialize();
      return await f(c, (h) => (handler = h));
    } finally {
      unregisterLanguageServer(c.pid);
      this.clients.delete(c);
      await c.close();
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Every conversation Antigravity lists (one with no prompt yet isn't). */
  list(): Promise<AgySession[]> {
    if (this.listed && Date.now() - this.listed.at < LIST_MS) return this.listed.list;
    const list = this.use(async (c) => {
      const out: AgySession[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 50; i++) {
        const r: any = await c.call("session/list", cursor ? { cursor } : {});
        for (const s of r?.sessions ?? []) {
          if (typeof s?.sessionId !== "string" || typeof s.cwd !== "string") continue;
          out.push({ sessionId: s.sessionId, cwd: s.cwd, title: typeof s.title === "string" ? s.title : "", updatedAt: timeOf(s.updatedAt) ?? storeStamp(s.sessionId)?.at ?? Date.now() });
        }
        cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
        if (!cursor) break;
      }
      return out;
    });
    this.listed = { at: Date.now(), list };
    list.catch(() => (this.listed = undefined));
    return list;
  }

  /** The next listing asks again (a session started, got a title). */
  forget() {
    this.listed = undefined;
  }

  /** A conversation's transcript, replayed (`session/load`), and what came with it. */
  replay(nativeId: string, cwd: string): Promise<{ msgs: Msg[]; context?: ContextUse; title?: string }> {
    return this.use(async (c, onUpdate) => {
      const stamp = storeStamp(nativeId)?.at ?? Date.now();
      let context: ContextUse | undefined;
      let title: string | undefined;
      let mode: string | undefined;
      let config: any[] | undefined;
      const t = new AcpTranscript("m", {
        stamp: stampOf(nativeId, () => stamp),
        context: (x) => (context = x),
        title: (x) => (title = x),
        mode: (x) => (mode = x),
        config: (x) => (config = x),
      });
      onUpdate((sid, u) => sid === nativeId && t.update(u));
      const r: any = await c.call("session/load", { sessionId: nativeId, cwd, mcpServers: [] }, 120_000);
      noteOpened(r);
      await Bun.sleep(TRAILING_MS);
      mode ??= typeof r?.modes?.currentModeId === "string" ? r.modes.currentModeId : undefined;
      seenSettings.set(nativeId, settingsOf(config ?? r?.configOptions, mode));
      if (context) seenContext.set(nativeId, context);
      if (title) seenTitles.set(nativeId, title);
      return { msgs: t.settled(), ...(context ? { context } : {}), ...(title ? { title } : {}) };
    });
  }

  /** A new conversation in `cwd`: Antigravity picks its id. It's stored, but not listed until its first prompt. */
  create(cwd: string): Promise<string> {
    return this.use(async (c) => {
      const r: any = await c.call("session/new", { cwd, mcpServers: [] });
      noteOpened(r);
      const id = r?.sessionId;
      if (typeof id !== "string" || !id) throw new Error("Antigravity didn't make a session.");
      return id;
    });
  }

  /**
   * Antigravity's options (models, thinking levels, modes) and variant list, asked of it when none
   * is cached or the cache has aged out. Uses a throwaway `session/new` (agy 1.5.19 rejects
   * `session/load` for unknown session ids) and discards its empty store immediately.
   */
  async configInfo(): Promise<{ config: any[]; availableModels?: { modelId?: string; name?: string }[] }> {
    if (lastConfig && Date.now() - lastConfigAt < CONFIG_MS) return { config: lastConfig, availableModels: lastAvailableModels };
    const tmp = mkdtempSync(join(tmpdir(), "tether-agy-cfg-"));
    let sid: string | undefined;
    try {
      await this.use(async (c) => {
        const r: any = await c.call("session/new", { cwd: tmp, mcpServers: [] });
        sid = typeof r?.sessionId === "string" ? r.sessionId : undefined;
        noteOpened(r);
        if (sid) await c.call("session/close", { sessionId: sid }, 5000).catch(() => {});
      });
    } finally {
      if (sid) discardStore(sid);
      rmSync(tmp, { recursive: true, force: true });
    }
    return { config: lastConfig ?? [], availableModels: lastAvailableModels };
  }

  /** Antigravity's options (models, thinking levels, modes), asked of it if no session has said yet. */
  async config(): Promise<any[]> {
    return (await this.configInfo()).config;
  }

  async close() {
    await Promise.all([...this.clients].map((c) => c.close()));
  }
}

export const reader = new Reader();
