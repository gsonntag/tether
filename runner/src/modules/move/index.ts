// Moves a session to another harness (SPEC §15): a new session there with the whole history, the
// old one left as it is, each pointing at the other. Knows no harness: sources export and targets
// import through shared/move.ts, and capabilities say which route a target has.

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseSessionId } from "../../../../shared/ids";
import { archiveMarkdown, budgetFor, contextNote, contextOpening, imageName, mapMode, movedFrom, movedTo, PORTABLE_VERSION, planImport, type Level, type MoveOptions, type MoveTarget, type PortableSession, type PortableSubagent } from "../../../../shared/move";
import type { BillingSource } from "../../../../shared/credentials";
import { HARNESS_LABELS, type HarnessId, type Msg } from "../../../../shared/transcript";
import type { Adapter, StartOpts } from "../../core/adapter";
import { movedDir } from "../../core/moved";
import type { Module, ModuleContext, SessionLook } from "..";

const labelOf = (h: HarnessId) => HARNESS_LABELS[h] ?? h;

/** The store was written this recently: something outside Tether may be mid-turn on it. */
const STORE_QUIET_MS = 3_000;

/** Why a session can't move now. */
export function refusal(s: SessionLook): string | undefined {
  if (s.summary.parentSessionId) return "A subagent moves with its main session.";
  if (s.state.mode === "terminal" || s.state.terminal) return "Close the terminal first.";
  if (s.state.requests.length || s.requests.length) return "Answer the open request first.";
  if (s.status !== "idle") return "Wait for the turn to end, or stop it.";
  if (s.state.queue.length) return "Send or cancel the waiting messages first.";
  if (s.busy) return "Wait for what's running in this session to finish.";
  return undefined;
}

/** A mode's level on its harness; anything it can't place is unknown. */
export function levelOf(a: Adapter, mode: string | undefined): Level | undefined {
  if (!mode || !a.move) return undefined;
  return a.move.modes.find((m) => m.mode === mode)?.level ?? a.move.levelOf?.(mode);
}

export function targetMode(source: Adapter, mode: string | undefined, target: Adapter): string {
  return mapMode(levelOf(source, mode), target.move?.modes ?? []);
}

/** The same harness keeps the mode it had; another gets its loosest at or under that level. */
function moveMode(source: Adapter, mode: string | undefined, target: Adapter): string {
  return source.id === target.id && mode && levelOf(source, mode) !== undefined ? mode : targetMode(source, mode, target);
}

async function subagentsOf(a: Adapter, nativeId: string, projectPath: string, seen: Set<string>): Promise<PortableSubagent[]> {
  const out: PortableSubagent[] = [];
  for (const c of await a.listSubagents(nativeId, projectPath).catch(() => [])) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({
      id: c.id,
      title: c.title,
      ...(c.agentType ? { agentType: c.agentType } : {}),
      ...(c.parentToolId ? { parentToolId: c.parentToolId } : {}),
      messages: await a.readHistory(c.nativeId, projectPath),
      subagents: await subagentsOf(a, c.nativeId, projectPath, seen),
    });
  }
  return out;
}

/** The session as the neutral format: everything, images whole. */
export async function exportSession(a: Adapter, s: SessionLook): Promise<PortableSession> {
  const { id, harness, nativeId, projectPath, title } = s.summary;
  const messages = await (a.move?.exportHistory ? a.move.exportHistory(nativeId, projectPath) : a.readHistory(nativeId, projectPath));
  const { model, effort, permissionMode } = s.state;
  return {
    version: PORTABLE_VERSION,
    from: { sessionId: id, harness, harnessLabel: labelOf(harness), title, projectPath, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) },
    messages,
    subagents: await subagentsOf(a, nativeId, projectPath, new Set([id])),
  };
}

function eachMessage(s: PortableSession, f: (m: Msg) => void) {
  const sub = (l: PortableSubagent[]) =>
    l.forEach((a) => {
      a.messages.forEach(f);
      sub(a.subagents);
    });
  s.messages.forEach(f);
  sub(s.subagents);
}

/**
 * Files attached to the session live in its own attachments folder, swept after a while: copies go
 * with the history, and the transcript names the copies.
 */
