// Sessions an agent starts (SPEC §9a, tether_start): any session's agent starts a new session on any
// harness, model and effort, in its own folder (or another, a new worktree, or an existing one), with a prompt. The
// child is an ordinary session; the module remembers who started it and, each time it finishes a
// turn, queues its last reply into the starter's chat. The starter follows up with tether_send, or
// starts a fresh one. The child's mode is never looser than the starter's. Reporting stops once the
// person steps in (types into the child or stops it), after MAX_REPORTS, or once the starter is gone.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { markTitle, parseSessionMessage, sessionMessage, TEXTED_VIA } from "../../../../shared/fromTether";
import { LEVELS, mapMode, type Level } from "../../../../shared/move";
import { waitingNow } from "../../../../shared/schedule";
import { HARNESS_LABELS, type HarnessId, type Msg } from "../../../../shared/transcript";
import { pickWorktree, type WorktreeJoined, type WorktreeMade } from "../../../../shared/worktree";
import { LEVEL_WORDS, levelOf } from "../../core/permissionLevel";
import type { ModuleContext, SessionLook } from "..";
import { lastReply } from "../sideChats";
import type { PeerAnswer } from "./server";

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
  /** why it stopped reporting */
  released?: "person" | "limit" | "gone";
}

export interface StartArgs {
  harness?: string;
  prompt?: string;
  model?: string;
  effort?: string;
  title?: string;
  project?: string;
  /** true: a new worktree; a string: an existing one's path or branch */
  worktree?: boolean | string;
}

type Ctx = Pick<ModuleContext, "sessions" | "session" | "log"> & { ops?: Pick<ModuleContext["ops"], "call">; dataDir?: string };

export class Children {
  private kids: Record<string, Child> = {};
  /** starts under way, per starter: counted against CHILDREN_MAX before anything waits */
  private pending = new Map<string, number>();
  private file?: string;

  constructor(private ctx: Ctx) {
    if (ctx.dataDir) {
      this.file = join(ctx.dataDir, "children.json");
      try {
        if (existsSync(this.file)) this.kids = JSON.parse(readFileSync(this.file, "utf8"));
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

  /** The sessions `parent` started that still report to it and are still at work (a finished, idle one doesn't count). */
  following(parent: string): string[] {
    return Object.entries(this.kids).flatMap(([id, c]) => {
      if (c.parent !== parent || c.released) return [];
      const look = this.ctx.session(id);
      if (look?.summary.archived) return [];
      const working = !!look && (look.status !== "idle" || look.busy || look.background || look.requests.length > 0 || waitingNow(look.state.queue ?? [], Date.now()));
      return working ? [id] : [];
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
    try {
      return await this.make(from, a, hops);
    } catch (e) {
      undo();
      return { text: `Nothing was started: ${(e as Error).message}`, isError: true };
    } finally {
      const n = (this.pending.get(from) ?? 1) - 1;
      if (n > 0) this.pending.set(from, n);
      else this.pending.delete(from);
    }
  }

  /**
   * Why `from` can't start a child now, if it can't. Otherwise a slot is reserved at once (so starts
   * side by side can't all pass); start() gives it back.
   */
  refusal(from: string): string | undefined {
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
    const level = this.level(me) ?? LEVELS.readOnly;
    const own = me.summary.projectPath;
    const folder = a.project?.trim() ? s.folder(a.project.trim()) : own;
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
    const source = (await s.sources(harness)).default ?? "subscription";
    const model = a.model?.trim() || undefined;
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
    this.kids[id] = { parent: from, depth: (this.kids[from]?.depth ?? 0) + 1, reports: 0, hops };
    this.save();
    if (title) await s.rename(id, title).catch(() => {});
    const sender = { id: from, title: me.summary.title || "Untitled" };
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
    const how = `${HARNESS_LABELS[harness]}${model ? `, ${model}` : ""}${effort ? `, ${effort} effort` : ""}, ${mode} mode`;
    const where = made
      ? `in a new worktree ${made.path} on branch ${made.branch} (from ${made.base}).${made.setup ? ` The repo's setup (${made.setup}) runs first; the prompt goes once it succeeds.` : ""}`
      : joined
        ? `in the existing worktree ${joined.path}${joined.branch ? ` on branch ${joined.branch}` : ""}.`
        : `in ${folder}.`;
    return { text: `Started ${name} (${how}) ${where}\nIt works on its own. Each time it finishes a turn, its reply comes to you as a message from it. Follow up with tether_send to ${id}, or start a fresh session for new context.` };
  }

  // ---------------- events ----------------

  /** Someone typed into a child: the person took it over, so it stops reporting. */
  message(id: string, msg: Msg) {
    const c = this.kids[id];
    if (!c || c.released || msg.role !== "user") return;
    // The person: typed (no origin), a `!` command, or texted in.
    const kind = msg.origin?.kind;
    const person = !kind || kind === "shell" || Object.hasOwn(TEXTED_VIA, kind);
    if (!person) return;
    const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
    if (parseSessionMessage(text)) return;
    this.release(id, "person");
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
    if (!c || c.released) return;
    if (stopped) return this.release(id, "person");
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
        ? `That's report ${MAX_REPORTS} of ${MAX_REPORTS}: you won't hear from it again. Tell the person where it stands.`
        : `Report ${c.reports} of ${MAX_REPORTS}. Follow up with tether_send to ${id} if it isn't done; otherwise carry on.`,
    ].join("\n\n");
    await this.report(id, c, body, last);
  }

  private async report(id: string, c: Child, body: string, last: boolean) {
    const parent = await this.look(c.parent);
    // Archived: gone for good. Not found now: maybe a passing failure, so skip this one only.
    if (parent?.summary.archived) return this.release(id, "gone");
    if (!parent) return this.ctx.log(`peers: couldn't find ${c.parent} to report ${id} to`);
    if (last) c.released = "limit";
    this.save();
    const child = await this.look(id);
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
