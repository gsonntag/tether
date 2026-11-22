// Sessions an agent starts (SPEC §9a, tether_start): any session's agent starts a new session on any
// harness, model and effort, in its own folder (or another, a new worktree, or an existing one), with a prompt. The
// child is an ordinary session; the module remembers who started it and, each time it finishes a
// turn, queues its last reply into the starter's chat. The starter follows up with tether_send, or
// starts a fresh one. The child's mode is never looser than the starter's. Reporting stops once the
// person steps in (types into the child or stops it), after MAX_REPORTS, or once the starter is gone.
// Once the starter is done with a child it archives it (tether_archive), so the person's sidebar
// keeps the sessions they started, and agent-started ones only while those work; an archived (or
// gone) starter's idle children are archived too.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { markTitle, parseSessionMessage, sessionMessage, TEXTED_VIA } from "../../../../shared/fromTether";
import { LEVELS, mapMode, type Level } from "../../../../shared/move";
import { waitingNow } from "../../../../shared/schedule";
import { HARNESS_LABELS, type HarnessId, type Msg, type SessionSummary } from "../../../../shared/transcript";
import { hasSourceModels, isSubscriptionSource, resolveSourceModel, type SourceOption } from "../../../../shared/credentials";
import type { SpawnedFamily } from "../../../../shared/protocol";
import { pickWorktree, type WorktreeJoined, type WorktreeMade } from "../../../../shared/worktree";
import { LEVEL_WORDS, levelOf } from "../../core/permissionLevel";
import type { ModuleContext, SessionLook } from "..";
import { lastReply } from "../sideChats";
import { busyWhy } from "../worktrees";
import { worktreeKeeps } from "../worktrees/git";
import type { PeerAnswer } from "./server";

/** The newest children spawnedFamily lists (each older one not in memory is opened to read its summary). */
export const FAMILY_MAX = 100;
/** How many of them it opens at once. */
export const FAMILY_OPENS = 8;

/** `f` over `items`, at most `n` at once, results in order. */
async function pooled<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const work = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, work));
  return out;
}
/** Turns a child reports before the starter stops hearing from it: a loop can't run forever. */
export const MAX_REPORTS = 20;
/** Children a session follows at once. */
export const CHILDREN_MAX = 5;
/** How deep starting goes: a session an agent started may start one more level, no deeper. */
export const DEPTH_MAX = 2;
/** How much of a child's reply a report carries. */
export const REPORT_MAX = 20_000;
/** How long a request stays open before the starter hears of it (a policy may decide it at once). */
export const WAIT_DELAY_MS = 800;

const HARNESSES: HarnessId[] = ["claude", "codex", "antigravity"];

/** Whether a session is at work for the fan-out cap: a turn, work outside it, background work, an open request, a message due in its queue. */
const working = (look: SessionLook) => look.status !== "idle" || look.busy || look.background || look.requests.length > 0 || waitingNow(look.state.queue ?? [], Date.now());
/** Whether the person drives it in its terminal. */
const terminal = (look: SessionLook) => !!look.state.terminal || look.summary.mode === "terminal" || look.state.mode === "terminal";

export interface Child {
  parent: string;
  /** 1: started by a session the person started; 2: by one of those */
  depth: number;
  reports: number;
  /** the hops its prompt carried: its reports carry them back, so a report never resets the starter's chain */
  hops?: number;
  /** its current turn came from another session, not the starter: that turn isn't reported (no stricter-to-looser relay) */
  foreign?: boolean;
  /** it already said it's waiting for the person this turn */
  waited?: boolean;
  /** why it stopped reporting: the person took it over, MAX_REPORTS, its starter archived, its starter archived it (tether_archive), archived as its starter was */
  released?: "person" | "limit" | "gone" | "done" | "cascade";
  /** archived because its starter was: it comes back when its starter does */
  cascade?: true;
  /** what `released` was before the cascade, restored when it comes back */
  beforeCascade?: "person" | "limit" | "gone" | "done";
}

export interface StartArgs {
  harness?: string;
  prompt?: string;
  source?: string;
  model?: string;
  effort?: string;
  title?: string;
  project?: string;
  /** true: a new worktree; a string: an existing one's path or branch */
  worktree?: boolean | string;
}

