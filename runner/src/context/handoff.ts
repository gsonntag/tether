// Memory across a handoff (runner/src/handoff.ts): when a conversation moves to another harness,
//   carry    the memories that matter for it go into the brief: global user/feedback entries, this
//            repo's entries and the ones most relevant to the task, within a token budget, minus
//            whatever the new harness already gets from its own injection (inject.ts)
//   capture  before leaving, the background model pulls 0-3 durable facts out of the outgoing
//            transcript (since the last capture) and files them in the inbox, so the normal merge
//            pass dedupes, updates or flags them with the session as their source
// Both only run when the master context is enabled; a capture that's slow never holds up the handoff.

import { join } from "node:path";
import type { HarnessId, MemoryEntry, Msg } from "../../../web/src/shared/protocol";
import { renderTranscript } from "../handoff";
import { parseJsonReply, runBackground } from "./background";
import { asType, contentHash, sha, similarity, words, type MemoryType } from "./format";
import { globalDigestLayout, repoDigestLayout } from "./export";
import { writeAtomic, type Store } from "./store";

/** Harnesses whose sessions get sessionContext() at start (every adapter calls it today). */
export const INJECTING: ReadonlySet<HarnessId> = new Set<HarnessId>(["claude-code", "codex", "pi", "opencode", "kiro", "antigravity"]);

/** Ids the new session's native injection already shows in full: the brief leaves them out. */
export function nativeIds(store: Store, key: string, harness: HarnessId, all = store.list()): Set<string> {
  if (!INJECTING.has(harness)) return new Set();
  const ids = new Set(globalDigestLayout(store, all).full.map((m) => m.id));
  for (const m of repoDigestLayout(store, key, all)?.full ?? []) ids.add(m.id);
  return ids;
}

// ---------------- carry ----------------

export type CarrySection = "relevant" | "global" | "repo";

export interface CarriedMemory {
  id: string;
  name: string;
  description: string;
  scope: string;
  section: CarrySection;
  /** false: only its name and description fit (an index line) */
  full: boolean;
}

/** A fact captured from the outgoing session (not yet merged into the store). */
export interface CapturedFact {
  text: string;
  name?: string;
  type?: MemoryType;
  scope?: "global" | "repo";
}

export interface HandoffMemory {
  /** markdown for the brief's memory section ("" when there is nothing to add) */
  text: string;
  carried: CarriedMemory[];
  /** entries the new harness already gets from its native injection */
  native: number;
  captured: CapturedFact[];
  /** capture outcome, for the notice */
  captureNote?: string;
  /** files the captured facts for merging; call once the new session has started */
  settle?: () => void;
}

export const DEFAULT_BUDGET_TOKENS = 1500;
const MAX_RELEVANT = 8;
const MIN_RELEVANCE = 0.12;
const RECENT_USER_MESSAGES = 4;

/** ~4 characters per token: close enough for budgeting prose. */
export const tokens = (s: string) => Math.ceil(s.length / 4);

export function userText(m: Msg): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();
}

/**
 * What the session is about, weighted: the message about to be sent, the last few user messages
 * (most recent first) and the first one (usually the task).
 */
export function relevanceQueries(messages: Msg[], pendingPrompt?: string): { text: string; weight: number }[] {
  const users = messages.filter((m) => m.role === "user").map(userText).filter(Boolean);
  const out: { text: string; weight: number }[] = [];
  if (pendingPrompt?.trim()) out.push({ text: pendingPrompt, weight: 3 });
  const recent = users.slice(-RECENT_USER_MESSAGES).reverse();
  recent.forEach((text, i) => out.push({ text, weight: 2.5 * 0.6 ** i }));
  if (users.length > RECENT_USER_MESSAGES) out.push({ text: users[0]!, weight: 1.5 });
  return out;
}

/** Relevance of each memory to the session, 0..~2. Name and description count double. */
export function scoreMemories(entries: MemoryEntry[], queries: { text: string; weight: number }[]): Map<string, number> {
  const qs = queries.map((q) => ({ w: words(q.text), weight: q.weight })).filter((q) => q.w.size);
  const total = qs.reduce((n, q) => n + q.weight, 0);
  const out = new Map<string, number>();
  if (!total) return out;
  for (const m of entries) {
    const head = words(`${m.name.replace(/-/g, " ")} ${m.description}`);
    const all = words(`${m.name.replace(/-/g, " ")} ${m.description} ${m.body}`);
    let s = 0;
    for (const q of qs) s += q.weight * (similarity(q.w, head) * 2 + similarity(q.w, all));
    out.set(m.id, s / total);
  }
  return out;
}

