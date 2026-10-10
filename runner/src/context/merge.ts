// The merge pass: each new or changed source entry is compared with the memories it could overlap
// and becomes one of
//   new          a fact the store doesn't have yet
//   duplicate    already known: only the provenance is added
//   update       refines a known fact: the body is rewritten
//   contradicts  disagrees with a known fact: newest wins, both claims are kept in a conflict
// Entries with no plausible overlap skip the model (most of a first import). Each applied change
// is one commit plus one activity line.

import { rmSync } from "node:fs";
import type { ContextActivity, ContextEvent, MemoryConflict, MemoryEntry } from "../../../web/src/shared/protocol";
import { parseJsonReply, runBackground } from "./background";
import { asType, contentHash, similarity, slugify, words, type Memory, type MemoryType } from "./format";
import type { SourceEntry } from "./sources";
import type { Store } from "./store";

export type Decision =
  | { action: "new"; name?: string; description?: string; type?: MemoryType; scope?: string; body?: string }
  | { action: "duplicate"; id: string }
  | { action: "update"; id: string; body: string; description?: string }
  | { action: "contradicts"; id: string; body: string; description?: string; oldClaim?: string; newClaim?: string };

/** Decides what an entry is, given its candidates. The model in production, a stub in tests. */
export type Decider = (entry: SourceEntry, candidates: MemoryEntry[], scopes: string[]) => Promise<Decision>;

const MIN_SCORE = 0.2;
const MAX_CANDIDATES = 6;

/** Scopes an entry may land in: its own, or (when the source doesn't say) global or its repo. */
export function scopesFor(e: SourceEntry): string[] {
  if (e.scope) return [e.scope];
  return e.repoHint ? ["global", `repo:${e.repoHint}`] : ["global"];
}

/** Existing memories this entry might duplicate, refine or contradict, best first. */
export function candidates(store: Store, e: SourceEntry, all = store.list()): MemoryEntry[] {
  const scopes = scopesFor(e);
  const own = all.filter((m) => m.sources.includes(e.provenance));
  const w = words(`${e.title} ${e.memory?.description ?? ""} ${e.text}`);
  const scored = all
    .filter((m) => scopes.includes(m.scope) && !own.includes(m))
    .map((m) => ({ m, score: similarity(w, words(`${m.name} ${m.description} ${m.body}`)) }))
    .filter((x) => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.m);
  // What this same source produced before is always a candidate (an edited Claude memory file).
  return [...own, ...scored].slice(0, MAX_CANDIDATES);
}

const MERGE_SYSTEM = `You maintain a developer's long-term memory for coding agents: short facts about the user, their preferences and feedback, and their projects.
A new memory arrived. Compare it with the existing memories listed and answer with JSON only:
{"action":"new"|"duplicate"|"update"|"contradicts","id":"<existing id, unless new>","name":"<kebab-case slug, new only>","description":"<one line used for relevance>","type":"user"|"feedback"|"project"|"reference","scope":"global"|"repo","body":"<full rewritten body: update/contradicts; new: the text, kept close to verbatim>","oldClaim":"<one sentence, contradicts only>","newClaim":"<one sentence, contradicts only>"}

- duplicate: an existing memory already says the same thing (nothing new to add).
- update: it adds to or refines an existing memory without disagreeing; body merges both.
- contradicts: it disagrees with an existing memory. The new memory wins: body states the new version; keep still-valid details of the old one.
- new: none of them covers it.
type: user = who the user is; feedback = how they want agents to work; project = facts about a project; reference = pointers to docs/resources.
scope (only if the entry's scope is open): global for facts about the user or all projects, repo for facts about this repository.
Keep bodies concise markdown. Never invent facts.`;

export const modelDecider: Decider = async (entry, cands, scopes) => {
  const prompt = JSON.stringify(
    {
      newMemory: { source: entry.provenance, title: entry.title, text: entry.text.slice(0, 6000), scope: scopes.length > 1 ? "open (global or repo)" : scopes[0] },
      existing: cands.map((m) => ({ id: m.id, name: m.name, description: m.description, type: m.type, scope: m.scope, body: m.body.slice(0, 3000) })),
    },
    null,
    1,
  );
  const reply = parseJsonReply(await runBackground({ system: MERGE_SYSTEM, prompt, timeoutMs: 120_000 }));
  return normalizeDecision(reply, cands, scopes);
};