type Ctx = Pick<ModuleContext, "sessions" | "session" | "log" | "hiddenFolder"> & {
  ops?: Pick<ModuleContext["ops"], "call">;
  dataDir?: string;
  /** what archiving `id`'s worktree cleanup decides (the worktrees module's worktreeCleaned event), "slow" past a wait; asked before the archive */
  worktreeCleaned?: (id: string) => Promise<{ removed?: boolean; why?: string } | "slow">;
  /** instead of worktreeKeeps on its record (tests) */
  worktreeKeeps?: (id: string) => Promise<string | undefined>;
};

export class Children {
  private kids: Record<string, Child> = {};
  /** starts under way, per starter: counted against CHILDREN_MAX before anything waits */
  private pending = new Map<string, number>();
  /** sessions this archives itself (their `archived` event isn't a cascade's start: archiveTree goes on itself) */
  private archiving = new Set<string>();
  private file?: string;

  constructor(private ctx: Ctx) {
    if (ctx.dataDir) {
      this.file = join(ctx.dataDir, "children.json");
      try {
        if (existsSync(this.file)) {
          const v = JSON.parse(readFileSync(this.file, "utf8"));
          if (v && typeof v === "object" && !Array.isArray(v)) this.kids = v;
          else ctx.log(`peers: ${this.file} isn't an object; starting with no children`);
        }
      } catch (e) {
        ctx.log(`peers: couldn't read ${this.file}: ${(e as Error).message}`);
      }
    }
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.kids));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      this.ctx.log(`peers: couldn't save ${this.file}: ${(e as Error).message}`);
    }
  }

  /** The child a session is, if an agent started it. */
  of(id: string): Child | undefined {
    return this.kids[id];
  }

  /**
   * Who started a session and whom it started (the spawnedFamily op: the web shows them as its
   * children, SPEC §6a). Released children too: who started whom doesn't change when the person
   * takes one over. Archived ones, and ones in a folder the lists hide, are left out; one that went
   * on under another id is its successor.
   */
  async family(id: string): Promise<SpawnedFamily> {
    const listed = new Map(this.ctx.sessions.list().map((s) => [s.id, s]));
    const find = async (sid: string): Promise<SessionSummary | undefined> => {
      for (let hop = 0; hop < 5; hop++) {
        const shown = listed.get(sid);
        if (shown) return shown.archived ? undefined : shown;
        // What's kept says archived or gone on without opening it.
        const kept = this.ctx.sessions.kept?.(sid);
        if (kept?.archived) return undefined;
        if (kept?.movedTo) {
          sid = kept.movedTo;
          continue;
        }
        const look = this.ctx.session(sid) ?? (await this.ctx.sessions.open(sid).catch(() => undefined));
        if (!look) return undefined;
        if (look.state.continuedIn) {
          sid = look.state.continuedIn;
          continue;
        }
        const s = look.summary;
        return s.archived || this.ctx.hiddenFolder?.(s.projectPath) ? undefined : s;
      }
      return undefined;
    };
    const mine = this.kids[id];
    const up = mine && (await find(mine.parent));
    const ids = Object.entries(this.kids)
      .filter(([, c]) => c.parent === id)
      .map(([k]) => k)
      .slice(-FAMILY_MAX);
    const found = await pooled(ids, FAMILY_OPENS, find);
    const seen = new Set<string>();
    const children = found.filter((s): s is SessionSummary => !!s && !seen.has(s.id) && !!seen.add(s.id));
    return { ...(up ? { parent: { id: up.id, title: up.title } } : {}), children: children.sort((a, b) => b.updatedAt - a.updatedAt) };
  }

  /** The session a start from `from` belongs to: a side chat's starts are its session's (SPEC §16a). */
  ownerOf(from: string): string {
    return this.ctx.session(from)?.summary.sideOf ?? from;
  }

  /**
   * A session went on under a new id (a Move, a source change): it's the child, and the parent of
   * its children, from now on, so reports, the family and "Started by" follow it.
   */
  continued(from: string, to: string) {
    if (!from || !to || from === to) return;
    let changed = false;
    if (this.kids[from]) {
      this.kids[to] = this.kids[from]!;
      delete this.kids[from];
      changed = true;
    }
    for (const c of Object.values(this.kids))
      if (c.parent === from) {
        c.parent = to;
        changed = true;
      }
    const n = this.pending.get(from);
    if (n) {
      this.pending.delete(from);
      this.pending.set(to, (this.pending.get(to) ?? 0) + n);
    }
    if (changed) this.save();
  }

  /** The sessions `parent` started that still report to it and are still at work (a finished, idle one doesn't count). */
  following(parent: string): string[] {
    return Object.entries(this.kids).flatMap(([id, c]) => {
      if (c.parent !== parent || c.released) return [];
      const look = this.ctx.session(id);
      if (look?.summary.archived) return [];
      return look && working(look) ? [id] : [];
    });
  }

  private async look(id: string): Promise<SessionLook | undefined> {
    return this.ctx.session(id) ?? (await this.ctx.sessions.open(id).catch(() => undefined));
  }

  private level(s: SessionLook | undefined): Level | undefined {
    if (!s) return undefined;
    return levelOf(this.ctx.sessions.adapters().find((a) => a.id === s.summary.harness), s.state.permissionMode);
  }

  /** The child's mode: the target harness's loosest offered mode at or under the starter's level. */
  private async modeFor(harness: HarnessId, level: Level): Promise<string> {
    const a = this.ctx.sessions.adapters().find((x) => x.id === harness)!;
    const modes = a.move?.modes ?? [];
    if (!modes.length) throw new Error(`Tether can't tell ${HARNESS_LABELS[harness]}'s permission modes, so it can't start one no looser than this session.`);
    // What it offers now, each at its level (Claude's auto too, which moves never pick); else its known modes.
    const offered = (await a.listModels?.().catch(() => undefined))?.permissionModes?.map((m) => m.id) ?? [];
    const usable = offered.flatMap((mode) => {
      const l = levelOf(a, mode);
      return l === undefined ? [] : [{ mode, level: l }];
    });
    return mapMode(level, usable.length ? usable : modes);
  }

  /**
   * Starts a child for `from`. `hops`/`count`: the peer caps' chain count and rate slot (given back
   * when nothing started).
   */
  async start(from: string, a: StartArgs, hops: number, undo: () => void): Promise<PeerAnswer> {
    const owner = this.ownerOf(from);
    try {
      return await this.make(from, a, hops);
    } catch (e) {
      undo();
      return { text: `Nothing was started: ${(e as Error).message}`, isError: true };
    } finally {
      const n = (this.pending.get(owner) ?? 1) - 1;
      if (n > 0) this.pending.set(owner, n);
      else this.pending.delete(owner);
    }
  }

  /**
   * tether_models: what tether_start can pass as source and model for a harness. Each source with
   * its billing; Azure's models are its deployments (Settings, Azure), the others the harness's list.
   */
  async models(harnessArg: string): Promise<PeerAnswer> {
    const s = this.ctx.sessions;
    const harness = harnessArg.trim() as HarnessId;
    if (!HARNESSES.includes(harness)) return { text: `harness must be one of ${HARNESSES.join(", ")}.`, isError: true };
    const adapter = s.adapters().find((x) => x.id === harness);
    if (!adapter) return { text: `${HARNESS_LABELS[harness]} isn't available on this runner.`, isError: true };
    const { options } = harness === "antigravity"
      ? { options: [{ source: "subscription" as const, deployments: undefined }] }
      : await s.sources(harness).catch(() => ({ options: [] as SourceOption[] }));
    const list = await adapter.listModels?.().catch(() => undefined);
    const models = (list?.models ?? []).filter((m) => m.id !== "default").map((m) =>
      `  - ${m.id}${m.label && m.label !== m.id ? ` (${m.label})` : ""}${m.efforts?.length ? `; effort: ${m.efforts.join(", ")}` : ""}`);
    const lines = [`${HARNESS_LABELS[harness]} on this runner. Pass source and model to tether_start. Tether sets up each source's provider and key itself (Settings): no config or environment change is needed.`];
    if (!options.length) lines.push("", "No billing source is available.");
    for (const { source, deployments } of options) {
      lines.push("", `${source}${isSubscriptionSource(source) ? "" : " (API key: confirm with the person first)"}:`);
      if (source === "bedrock") {
        for (const d of deployments ?? []) lines.push(`  - ${d.name}${d.model ? ` (alias: ${d.model})` : ""}`);
      } else if (source === "azure") {
        if (!deployments?.length) lines.push("  No deployments: add one in Tether's Settings, Azure.");
        else for (const d of deployments) lines.push(`  - ${d.name}${d.model ? ` (runs ${d.model})` : ""}`);
        lines.push("  model: a deployment name, or the model one of them runs.");
      } else lines.push(...(models.length ? models : ["  The agent's default model (Tether couldn't read its list)."]));
    }
    return { text: lines.join("\n") };
  }

  /**
   * Why `from` can't start a child now, if it can't. Otherwise a slot is reserved at once (so starts
   * side by side can't all pass); start() gives it back.
   */
  refusal(caller: string): string | undefined {
    const from = this.ownerOf(caller);
    const depth = (this.kids[from]?.depth ?? 0) + 1;
    if (depth > DEPTH_MAX) return `This session was itself started by another session's agent, ${DEPTH_MAX - 1} level${DEPTH_MAX === 2 ? "" : "s"} down; sessions that deep can't start more. Do it here, or tell whoever started you.`;
    const n = this.following(from).length + (this.pending.get(from) ?? 0);
    if (n >= CHILDREN_MAX) return `${n} sessions you started are still working (at most ${CHILDREN_MAX} at once). Wait for one to finish its turn.`;
    this.pending.set(from, (this.pending.get(from) ?? 0) + 1);
    return undefined;
  }

  private async make(from: string, a: StartArgs, hops: number): Promise<PeerAnswer> {
    const s = this.ctx.sessions;
    const prompt = (a.prompt ?? "").trim();
    if (!prompt) throw new Error("the prompt is empty.");
    const harness = (a.harness ?? "").trim() as HarnessId;
    if (!HARNESSES.includes(harness)) throw new Error(`harness must be one of ${HARNESSES.join(", ")}.`);
    if (!s.adapters().some((x) => x.id === harness)) throw new Error(`${HARNESS_LABELS[harness]} isn't available on this runner.`);
    const me = await this.look(from);
    if (!me) throw new Error("Tether can't find this session.");
    // The caller's own level (a side chat's is read only), but its session is the starter.
    const level = this.level(me) ?? LEVELS.readOnly;
    const starter = me.summary.sideOf ?? from;
    const own = me.summary.projectPath;
    const folder = a.project?.trim() ? s.folder(a.project.trim()) : own;
    // A hidden folder's sessions are out of the lists (TETHER_HIDE_PROJECTS, the removed Home agent's old one).
    if (this.ctx.hiddenFolder?.(folder)) throw new Error(`${folder} is a folder Tether hides, not a project.`);
    // Another folder widens where a sandboxed starter could write: only from one nothing confines, and only a known project.
    const elsewhere = async (where: string, known: boolean) => {
      if (resolve(where) === resolve(own)) return;
      if (level < LEVELS.judged) throw new Error(`this session (${LEVEL_WORDS[level]}) can only start sessions in its own folder.`);
      if (!known && !(await s.projects().catch(() => [])).some((p) => resolve(p.path) === resolve(where))) throw new Error(`${where} isn't one of Tether's projects.`);
    };
    await elsewhere(folder, false);
    // A new worktree runs git and the repo's setup without asking: only for a starter that may run commands itself.
    if (a.worktree === true && level < LEVELS.sandboxed) throw new Error(`this session (${LEVEL_WORDS[level]}) can't make worktrees: that runs commands.`);
    // An existing worktree runs nothing: it's just another folder, one of the (allowed) folder's repo's worktrees.
    let existing: string | undefined;
    if (typeof a.worktree === "string") {
      if (!this.ctx.ops) throw new Error("worktrees aren't available on this runner.");
      const { repo, worktrees } = await this.ctx.ops.call("listWorktrees", { projectPath: folder });
      if (!repo) throw new Error(`${folder} isn't in a git repository, so it has no worktrees.`);
      const w = pickWorktree(worktrees, a.worktree, (p) => (p.startsWith("/") || p.startsWith("~") ? resolve(s.folder(p)) : p));
      if (!w) throw new Error(`${a.worktree} isn't one of ${repo}'s worktrees (other than its main checkout: for that, leave worktree out and pass project).`);
      await elsewhere(w.path, true);
      existing = w.path;
    }
    const mode = await this.modeFor(harness, level);
    const { options } = harness === "antigravity"
      ? { options: [{ source: "subscription" as const, deployments: undefined }] }
      : await s.sources(harness);
    const choice = options.find(({ source }) => source === (a.source ?? "subscription"));
    if (!choice) {
      const available = options.map(({ source, deployments }) =>
        deployments?.length ? `${source} (${deployments.map(({ name }) => name).join(", ")})` : source
      ).join(", ");
      throw new Error(`Confirm what to bill to with the user before starting a session, then pass its source. Available for ${HARNESS_LABELS[harness]}: ${available || "none"}.`);
    }
    const { source } = choice;
    let model = a.model?.trim() || undefined;
    if (hasSourceModels(source)) {
      const deployments = choice.deployments ?? [];
      const deployment = resolveSourceModel(deployments, model);
      if (!deployment) throw new Error(`Choose a configured ${source === "azure" ? "Azure deployment" : "Bedrock model"} for ${model}: ${deployments.map(({ name }) => name).join(", ")}.`);
      model = deployment;
    }
    const effort = a.effort?.trim() || undefined;
    const title = a.title?.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 80) || undefined;
    let made: WorktreeMade | undefined;
    let joined: WorktreeJoined | undefined;
    if (existing) joined = await this.ctx.ops!.call("existingWorktreeSession", { harness, projectPath: folder, worktree: existing, source, permissionMode: mode, ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    if (a.worktree === true) {
      if (!this.ctx.ops) throw new Error("worktrees aren't available on this runner.");
      made = await this.ctx.ops.call("newWorktreeSession", { harness, projectPath: folder, source, permissionMode: mode, ...(model ? { model } : {}), ...(effort ? { effort } : {}), name: title || prompt });
    }
    const id = made?.sessionId ?? joined?.sessionId ?? (await s.create({ harness, projectPath: folder, source, permissionMode: mode, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }));
    this.kids[id] = { parent: starter, depth: (this.kids[starter]?.depth ?? 0) + 1, reports: 0, hops };
    this.save();
    if (title) await s.rename(id, title).catch(() => {});
    const sender = { id: starter, title: (starter === from ? me : this.ctx.session(starter))?.summary.title || "Untitled" };
    const hint = `a session's agent started you, not the person. Your final reply each turn goes back to it automatically; it may follow up. The starter's permissions: ${LEVEL_WORDS[level]}.`;
    try {
      await s.send(id, sessionMessage(sender, prompt, hint, false, hops));
    } catch (e) {
      // Made, but the prompt didn't go: it isn't this agent's to follow.
      delete this.kids[id];
      this.save();
      return { text: `Made session ${id}, but couldn't send it the prompt: ${(e as Error).message}. It's idle in Tether with nothing to do.`, isError: true };
    }
    const name = `"${markTitle(title ?? "")}" (${id})`;
    const how = `${HARNESS_LABELS[harness]}${model ? `, ${model}` : ""}${effort ? `, ${effort} effort` : ""}, ${mode} mode, billed to ${source}`;
    const where = made
      ? `in a new worktree ${made.path} on branch ${made.branch} (from ${made.base}).${made.setup ? ` The repo's setup (${made.setup}) runs first; the prompt goes once it succeeds.` : ""}`
      : joined
        ? `in the existing worktree ${joined.path}${joined.branch ? ` on branch ${joined.branch}` : ""}.`
        : `in ${folder}.`;
    return { text: `Started ${name} (${how}) ${where}\nIt works on its own. Each time it finishes a turn, its reply comes to you as a message from it. Follow up with tether_send to ${id}, or start a fresh session for new context. When you're done with it, archive it with tether_archive to ${id}: until then it's in the person's sidebar.` };
  }

  // ---------------- archiving ----------------

  /**
   * tether_archive: `caller`'s session archives one it started (followed to its new id if it went
   * on under one), and that one's idle children (as a cascade). Not while it works, nor once the
   * person took it over or pinned it. What the worktree cleanup decided comes back in the answer.
   */
  async archive(caller: string, to: string): Promise<PeerAnswer> {
    const starter = this.ownerOf(caller);
    const t = to.trim();
    if (!t) return { text: "Say which session: `to` is its id or title.", isError: true };
    let id: string;
    try {
      id = await this.resolve(starter, t);
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
    const c = this.kids[id];
    const look = await this.look(id);
    const who = `"${markTitle(look?.summary.title ?? "")}" (${id})`;
    if (!c || c.parent !== starter) return { text: `This session didn't start ${who}, so it can't archive it. tether_archive only archives sessions you started with tether_start.`, isError: true };
    if (look && terminal(look)) this.takeOver(id);
    if (c.released === "person") return { text: `The person took ${who} over, so it's theirs now: it stays as it is.`, isError: true };
    if (!look) return { text: `Tether can't find ${who} now. Nothing was archived.`, isError: true };
    if (look.summary.pinned) return { text: `The person pinned ${who}, so it's theirs: it stays as it is.`, isError: true };
    if (look.summary.archived) {
      c.released ??= "done";
      this.save();
      return { text: `${who} is already archived.` };
    }
    const why = busyWhy(look);
    if (why) return { text: `${who} is still working (${why}), so it wasn't archived. Wait for its report, or tether_send it to stop, then archive it.`, isError: true };
    // Waiting for the cleanup's word from before the archive, so it can't be missed.
    const cleaned = this.ctx.sessions.worktree?.(id) && this.ctx.worktreeCleaned ? this.ctx.worktreeCleaned(id) : undefined;
    try {
      const n = await this.archiveTree(id, false);
      const more = n - 1;
      const r = cleaned && (await cleaned);
      const wt = !r ? "" : r === "slow" ? " Its worktree's cleanup is still checking; the session's notice will say what it decided." : r.removed ? " Its worktree was removed: everything was merged." : r.why ? ` Tether kept its worktree: ${r.why}.` : "";
      return { text: `Archived ${who}${more ? ` and ${more} idle session${more === 1 ? "" : "s"} it started` : ""}. It's out of the person's sidebar (they can still find it in Tether's archive), and it won't report to you again.${wt}` };
    } catch (e) {
      return { text: `Couldn't archive ${who}: ${(e as Error).message}`, isError: true };
    }
  }

  /** The child `to` names for `starter`: an id (followed to the session it went on as), else the title (any case) only one of its children has. */
  private async resolve(starter: string, t: string): Promise<string> {
    if (this.kids[t]) return t;
    if (t.includes(":")) {
      let sid = t;
      for (let hop = 0; hop < 5 && !this.kids[sid]; hop++) {
        const next = this.ctx.sessions.kept?.(sid)?.movedTo ?? (await this.look(sid))?.state.continuedIn;
        if (!next) break;
        sid = next;
      }
      if (this.kids[sid] || (await this.look(sid))) return sid;
    }
    const mine = Object.entries(this.kids).filter(([, c]) => c.parent === starter).map(([k]) => k);
    const titled = await pooled(mine, FAMILY_OPENS, async (k) => ({ id: k, title: (this.ctx.sessions.list().find((s) => s.id === k) ?? (await this.look(k))?.summary)?.title ?? "" }));
    const lower = t.toLowerCase();
    const found = titled.filter((x) => x.title.toLowerCase() === lower);
    if (found.length === 1) return found[0]!.id;
    if (found.length > 1) throw new Error(`${found.length} sessions you started are titled "${markTitle(t)}": ${found.slice(0, 8).map((x) => x.id).join(", ")}. Use its id.`);
    throw new Error(`There's no session titled "${markTitle(t)}" that you started (its exact title, or its id). tether_archive only archives sessions you started with tether_start.`);
  }

  /**
   * Archives `id` (it stops reporting) and, as a cascade, its children that may go. `cascade`: it
   * goes because its starter went, so its starter coming back brings it back (undoCascade).
   * How many it archived.
   */
  private async archiveTree(id: string, cascade: boolean): Promise<number> {
    const c = this.kids[id];
    const was = c?.released;
    if (c) {
      if (cascade) {
        c.cascade = true;
        if (was && was !== "cascade") c.beforeCascade = was;
        else delete c.beforeCascade;
      }
      c.released = cascade ? "cascade" : (was ?? "done");
      this.save();
    }
    this.archiving.add(id);
    try {
      await this.ctx.sessions.setArchived(id, true);
    } catch (e) {
      // It may have been archived all the same (a failure after the mark was saved).
      const now = this.ctx.sessions.kept?.(id)?.archived ?? (await this.look(id))?.summary.archived;
      if (!now) {
        if (c) {
          c.released = was;
          delete c.cascade;
          delete c.beforeCascade;
          this.save();
        }
        throw e;
      }
    } finally {
      this.archiving.delete(id);
    }
    return 1 + (await this.archiveChildren(id));
  }

  /**
   * Why a child of an archived (or done with) starter may not be archived on its own, if it may not:
   * the person took it over or pinned it, it works, or its worktree holds work (unsure: it stays).
   */
  private async mayNotGo(id: string, look: SessionLook | undefined): Promise<string | undefined> {
    const c = this.kids[id];
    if (!c || c.released === "person") return "the person's";
    if (!look) return "not found";
    if (terminal(look)) {
      this.takeOver(id);
      return "the person's";
    }
    if (look.summary.archived) return "archived";
    if (look.summary.pinned) return "pinned";
    const busy = busyWhy(look);
    if (busy) return busy;
    return this.worktreeHolds(id, look);
  }

  /** What its own worktree holds that archiving would leave behind (uncommitted or unmerged work), if anything; unsure counts. */
  private async worktreeHolds(id: string, look: SessionLook): Promise<string | undefined> {
    try {
      if (this.ctx.worktreeKeeps) return await this.ctx.worktreeKeeps(id);
      const rec = this.ctx.sessions.worktree?.(id);
      if (!rec || rec.handMade || !rec.branch || resolve(look.summary.projectPath) !== resolve(rec.path)) return undefined;
      return await worktreeKeeps(rec);
    } catch (e) {
      return `Tether couldn't check its worktree: ${(e as Error).message}`;
    }
  }

  /** Archives the children of `parent` that may go (mayNotGo), and theirs, as a cascade; one still working goes when its next report finds its starter archived. */
  private async archiveChildren(parent: string): Promise<number> {
    let n = 0;
    for (const [id, c] of Object.entries(this.kids)) {
      if (c.parent !== parent || c.released === "person") continue;
      const look = await this.look(id);
      const no = await this.mayNotGo(id, look);
      if (no) {
        if (no !== "archived" && no !== "the person's") this.ctx.log(`peers: ${id} stays (its starter ${parent} is archived): ${no}`);
        continue;
      }
      n += await this.archiveTree(id, true).catch((e) => {
        this.ctx.log(`peers: couldn't archive ${id}: ${(e as Error).message}`);
        return 0;
      });
    }
    return n;
  }

  /** `parent` is back: the children its archive took along come back too (and theirs), as they were. */
  private async undoCascade(parent: string) {
    for (const [id, c] of Object.entries(this.kids)) {
      if (c.parent !== parent || !c.cascade) continue;
      c.released = c.beforeCascade;
      delete c.cascade;
      delete c.beforeCascade;
      this.save();
      this.archiving.add(id);
      try {
        await this.ctx.sessions.setArchived(id, false);
      } catch (e) {
        this.ctx.log(`peers: couldn't unarchive ${id}: ${(e as Error).message}`);
      } finally {
        this.archiving.delete(id);
      }
      await this.undoCascade(id);
    }
  }

  /**
   * A session was archived or unarchived (the core's `archived` event). Archived by someone else
   * (the person): its children that may go, go too. Unarchived: a child is the person's from then
   * on (they unarchived it or sent it a message), and what its archive took along comes back.
   */
  async archived(id: string, archived: boolean) {
    if (this.archiving.has(id)) return;
    if (archived) {
      await this.archiveChildren(id);
      return;
    }
    if (this.kids[id]) this.takeOver(id);
    await this.undoCascade(id);
  }

  /**
   * The catch-up (at start and hourly): children whose starter is archived (a restart, or one
   * that was working then) and that may go now are archived, as a cascade.
   */
  async sweep() {
    const archived = async (id: string) => this.ctx.sessions.kept?.(id)?.archived ?? (await this.look(id))?.summary.archived;
    for (const [id, c] of Object.entries(this.kids)) {
      if (c.released === "person" || this.ctx.sessions.kept?.(id)?.archived) continue;
      if (!(await archived(c.parent))) continue;
      const look = await this.look(id);
      if (await this.mayNotGo(id, look)) continue;
      await this.archiveTree(id, true).catch((e) => this.ctx.log(`peers: couldn't archive ${id}: ${(e as Error).message}`));
    }
  }

  /** The person drives a child now (typed, stopped it, unarchived it, took it to its terminal): it stops reporting and its starter can't archive it. */
  takeOver(id: string) {
    const c = this.kids[id];
    if (!c || c.released === "person") return;
    c.released = "person";
    delete c.cascade;
    delete c.beforeCascade;
    this.save();
  }

  /** A session's mode changed: one taken to its terminal is the person's. */
  modeChanged(id: string, to: string) {
    if (to === "terminal") this.takeOver(id);
  }

  // ---------------- events ----------------

  /** Someone typed into a child: the person took it over, so it stops reporting. */
  message(id: string, msg: Msg) {
    const c = this.kids[id];
    if (!c || c.released === "person" || msg.role !== "user") return;
    // The person: typed (no origin), a `!` command, or texted in.
    const kind = msg.origin?.kind;
    const person = !kind || kind === "shell" || Object.hasOwn(TEXTED_VIA, kind);
    if (!person) return;
    const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    if (parseSessionMessage(text)) return;
    this.takeOver(id);
  }

  /** A message left a child's queue: whether its next turn comes from the starter (or the person, or Tether), or from another session. */
  queueGone(id: string, text: string) {
    const c = this.kids[id];
    if (!c || c.released) return;
    const from = parseSessionMessage(text)?.sessionId;
    c.foreign = !!from && from !== c.parent;
  }

  /**
   * A child waits on the person (`request`: an open request, told once it's still open after a
   * moment, as a policy may decide it at once): its starter hears, once a turn, as one of its reports.
   */
  async waiting(id: string, what: string, request?: { sessionId: string; id: string }) {
    const c = this.kids[id];
    if (!c || c.released || c.waited || c.foreign) return;
    if (request) {
      await new Promise((r) => setTimeout(r, WAIT_DELAY_MS));
      if (!this.ctx.session(request.sessionId)?.requests.includes(request.id) || c.released || c.waited) return;
    }
    c.waited = true;
    c.reports++;
    const last = c.reports >= MAX_REPORTS;
    await this.report(id, c, `is waiting for the person: ${what}. Only they can answer it, in that session.${last ? ` That's report ${MAX_REPORTS} of ${MAX_REPORTS}: you won't hear from it again.` : ""}`, last);
  }

  /** A child's turn ended: its starter gets its reply (`answered`: an ask took this turn's answer). */
  async turnEnded(id: string, error?: string, stopped?: boolean, answered = false) {
    const c = this.kids[id];
    if (!c) return;
    // The person pressed Stop: theirs, whatever it was released for.
    if (stopped) return this.takeOver(id);
    if (c.released) return;
    const foreign = c.foreign;
    c.waited = false;
    c.foreign = false;
    // Another session's turn (its answer is that session's, not the starter's), or an ask took the answer.
    if (answered || foreign) return this.save();
    const look = this.ctx.session(id);
    // Not done yet: more queued, background work it comes back from, or an open request.
    if (!error && look && (waitingNow(look.state.queue ?? [], Date.now()) || look.background || look.requests.length)) return;
    c.reports++;
    const last = c.reports >= MAX_REPORTS;
    const reply = lastReply(await this.ctx.sessions.recent(id, 30).catch(() => [] as Msg[]));
    const body = [
      error ? `finished a turn with an error: ${error}` : "finished a turn.",
      reply ? `Its last reply:\n<<<\n${reply.length > REPORT_MAX ? `${reply.slice(0, REPORT_MAX)}\n… (cut: open the session for the rest)` : reply}\n>>>` : "It said nothing.",
      last
        ? `That's report ${MAX_REPORTS} of ${MAX_REPORTS}: you won't hear from it again. Tell the person where it stands; once you're done with it, archive it with tether_archive to ${id}.`
        : `Report ${c.reports} of ${MAX_REPORTS}. Follow up with tether_send to ${id} if it isn't done; once you're done with it, archive it with tether_archive to ${id}.`,
    ].join("\n\n");
    await this.report(id, c, body, last);
  }

  private async report(id: string, c: Child, body: string, last: boolean) {
    const parent = await this.look(c.parent);
    // Archived: gone for good, and the child too, as a cascade, when it may go. Not found now: maybe a passing failure, so skip this one only.
    if (parent?.summary.archived) {
      const look = await this.look(id);
      if (c.released) return;
      if (await this.mayNotGo(id, look)) return this.release(id, "gone");
      await this.archiveTree(id, true).catch((e) => {
        this.ctx.log(`peers: couldn't archive ${id}: ${(e as Error).message}`);
        this.release(id, "gone");
      });
      return;
    }
    if (!parent) return this.ctx.log(`peers: couldn't find ${c.parent} to report ${id} to`);
    const child = await this.look(id);
    // Taken over, archived or out of reports while this waited: nothing more goes to the starter.
    if (c.released) return;
    if (last) c.released = "limit";
    this.save();
    const me = { id, title: child?.summary.title || "Untitled" };
    const text = sessionMessage(me, body, `a report from a session you started with tether_start, not the person.`, false, c.hops);
    await this.ctx.sessions.queue(c.parent, text).catch((e) => this.ctx.log(`peers: couldn't report ${id} to ${c.parent}: ${(e as Error).message}`));
  }

  private release(id: string, why: NonNullable<Child["released"]>) {
    const c = this.kids[id];
    if (!c || c.released) return;
    c.released = why;
    this.save();
  }
}