const fullBlock = (m: MemoryEntry) => `#### ${m.name}${m.type ? ` (${m.type})` : ""}\n${m.body.trim()}`;
const indexLine = (m: MemoryEntry) => `- **${m.name}**: ${m.description}`;

const SECTION_TITLES: Record<CarrySection, string> = {
  relevant: "Relevant to this task",
  global: "About the user (global)",
  repo: "This repository",
};

/**
 * The brief's memory section. Priority when the budget is tight: relevant, then global
 * user/feedback, then repo; an entry that doesn't fit in full falls back to an index line. Each
 * memory appears once, and never when the native injection already shows it in full.
 */
export function assembleHandoffMemory(opts: {
  entries: MemoryEntry[];
  repoKey: string;
  messages: Msg[];
  pendingPrompt?: string;
  /** ids the target harness already gets in full (nativeIds) */
  native?: Set<string>;
  budgetTokens?: number;
  captured?: CapturedFact[];
  captureNote?: string;
}): HandoffMemory {
  const native = opts.native ?? new Set<string>();
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const repoScope = `repo:${opts.repoKey}`;
  const pool = opts.entries.filter((m) => (m.scope === "global" || m.scope === repoScope) && !native.has(m.id));
  const newest = (a: MemoryEntry, b: MemoryEntry) => b.updated.localeCompare(a.updated);

  const scores = scoreMemories(pool, relevanceQueries(opts.messages, opts.pendingPrompt));
  const relevant = pool
    .filter((m) => (scores.get(m.id) ?? 0) >= MIN_RELEVANCE)
    .sort((a, b) => scores.get(b.id)! - scores.get(a.id)! || newest(a, b))
    .slice(0, MAX_RELEVANT);
  const taken = new Set(relevant.map((m) => m.id));
  const global = pool.filter((m) => m.scope === "global" && (m.type === "user" || m.type === "feedback") && !taken.has(m.id)).sort(newest);
  global.forEach((m) => taken.add(m.id));
  const repo = pool.filter((m) => m.scope === repoScope && !taken.has(m.id)).sort(newest);

  // Captured facts are short and come first: they are the freshest knowledge there is.
  const captured = (opts.captured ?? []).filter((f) => f.text.trim());
  const capturedText = captured.length ? `### Noted from the previous session\n${captured.map((f) => `- ${f.text.trim().replace(/\n+/g, " ")}`).join("\n")}` : "";
  let used = tokens(capturedText);

  const chosen: Record<CarrySection, { m: MemoryEntry; full: boolean }[]> = { relevant: [], global: [], repo: [] };
  let omitted = 0;
  for (const [section, list] of [["relevant", relevant], ["global", global], ["repo", repo]] as const) {
    for (const m of list) {
      const header = chosen[section].length ? 0 : tokens(`### ${SECTION_TITLES[section]}\n`);
      const block = tokens(fullBlock(m)) + 1;
      const line = tokens(indexLine(m)) + 1;
      if (used + header + block <= budget) {
        chosen[section].push({ m, full: true });
        used += header + block;
      } else if (used + header + line <= budget) {
        chosen[section].push({ m, full: false });
        used += header + line;
      } else omitted++;
    }
  }

  const parts: string[] = [];
  if (capturedText) parts.push(capturedText);
  for (const section of ["relevant", "global", "repo"] as const) {
    const list = chosen[section];
    if (!list.length) continue;
    const full = list.filter((x) => x.full).map((x) => fullBlock(x.m));
    const lines = list.filter((x) => !x.full).map((x) => indexLine(x.m));
    parts.push([`### ${SECTION_TITLES[section]}`, ...full, ...(lines.length ? [lines.join("\n")] : [])].join("\n\n"));
  }
  if (omitted) parts.push(`(${omitted} more memories didn't fit; find them with memory_search.)`);

  const carried: CarriedMemory[] = (["relevant", "global", "repo"] as const).flatMap((section) =>
    chosen[section].map(({ m, full }) => ({ id: m.id, name: m.name, description: m.description, scope: m.scope, section, full })),
  );
  const nativeCount = opts.entries.filter((m) => native.has(m.id)).length;
  let text = "";
  if (parts.length) {
    const intro = nativeCount
      ? `Shared memory from the user's other agents (Tether), in addition to the ${nativeCount} entries already in your system prompt:`
      : "Shared memory from the user's other agents (Tether):";
    text = `${intro}\n\n${parts.join("\n\n")}`;
  }
  return { text, carried, native: nativeCount, captured, captureNote: opts.captureNote };
}