/** Validates a model reply; anything unusable becomes "new". */
export function normalizeDecision(r: any, cands: MemoryEntry[], scopes: string[]): Decision {
  const known = cands.some((c) => c.id === r?.id);
  const body = typeof r?.body === "string" && r.body.trim() ? r.body.trim() : undefined;
  const description = typeof r?.description === "string" ? r.description.trim().slice(0, 300) : undefined;
  const scope = r?.scope === "repo" ? scopes.find((s) => s.startsWith("repo:")) : r?.scope === "global" && scopes.includes("global") ? "global" : undefined;
  switch (r?.action) {
    case "duplicate":
      if (known) return { action: "duplicate", id: r.id };
      break;
    case "update":
      if (known && body) return { action: "update", id: r.id, body, description };
      break;
    case "contradicts":
      if (known && body)
        return {
          action: "contradicts",
          id: r.id,
          body,
          description,
          oldClaim: typeof r.oldClaim === "string" ? r.oldClaim.slice(0, 400) : undefined,
          newClaim: typeof r.newClaim === "string" ? r.newClaim.slice(0, 400) : undefined,
        };
      break;
  }
  return { action: "new", name: typeof r?.name === "string" ? r.name : undefined, description, type: asType(r?.type), scope, body };
}

export interface MergeOutcome {
  entry: SourceEntry;
  decision: Decision["action"] | "error";
  memoryId?: string;
  commit?: string;
  conflict?: MemoryConflict;
  error?: string;
}

const now = () => new Date().toISOString();

export class Merger {
  constructor(
    private store: Store,
    private decide: Decider = modelDecider,
    private emit: (e: ContextEvent) => void = () => {},
  ) {}

  private act(a: Omit<ContextActivity, "id" | "ts">) {
    const full = this.store.activity(a);
    this.emit({ type: "activity", activity: full });
    return full;
  }

  /** Set when the model failed during this pass: the rest of the pass doesn't retry it. */
  private modelDown?: string;

  async mergeAll(entries: SourceEntry[], onProgress?: (done: number, total: number) => void): Promise<MergeOutcome[]> {
    const out: MergeOutcome[] = [];
    this.modelDown = undefined;
    onProgress?.(0, entries.length);
    for (const e of entries) {
      out.push(await this.mergeOne(e));
      onProgress?.(out.length, entries.length);
    }
    return out;
  }

  async mergeOne(e: SourceEntry): Promise<MergeOutcome> {
    try {
      const outcome = await this.apply(e);
      this.store.setWatermark(e.key, e.consume ? undefined : { hash: e.hash });
      if (e.consume) rmSync(e.consume, { force: true });
      return outcome;
    } catch (err: any) {
      const error = err?.message ?? String(err);
      this.act({ kind: "error", text: `Couldn't merge ${e.title}: ${error}`, source: e.provenance, sessionId: e.sessionId });
      return { entry: e, decision: "error", error };
    }
  }

  private async decideFor(e: SourceEntry): Promise<Decision> {
    const scopes = scopesFor(e);
    const all = this.store.list();
    // Same text already stored in scope: a duplicate, no model needed.
    const body = e.memory?.body ?? e.text;
    const same = all.find((m) => scopes.includes(m.scope) && contentHash(m.body) === contentHash(body));
    if (same) return { action: "duplicate", id: same.id };
    const cands = candidates(this.store, e, all);
    if (!cands.length) return { action: "new" };
    // The source edited what it gave us before, and nothing else overlaps: just update it.
    // Only for sources that can be edited (a file, a section): a one-shot write (MCP) is a new fact.
    const own = !e.oneShot && cands[0]!.sources.includes(e.provenance) ? cands[0] : undefined;
    if (own && cands.length === 1) return { action: "update", id: own.id, body, description: e.memory?.description };
    // No verdict (model down, out of quota): keep the entry rather than lose it.
    const fallback: Decision = own ? { action: "update", id: own.id, body, description: e.memory?.description } : { action: "new" };
    if (this.modelDown) return fallback;
    try {
      return await this.decide(e, cands, scopes);
    } catch (err: any) {
      this.modelDown = err?.message ?? String(err);
      this.act({ kind: "error", text: `Background model unavailable (${this.modelDown}); this pass keeps new entries without comparing them.`, source: e.provenance });
      return fallback;
    }
  }