function carryAttachments(s: PortableSession, from: string | undefined, dir: string) {
  if (!from) return;
  const prefix = `${from.replace(/\/$/, "")}/`;
  const seen = new Map<string, string>();
  const to = join(dir, "attachments");
  eachMessage(s, (m) => {
    m.parts = m.parts.map((p) => {
      if (p.type !== "text" || !p.text.includes(prefix)) return p;
      const text = p.text.replace(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s,)]+`, "g"), (path) => {
        if (seen.has(path)) return seen.get(path)!;
        if (!existsSync(path)) return path;
        mkdirSync(to, { recursive: true, mode: 0o700 });
        const copy = join(to, `${seen.size}-${basename(path)}`);
        cpSync(path, copy);
        seen.set(path, copy);
        return copy;
      });
      return { ...p, text };
    });
  });
}

/** Writes the whole history, privately. Returns the file and the images' folder. */
export function writeArchive(s: PortableSession, dir: string, attachmentsDir?: string, earlier?: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  carryAttachments(s, attachmentsDir, dir);
  const imagesDir = join(dir, "images");
  eachMessage(s, (m) => {
    let n = 0;
    for (const p of m.parts) {
      if (p.type !== "image" || !p.data) continue;
      mkdirSync(imagesDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(imagesDir, imageName(m.id, n++, p.mimeType)), Buffer.from(p.data, "base64"), { mode: 0o600 });
    }
  });
  const file = join(dir, "history.md");
  // Moved before: what didn't fit then is only in that file, so this one goes on from it.
  const before = earlier && existsSync(earlier) ? `\n\n# Before that\n\n${readFileSync(earlier, "utf8")}` : "";
  writeFileSync(file, archiveMarkdown(s, imagesDir) + before, { mode: 0o600 });
  return { file, imagesDir };
}

const notice = (id: string, text: string, sessionId: string): Msg => ({ id, role: "notice", level: "info", ts: Date.now(), parts: [{ type: "text", text }], link: { sessionId, label: "Open it" } });

export class Mover {
  private moving = new Set<string>();
  /** a test forces a route; so does an e2e proving the fallback */
  forceRoute: "context" | undefined = process.env.TETHER_MOVE_ROUTE === "context" ? "context" : undefined;

  constructor(private ctx: Pick<ModuleContext, "sessions" | "dataDir" | "log" | "attachmentsDir">) {}

  private adapter(h: string): Adapter {
    const a = this.ctx.sessions.adapters().find((x) => x.id === h);
    if (!a) throw new Error(`This runner has no ${h}.`);
    return a;
  }

  private async source(id: string) {
    const parsed = parseSessionId(id);
    if (!parsed) throw new Error("That isn't a session id.");
    return { look: await this.ctx.sessions.open(id), adapter: this.adapter(parsed.harness) };
  }

  private async background(a: Adapter, s: SessionLook) {
    return s.background || !!(await a.backgroundRuns?.(s.summary.nativeId).catch(() => false));
  }

  /** Why not now, including what only the harness can say. */
  private async blocked(a: Adapter, s: SessionLook): Promise<string | undefined> {
    const said = refusal(s);
    if (said) return said;
    if (this.moving.has(s.summary.id)) return "It's moving already.";
    if (await a.move?.busy?.(s.summary.nativeId).catch(() => false)) return `A turn is running outside Tether. Wait for it to end.`;
    const changed = a.storeChangedAt?.(s.summary.nativeId, s.summary.projectPath);
    if (changed && Date.now() - changed < STORE_QUIET_MS && s.state.mode !== "live") return "It's being written to. Try again in a moment.";
    return undefined;
  }

  async options(id: string): Promise<MoveOptions> {
    const { look, adapter } = await this.source(id);
    const blocked = adapter.capabilities.move ? await this.blocked(adapter, look) : "This harness can't export a session yet.";
    const candidates = this.ctx.sessions.adapters().filter((a) => a.capabilities.move && a.move);
    const own = await this.ctx.sessions.sourceOf(id);
    const targets: MoveTarget[] = [];
    await Promise.all(
      candidates.map(async (a) => {
        if (!(await a.available().catch(() => false))) return;
        const sameHarness = a.id === adapter.id;
        let sources = await this.ctx.sessions.sources(a.id);
        if (sameHarness) {
          // The same harness is only for changing source: a copy on the same one isn't a move.
          const options = sources.options.filter((o) => o.source !== own);
          if (!options.length) return;
          sources = { options, default: options.some((o) => o.source === sources.default) ? sources.default! : options[0]!.source };
        }
        targets.push({ harness: a.id, label: labelOf(a.id), route: a.capabilities.move!.import, permissionMode: moveMode(adapter, look.state.permissionMode, a), sources, ...(sameHarness ? { sameHarness } : {}) });
      }),
    );
    const background = await this.background(adapter, look);
    // Another harness first: the same one, with another source, comes after.
    return { targets: targets.sort((x, y) => Number(!!x.sameHarness) - Number(!!y.sameHarness) || x.label.localeCompare(y.label)), ...(blocked ? { blocked } : {}), ...(background ? { background: true } : {}) };
  }

  async move(id: string, to: string, choice: { model?: string; effort?: string; source?: unknown }): Promise<{ sessionId: string }> {
    const { look, adapter: from } = await this.source(id);
    const target = this.adapter(to);
    const sameHarness = target.id === from.id;
    const own = await this.ctx.sessions.sourceOf(id);
    if (sameHarness && (choice.source === undefined || choice.source === own)) throw new Error(`It's on ${labelOf(from.id)} already.`);
    if (!from.capabilities.move) throw new Error(`${labelOf(from.id)} can't export a session yet.`);
    if (!target.capabilities.move || !target.move) throw new Error(`${labelOf(target.id)} can't take a session yet.`);
    if (!(await target.available())) throw new Error(`${labelOf(target.id)} isn't on this runner.`);
    const why = await this.blocked(from, look);
    if (why) throw new Error(why);
    const { projectPath } = look.summary;
    if (!existsSync(projectPath)) throw new Error(`The session's folder ${projectPath} doesn't exist any more.`);
    this.moving.add(id);
    try {
      const portable = await exportSession(from, look);
      if (!portable.messages.some((m) => m.role !== "notice")) throw new Error("Nothing to move yet.");
      const background = await this.background(from, look);
      // Never looser than it was (shared/move.ts LEVELS).
      // On Azure the model is one of its deployments: the session core holds it to that.
      const source = await this.ctx.sessions.sourceForNew(target.id, choice.source);
      const opts: StartOpts = { ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}), permissionMode: moveMode(from, look.state.permissionMode, target) };
      const route = this.forceRoute ?? target.capabilities.move.import;
      let moved = route === "native" ? await this.native(target, portable, opts, background, source).catch((e) => void this.ctx.log(`native import into ${target.id} failed, using the file: ${e?.message ?? e}`)) : undefined;
      moved ??= await this.fallback(target, portable, opts, background, source);
      // Between two sources of one harness, the source is what changed.
      const name = (h: Adapter, s: BillingSource) => (sameHarness ? (h.billing?.label(s).label ?? labelOf(h.id)) : labelOf(h.id));
      const note = contextNote(moved.kept, moved.total);
      const stayed = background ? " Background work stayed there." : "";
      await this.ctx.sessions.notice(moved.sessionId, notice(`n-moved-from-${id}`, `${movedFrom(name(from, own))}${note ? ` ${note}` : ""}${stayed}`, id), moved.after ? { after: moved.after } : { first: true });
      await this.ctx.sessions.notice(id, notice(`n-moved-to-${moved.sessionId}`, movedTo(name(target, source)), moved.sessionId));
      this.ctx.log(`moved ${id} to ${moved.sessionId}: ${moved.kept} of ${moved.total} messages in context`);
      return { sessionId: moved.sessionId };
    } finally {
      this.moving.delete(id);
    }
  }

  /**
   * A session's source change (capabilities.sourceCarry): a thread on that source with the history
   * and the same settings, confirmed and unlisted. Native import or nothing: the file route is a
   * turn on the new source that the person didn't ask for.
   */
  async carry(id: string, source: BillingSource): Promise<string> {
    const { look, adapter } = await this.source(id);
    // What's waiting follows the session (live.ts send), so it's no reason to refuse.
    const why = await this.blocked(adapter, { ...look, state: { ...look.state, queue: [] } });
    if (why) throw new Error(why);
    this.moving.add(id);
    try {
      const portable = await exportSession(adapter, look);
      const { effort, permissionMode } = look.state;
      // An Azure deployment's name means nothing on another source: there, the default model.
      const model = (await this.ctx.sessions.sourceOf(id)) === "azure" && source !== "azure" ? undefined : look.state.model;
      const opts: StartOpts = { ...(model && model !== "default" ? { model } : {}), ...(effort ? { effort } : {}), permissionMode: moveMode(adapter, permissionMode, adapter) };
      const moved = await this.native(adapter, portable, opts, await this.background(adapter, look), source, id);
      const note = contextNote(moved.kept, moved.total);
      if (note) await this.ctx.sessions.notice(moved.sessionId, { ...notice(`n-carried-${moved.sessionId}`, note, id), link: undefined }, moved.after ? { after: moved.after } : {});
      this.ctx.log(`${id} goes on as ${moved.sessionId} on ${source}: ${moved.kept} of ${moved.total} messages in context`);
      return moved.sessionId;
    } finally {
      this.moving.delete(id);
    }
  }

  /** The history file of the move that made this session, when one did. */
  private earlier(s: PortableSession) {
    return join(movedDir(s.from.sessionId, this.ctx.dataDir), "history.md");
  }

  /** The harness takes the history itself. Throws, leaving no session, when it doesn't take. */
  private async native(t: Adapter, s: PortableSession, opts: StartOpts, background: boolean, source: BillingSource, carriedFrom?: string) {
    const { projectPath, title } = s.from;
    const nativeId = await this.ctx.sessions.newId(t.id, projectPath, opts, source);
    const dir = movedDir(`${t.id}:${nativeId}`, this.ctx.dataDir);
    try {
      const { file, imagesDir } = writeArchive(s, dir, this.ctx.attachmentsDir, this.earlier(s));
      const window = await t.move!.contextWindow?.(opts.model ?? t.unset?.model).catch(() => undefined);
      const plan = planImport(s, Number(process.env.TETHER_MOVE_BUDGET) || budgetFor(window), { file, imagesDir, background });
      const request = { nativeId, projectPath, title, items: plan.items };
      await t.move!.importHistory!(request);
      if (t.move!.imported && !(await t.move!.imported(request))) throw new Error("the history didn't read back");
      if (carriedFrom) t.move!.carried?.(nativeId, parseSessionId(carriedFrom)!.nativeId);
      const sessionId = await this.ctx.sessions.adopt(t.id, nativeId, projectPath, opts, source, carriedFrom);
      // Where a person opening the session looks: under what came across, above what's new.
      const after = (await t.readHistory(nativeId, projectPath).catch(() => [])).at(-1)?.id;
      return { sessionId, kept: plan.kept, total: plan.total, after };
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      if (carriedFrom) await t.move!.discard?.(nativeId).catch(() => {});
      throw e;
    }
  }

  /** No native import: the whole history in a private file, and a summary as the first turn. */
  private async fallback(t: Adapter, s: PortableSession, opts: StartOpts, background: boolean, source: BillingSource) {
    const sessionId = await this.ctx.sessions.create({ harness: t.id, projectPath: s.from.projectPath, source, ...opts });
    const { file, imagesDir } = writeArchive(s, movedDir(sessionId, this.ctx.dataDir), this.ctx.attachmentsDir, this.earlier(s));
    await this.ctx.sessions.send(sessionId, contextOpening(s, { file, imagesDir, background }));
    const native = parseSessionId(sessionId)!.nativeId;
    // The store exists once the first turn has started.
    void (async () => {
      for (let i = 0; i < 40; i++) {
        if (await t.move!.setTitle?.(native, s.from.projectPath, s.from.title).then(() => true, () => false)) return;
        await Bun.sleep(500);
      }
    })();
    return { sessionId, kept: 0, total: s.messages.filter((m) => m.role !== "notice").length, after: undefined };
  }
}

export const moveModule: Module = {
  name: "move",
  start(ctx) {
    const mover = new Mover(ctx);
    ctx.sessions.carrier((id, source) => mover.carry(id, source));
    ctx.ops.register("moveOptions", (a) => mover.options(String(a.sessionId ?? "")));
    ctx.ops.register("moveSession", (a) => mover.move(String(a.sessionId ?? ""), String(a.harness ?? ""), { ...(typeof a.model === "string" && a.model ? { model: a.model } : {}), ...(typeof a.effort === "string" && a.effort ? { effort: a.effort } : {}), source: a.source }));
  },
};