/** The notice the new session shows: a heading plus a markdown list of what was carried. */
export function carriedNotice(mem: HandoffMemory, harness: string): string {
  const out: string[] = [];
  for (const section of ["relevant", "global", "repo"] as const) {
    const list = mem.carried.filter((c) => c.section === section);
    if (!list.length) continue;
    out.push(`**${SECTION_TITLES[section]}**\n${list.map((c) => `- \`${c.name}\`: ${c.description}${c.full ? "" : " (name only)"}`).join("\n")}`);
  }
  if (mem.captured.length) out.push(`**Noted from the previous session** (saved to memory)\n${mem.captured.map((f) => `- ${f.text.trim().replace(/\n+/g, " ")}`).join("\n")}`);
  if (mem.native) out.push(`${harness} also has ${mem.native} shared memories in its system prompt; they weren't repeated.`);
  if (mem.captureNote) out.push(`Capture: ${mem.captureNote}.`);
  return out.join("\n\n");
}

// ---------------- capture ----------------

/** Pulls 0-3 durable facts out of a transcript. The background model in production, a stub in tests. */
export type Extractor = (transcript: string, known: MemoryEntry[], timeoutMs: number) => Promise<CapturedFact[]>;

const EXTRACT_SYSTEM = `You maintain a developer's long-term memory for coding agents. Below is part of a coding session that is about to move to another agent.
Extract at most 3 durable facts worth remembering beyond this session:
- user: who the user is, their background or role
- feedback: how they want agents to work (preferences, corrections, things to always or never do)
- project: non-obvious facts or decisions about this repository (architecture, conventions, deploy steps)
Skip: the task's progress or status, anything obvious from the code, temporary state, secrets, and anything the known memories already say.
Most sessions have nothing durable: then answer {"facts":[]}.
Answer with JSON only: {"facts":[{"text":"<one fact, standalone, one or two sentences>","name":"<kebab-case slug>","type":"user"|"feedback"|"project","scope":"global"|"repo"}]}`;

export const modelExtractor: Extractor = async (transcript, known, timeoutMs) => {
  const prompt = `Known memories (don't repeat these):\n${known.map((m) => `- ${m.name}: ${m.description}`).join("\n") || "(none)"}\n\nSession:\n${transcript}`;
  const reply = await runBackground({ system: EXTRACT_SYSTEM, prompt, timeoutMs });
  return normalizeFacts(parseJsonReply(reply));
};

/** Validates an extractor reply: at most 3 non-empty facts with known types and scopes. */
export function normalizeFacts(r: any): CapturedFact[] {
  const list = Array.isArray(r?.facts) ? r.facts : [];
  const out: CapturedFact[] = [];
  for (const f of list) {
    const text = typeof f?.text === "string" ? f.text.trim().slice(0, 1000) : "";
    if (!text) continue;
    out.push({
      text,
      name: typeof f.name === "string" ? f.name : undefined,
      type: asType(f.type),
      scope: f.scope === "global" || f.scope === "repo" ? f.scope : undefined,
    });
    if (out.length === 3) break;
  }
  return out;
}

export interface CaptureOptions {
  sessionId: string;
  repoKey: string;
  messages: Msg[];
  extractor?: Extractor;
  /** how long the handoff waits; a later answer is still saved */
  timeoutMs?: number;
  /** don't capture the same session twice within this window */
  debounceMs?: number;
  /** less new transcript than this isn't worth a model call */
  minChars?: number;
  now?: number;
}