  private async apply(e: SourceEntry): Promise<MergeOutcome> {
    const d = await this.decideFor(e);
    const src = e.provenance;
    if (d.action === "new") {
      const scopes = scopesFor(e);
      // Global instruction files are mostly how the user wants agents to work.
      const type = e.memory?.type ?? d.type ?? (e.scope === "global" ? "feedback" : "project");
      const scope = d.scope ?? (scopes.length > 1 ? (type === "user" || type === "feedback" ? "global" : scopes[1]!) : scopes[0]!);
      const name = slugify(e.memory?.name) ?? slugify(d.name) ?? slugify(e.title) ?? "memory";
      const id = this.store.newId(scope, name);
      const memory: Memory = {
        name: id.split("/").pop()!,
        description: (e.memory?.description || d.description || e.title).slice(0, 300),
        type,
        scope,
        sources: [src],
        updated: now(),
        body: (e.memory?.body ?? d.body ?? e.text).trim(),
      };
      const commit = await this.store.put(id, memory, `memory: add ${id}\n\nfrom ${src}`);
      this.act({ kind: "new", text: `Added "${memory.description}"`, memoryId: id, source: src, commit, sessionId: e.sessionId });
      return { entry: e, decision: "new", memoryId: id, commit };
    }
    const cur = this.store.get(d.id);
    if (!cur) throw new Error(`memory ${d.id} disappeared`);
    const sources = cur.sources.includes(src) ? cur.sources : [...cur.sources, src];
    const base: Memory = { name: cur.name, description: cur.description, type: cur.type, scope: cur.scope, sources, updated: cur.updated, body: cur.body };
    if (d.action === "duplicate") {
      const commit = sources === cur.sources ? undefined : await this.store.put(d.id, base, `memory: ${d.id} also in ${src}`);
      this.act({ kind: "duplicate", text: `Already known: "${cur.description}"`, memoryId: d.id, source: src, commit, sessionId: e.sessionId });
      return { entry: e, decision: "duplicate", memoryId: d.id, commit };
    }
    const next: Memory = { ...base, body: d.body, description: d.description || cur.description, updated: now() };
    if (d.action === "update") {
      const commit = await this.store.put(d.id, next, `memory: update ${d.id}\n\nfrom ${src}`);
      this.act({ kind: "update", text: `Updated "${next.description}"`, memoryId: d.id, source: src, commit, sessionId: e.sessionId });
      return { entry: e, decision: "update", memoryId: d.id, commit };
    }
    const commit = await this.store.put(d.id, next, `memory: ${d.id} contradicted, newest wins\n\nfrom ${src}\nold: ${d.oldClaim ?? ""}\nnew: ${d.newClaim ?? ""}`);
    const conflict: MemoryConflict = {
      id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      memoryId: d.id,
      name: cur.name,
      scope: cur.scope,
      oldBody: cur.body,
      newBody: d.body,
      oldClaim: d.oldClaim,
      newClaim: d.newClaim,
      source: src,
      sessionId: e.sessionId,
      commit,
      ts: Date.now(),
      status: "open",
    };
    this.store.saveConflicts([...this.store.conflicts(), conflict]);
    this.act({ kind: "contradicts", text: `"${cur.description}" was contradicted; kept the newer version`, memoryId: d.id, source: src, commit, sessionId: e.sessionId });
    this.emit({ type: "conflict", conflict });
    return { entry: e, decision: "contradicts", memoryId: d.id, commit, conflict };
  }
}