export interface CaptureResult {
  /** facts extracted in time (for the brief) */
  facts: CapturedFact[];
  /** why nothing was captured in time */
  skipped?: "debounced" | "nothing new" | "timeout" | "in progress" | "failed";
  /**
   * Files the in-time facts as inbox notes and advances the watermark. The caller runs it once
   * the new session has started, so its native injection can't already hold what the brief
   * lists. Idempotent; true when notes were written.
   */
  file: () => boolean;
  /** a capture that ran past the timeout files itself when done; this settles then */
  late: Promise<boolean>;
}

export const CAPTURE_TIMEOUT_MS = 8_000;
const CAPTURE_DEBOUNCE_MS = 2 * 60_000;
const CAPTURE_MIN_CHARS = 200;
const CAPTURE_MAX_CHARS = 24_000;

const inFlight = new Set<string>();

const markKey = (sessionId: string) => `handoff-capture:${sessionId}`;
const nothing = (skipped: CaptureResult["skipped"]): CaptureResult => ({ facts: [], skipped, file: () => false, late: Promise.resolve(false) });

/**
 * Captures what the outgoing session learned since its last capture: at most 3 facts from the
 * extractor, waited on for `timeoutMs`. Filed facts become inbox notes (via: handoff) for the
 * normal merge pass.
 */
export async function captureLearnings(store: Store, o: CaptureOptions): Promise<CaptureResult> {
  const now = o.now ?? Date.now();
  const key = markKey(o.sessionId);
  if (inFlight.has(key)) return nothing("in progress");
  const mark = store.watermarks()[key];
  if (mark?.mtime && now - mark.mtime < (o.debounceMs ?? CAPTURE_DEBOUNCE_MS)) return nothing("debounced");
  // Only what came after the last capture (the watermark is the last message id it saw).
  const since = mark?.hash ? o.messages.findIndex((m) => m.id === mark.hash) + 1 : 0;
  const fresh = o.messages.slice(since);
  const transcript = renderTranscript(fresh);
  if (!fresh.some((m) => m.role === "user") || transcript.length < (o.minChars ?? CAPTURE_MIN_CHARS)) return nothing("nothing new");
  const clipped = transcript.length > CAPTURE_MAX_CHARS ? transcript.slice(-CAPTURE_MAX_CHARS) : transcript;
  const known = store.list().filter((m) => m.scope === "global" || m.scope === `repo:${o.repoKey}`).slice(0, 60);
  const lastId = o.messages[o.messages.length - 1]?.id;
  const timeoutMs = o.timeoutMs ?? CAPTURE_TIMEOUT_MS;

  let facts: CapturedFact[] | undefined;
  let filed = false;
  let late = false;
  const file = () => {
    if (filed || !facts) return false;
    filed = true;
    fileFacts(store, facts, o.sessionId, o.repoKey);
    store.setWatermark(key, { hash: lastId, mtime: o.now ?? Date.now() });
    return facts.length > 0;
  };
  inFlight.add(key);
  const work = (async () => {
    try {
      facts = (await (o.extractor ?? modelExtractor)(clipped, known, Math.max(timeoutMs * 4, 30_000))).slice(0, 3);
    } catch (e: any) {
      console.error(`context: handoff capture for ${o.sessionId} failed: ${e?.message ?? e}`);
      throw e;
    } finally {
      inFlight.delete(key);
    }
    return late ? file() : false;
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)));
  try {
    if ((await Promise.race([work.then(() => "ok" as const), timeout])) === "timeout") {
      late = true;
      return { facts: [], skipped: "timeout", file: () => false, late: work.catch(() => false) };
    }
    return { facts: facts!, file, late: Promise.resolve(false) };
  } catch {
    return nothing("failed");
  } finally {
    clearTimeout(timer);
  }
}

/** One inbox note per fact, the same shape memory_write leaves (runner/src/context/mcp.ts). */
export function fileFacts(store: Store, facts: CapturedFact[], sessionId: string, repoKey: string) {
  for (const f of facts) {
    const note = {
      text: f.text,
      type: f.type,
      name: f.name,
      scope: f.scope === "global" ? "global" : f.scope === "repo" ? `repo:${repoKey}` : undefined,
      repo: repoKey,
      sessionId,
      via: "handoff",
      ts: Date.now(),
    };
    writeAtomic(join(store.dir, "inbox", `${Date.now()}-${sha(f.text + contentHash(sessionId))}.json`), JSON.stringify(note));
  }
}
