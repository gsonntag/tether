// The master context service (docs/master-context.md): one store of memory and skills shared by
// every harness. Off until the user runs the first import from the UI; from then on it watches
// the harnesses' memory, merges what changes, and exports the result back out.
//
//   watch  → scan (watermarks) → merge (background model) → commit + activity → export
//
// Ops for the Memory & Skills page live here too; runner/src/index.ts only routes to them.

import { join } from "node:path";
import type {
  BackgroundModelSetting,
  HarnessId,
  Msg,
  ContextActivity,
  ContextEvent,
  ContextImportPreview,
  ContextProgress,
  ContextSkill,
  ContextStatus,
  ConflictStatus,
  MemoryCommit,
  MemoryConflict,
  MemoryEntry,
  MemoryType,
} from "../../../web/src/shared/protocol";
import { parseEntry } from "../../../web/src/shared/protocol";
import { config, normalizeModelEntry, saveConfig } from "../config";
import { BACKGROUND_HARNESSES, backgroundModel, judgeEnabled, setJudgeEnabled } from "./background";
import { exportAll, isOwnWrite, unexportAll } from "./export";
import { Mutex } from "./git";
import { asType, slugify, type Memory } from "./format";
import { assembleHandoffMemory, captureLearnings, nativeIds, type CapturedFact, type Extractor, type HandoffMemory } from "./handoff";
import { setInjectionEnabled } from "./inject";
import { Merger, modelDecider, type Decider } from "./merge";
import { contextDir, tilde } from "./paths";
import { repoKey } from "./repokey";
import { applySkillPlan, disabledSet, listSkills, planSkills, readMeta, unlinkAll, unlinkSkill, writeMeta } from "./skills";
import { scanSources, watchTargets } from "./sources";
import { Store } from "./store";
import { Watcher } from "./watch";

export interface ContextOptions {
  emit?: (e: ContextEvent) => void;
  decider?: Decider;
  /** guard key → Tether session id (memory_write from a live session) */
  sessionForKey?: (key: string) => string | undefined;
  /** project paths, for repo-scoped skills */
  projects?: () => string[];
  /** the fact extractor run before a handoff (default: the background model) */
  extractor?: Extractor;
}

const today = () => new Date().toISOString().slice(0, 10);

export class ContextService {
  readonly store: Store;
  private merger: Merger;
  private watcher?: Watcher;
  private busy = false;
  private again = false;
  private importing = false;
  private exportTimer?: ReturnType<typeof setTimeout>;
  private emit: (e: ContextEvent) => void;
  /** Everything that writes into harness dirs (skills, exports, disable) runs one at a time. */
  private harnessLock = new Mutex();
  private progress?: ContextProgress;
  private progressAt = 0;

  constructor(private opts: ContextOptions = {}) {
    this.store = new Store(contextDir());
    this.emit = opts.emit ?? (() => {});
    this.merger = new Merger(this.store, opts.decider ?? modelDecider, (e) => this.emit(e));
  }

  get enabled(): boolean {
    return !!config().context?.enabled;
  }

  /** Runner start: resumes watching if the import has run before. Never imports on its own. */
  start() {
    setInjectionEnabled(this.enabled);
    if (!this.enabled) return;
    this.store
      .init()
      .then(() => {
        this.watch();
        setTimeout(() => this.sync(), 10_000); // catch up on what changed while the runner was down
      })
      .catch((e) => console.error(`context: ${e?.message ?? e}`));
  }

  stop() {
    this.watcher?.stop();
    this.watcher = undefined;
    clearTimeout(this.exportTimer);
  }

  private watch() {
    this.watcher ??= new Watcher(() => this.sync(), { debounceMs: 5_000, pollMs: 10 * 60_000, isOwn: isOwnWrite });
    this.watcher.add([...watchTargets(), join(this.store.dir, "inbox")]);
  }

  status(): ContextStatus {
    const cfg = config().context ?? {};
    return {
      enabled: !!cfg.enabled,
      importedAt: cfg.importedAt,
      dir: tilde(this.store.dir),
      memories: this.store.exists() ? this.store.list().length : 0,
      skills: this.store.exists() ? listSkills(this.store.skillsDir, this.meta()).length : 0,
      openConflicts: this.store.conflicts().filter((c) => c.status === "open").length,
      busy: this.busy || this.importing,
      progress: this.progress,
    };
  }

  /** Progress for the wizard: phase changes and the last item are sent at once, the rest throttled. */
  private setProgress(p: ContextProgress | undefined) {
    const phaseChanged = p?.phase !== this.progress?.phase;
    this.progress = p;
    const now = Date.now();
    if (!p || phaseChanged || p.done >= p.total || now - this.progressAt > 250) {
      this.progressAt = now;
      this.emit({ type: "status", status: this.status() });
    }
  }

  private meta() {
    return readMeta(join(this.store.dir, "skills.json"));
  }

  private act(a: Omit<ContextActivity, "id" | "ts">) {
    const full = this.store.activity(a);
    this.emit({ type: "activity", activity: full });
  }

  // ---------------- import / sync ----------------

  /** The first-run wizard's dry run: reads everything, writes nothing. */
  async preview(): Promise<ContextImportPreview> {
    const scan = await scanSources(this.store.exists() ? this.store : undefined, { changedOnly: true });
    const meta = this.meta();
    const plan = planSkills(this.store.skillsDir, join(this.store.dir, "backup", today()), disabledSet(meta), meta);
    const exp = await exportAll(this.store, { dryRun: true });
    scan.warnings.push(...(plan.warnings ?? []));
    return {
      memories: scan.entries.map((e) => ({ harness: e.harness, path: tilde(e.path), title: e.title, scope: e.scope ?? "decided on import" })),
      skills: plan.skills.map((s) => ({ name: s.name, from: s.from ? tilde(s.from.path) : "library", drift: s.drift, exposedAs: s.exposedAs })),
      backups: plan.backups.map((b) => ({ path: tilde(b.path), skill: b.skill, to: tilde(b.to) })),
      symlinks: plan.symlinks.map((l) => ({ path: tilde(l.path), target: tilde(l.target) })),
      managedFiles: exp.written.map(tilde),
      mcpConfigs: exp.mcpConfigs.map(tilde),
      warnings: [...scan.warnings, ...exp.warnings],
    };
  }

  /** The "Import" button. Returns at once; progress arrives as activity and status events. */
  async runImport(): Promise<ContextStatus> {
    if (this.importing) return this.status(); // a second click while the first import runs
    await this.store.init();
    const cfg = config();
    cfg.context = { ...cfg.context, enabled: true, importedAt: Date.now() };
    saveConfig();
    setInjectionEnabled(true);
    this.importing = true;
    this.act({ kind: "import", text: "Import started" });
    void (async () => {
      try {
        await this.syncSkills();
        await this.sync({ forceExport: true });
        if (this.enabled) this.watch();
        this.act({ kind: "import", text: "Import finished" });
      } finally {
        this.importing = false;
        this.setProgress(undefined);
      }
    })().catch((e) => this.act({ kind: "error", text: `Import failed: ${e?.message ?? e}` }));
    return this.status();
  }

  /** Resolves when the import started by runImport() (if any) and any sync pass are done. */
  async idle(): Promise<void> {
    while (this.importing || this.busy) await Bun.sleep(50);
    await this.harnessLock.run(async () => {});
  }

  /** One pass: changed sources → merge → export. Overlapping calls fold into one more pass. */
  async sync(opts: { forceExport?: boolean } = {}): Promise<void> {
    if (!this.enabled) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    this.emit({ type: "status", status: this.status() });
    try {
      let force = !!opts.forceExport;
      do {
        this.again = false;
        this.setProgress({ phase: "scan", done: 0, total: 0 });
        const { entries, warnings } = await scanSources(this.store, { changedOnly: true });
        for (const w of warnings) console.error(`context: ${w}`);
        for (const e of entries) if (!e.sessionId && e.sessionKey) e.sessionId = this.opts.sessionForKey?.(e.sessionKey);
        const out = await this.merger.mergeAll(entries, (done, total) => this.setProgress({ phase: "merge", done, total }));
        const changed = out.some((o) => o.commit);
        if (!this.enabled) break; // turned off mid-pass: export nothing
        if (force || changed || entries.some((e) => e.consume)) await this.exportNow();
        force = false;
        this.watcher?.add(watchTargets());
      } while (this.again);
    } finally {
      this.busy = false;
      if (!this.importing) this.progress = undefined;
      this.emit({ type: "status", status: this.status() });
    }
  }

  /** Imports skills found in harness dirs (backing up what they replace) and installs symlinks. */
  async syncSkills(): Promise<void> {
    await this.harnessLock.run(() => this.syncSkillsLocked());
  }

  private async syncSkillsLocked(): Promise<void> {
    if (!this.enabled) return;
    const meta = this.meta();
    const plan = planSkills(this.store.skillsDir, join(this.store.dir, "backup", today()), disabledSet(meta), meta);
    for (const w of plan.warnings ?? []) console.error(`context: skill ${w}`);
    if (!plan.backups.length && !plan.symlinks.length && !plan.skills.some((s) => s.from)) return;
    this.setProgress({ phase: "skills", done: 0, total: plan.skills.length });
    const { changed, log, errors } = applySkillPlan(this.store.skillsDir, plan, meta);
    writeMeta(join(this.store.dir, "skills.json"), meta);
    const commit = await this.store.commitPaths([...changed, join(this.store.dir, "skills.json")], `skills: import ${changed.length} skill(s)`);
    this.setProgress({ phase: "skills", done: plan.skills.length, total: plan.skills.length });
    for (const l of log.slice(0, 200)) this.act({ kind: "skill", text: l, commit });
    for (const e of errors.slice(0, 50)) this.act({ kind: "error", text: `Skill not synced (left as it was): ${e}` });
    for (const s of plan.skills) if (s.drift.length) this.act({ kind: "drift", text: `Skill ${s.name}: kept the newest copy; ${s.drift.join(", ")} differed (originals are in the backup)` });
  }

  private async exportNow() {
    await this.harnessLock.run(async () => {
      if (!this.enabled) return;
      await this.syncSkillsLocked();
      this.setProgress({ phase: "export", done: 0, total: 1 });
      const r = await exportAll(this.store);
      this.setProgress({ phase: "export", done: 1, total: 1 });
      for (const w of r.warnings) console.error(`context: ${w}`);
      if (r.written.length) this.act({ kind: "export", text: `Updated ${r.written.map(tilde).join(", ")}` });
    });
  }

  private exportSoon() {
    clearTimeout(this.exportTimer);
    this.exportTimer = setTimeout(() => this.exportNow().catch((e) => this.act({ kind: "error", text: `Export failed: ${e?.message ?? e}` })), 2_000);
  }

  // ---------------- handoff ----------------

  /**
   * Memory for a cross-harness handoff (runner/src/context/handoff.ts): captures what the outgoing
   * session learned (bounded by `timeoutMs`; a late answer is still merged), then assembles the
   * brief's memory section for `target`. Call `settle()` once the new session has started: it
   * files the captured facts for merging (earlier, the new session's own injection could pick
   * them up and repeat what the brief already says). Undefined when the master context is off, or on any
   * error: the handoff then goes ahead exactly as without memory.
   */
  async handoffMemory(o: {
    sessionId: string;
    projectPath: string;
    messages: Msg[];
    target: HarnessId;
    pendingPrompt?: string;
    budgetTokens?: number;
    timeoutMs?: number;
  }): Promise<HandoffMemory | undefined> {
    if (!this.enabled || !this.store.exists()) return undefined;
    try {
      const key = await repoKey(o.projectPath);
      let captured: CapturedFact[] = [];
      let captureNote: string | undefined;
      let settle: (() => void) | undefined;
      if (config().context?.handoffCapture !== false) {
        const cap = await captureLearnings(this.store, { sessionId: o.sessionId, repoKey: key, messages: o.messages, extractor: this.opts.extractor, timeoutMs: o.timeoutMs });
        captured = cap.facts;
        if (cap.skipped === "timeout") captureNote = "the background model is still extracting facts; they'll be merged when it finishes";
        else if (cap.skipped === "failed") captureNote = "the background model couldn't extract facts this time";
        else if (cap.skipped === "cooling down") captureNote = "skipped, the background model failed or was slow in the last few minutes";
        cap.late.then((filed) => (filed ? this.sync() : undefined)).catch(() => {});
        settle = () => {
          if (cap.file()) void this.sync();
        };
      }
      const all = this.store.list();
      const mem = assembleHandoffMemory({
        entries: all,
        repoKey: key,
        messages: o.messages,
        pendingPrompt: o.pendingPrompt,
        native: nativeIds(this.store, key, o.target, all),
        budgetTokens: o.budgetTokens,
        captured,
        captureNote,
      });
      return { ...mem, settle };
    } catch (e: any) {
      console.error(`context: no handoff memory for ${o.sessionId}: ${e?.message ?? e}`);
      return undefined;
    }
  }

  /**
   * Turns the feature off and undoes every export: managed blocks, MCP registrations, Tether's
   * own files and index lines, skill symlinks (a link that replaced the user's copy becomes a real
   * copy of the current version). The store, its history and the backups are kept.
   */
  async disable(): Promise<ContextStatus> {
    const cfg = config();
    cfg.context = { ...cfg.context, enabled: false };
    saveConfig();
    setInjectionEnabled(false);
    this.stop();
    await this.harnessLock.run(async () => {
      this.setProgress({ phase: "disable", done: 0, total: 2 });
      const r = await unexportAll(this.store);
      this.setProgress({ phase: "disable", done: 1, total: 2 });
      const meta = this.meta();
      const s = unlinkAll(this.store.skillsDir, meta);
      if (this.store.exists()) writeMeta(join(this.store.dir, "skills.json"), meta);
      for (const w of [...r.warnings, ...s.errors]) this.act({ kind: "error", text: `Turning off: ${w}` });
      this.act({
        kind: "export",
        text: `Master context turned off: cleaned ${r.changed.length} file(s), removed ${s.removed.length} skill link(s), put back ${s.restored.length} skill copies`,
      });
      this.setProgress(undefined);
    });
    return this.status();
  }

  // ---------------- memory ops ----------------

  private async scopes(scope?: string): Promise<string[] | undefined> {
    if (!scope || scope === "all") return undefined;
    if (scope === "global" || scope.startsWith("repo:")) return [scope];
    return [`repo:${await repoKey(scope)}`]; // a project path
  }

  async listMemories(scope?: string, query?: string): Promise<MemoryEntry[]> {
    const scopes = await this.scopes(scope);
    if (query?.trim()) return this.store.search(query, scopes, 200);
    return this.store.list().filter((m) => !scopes || scopes.includes(m.scope));
  }

  getMemory(id: string): MemoryEntry {
    const m = this.store.get(id);
    if (!m) throw new Error("No such memory");
    return m;
  }

  async editMemory(id: string, change: { name?: string; description?: string; type?: MemoryType; body?: string; remove?: boolean }): Promise<MemoryEntry | {}> {
    this.requireEnabled();
    const cur = this.getMemory(id);
    if (change.remove) {
      const commit = await this.store.put(id, undefined, `memory: delete ${id} (by you)`);
      this.act({ kind: "delete", text: `Deleted "${cur.description}"`, memoryId: id, source: "you", commit });
      this.exportSoon();
      return {};
    }
    const next: Memory = {
      name: change.name ? (slugify(change.name) ?? cur.name) : cur.name,
      description: change.description?.trim() || cur.description,
      type: asType(change.type) ?? cur.type,
      scope: cur.scope,
      sources: cur.sources,
      updated: new Date().toISOString(),
      body: change.body?.trim() || cur.body,
    };
    const commit = await this.store.put(id, next, `memory: edit ${id} (by you)`);
    this.act({ kind: "edit", text: `Edited "${next.description}"`, memoryId: id, source: "you", commit });
    this.exportSoon();
    return this.getMemory(id);
  }

  async history(id: string): Promise<MemoryCommit[]> {
    return this.store.history(id);
  }

  activity(limit?: number, before?: number): ContextActivity[] {
    return this.store.readActivity(Math.min(limit ?? 100, 1000), before);
  }

  conflicts(status: ConflictStatus | "all" = "open"): MemoryConflict[] {
    return this.store
      .conflicts()
      .filter((c) => status === "all" || c.status === status)
      .sort((a, b) => b.ts - a.ts);
  }

  async resolveConflict(id: string, action: "keep-new" | "keep-old" | "dismiss"): Promise<MemoryConflict> {
    const list = this.store.conflicts();
    const c = list.find((x) => x.id === id);
    if (!c) throw new Error("No such conflict");
    if (c.status !== "open") return c;
    let commit: string | undefined;
    if (action === "keep-old") {
      if (!c.commit) throw new Error("This conflict has no commit to undo");
      const old = await this.store.before(c.memoryId, c.commit);
      commit = await this.store.restore(c.memoryId, old, `memory: keep old ${c.memoryId}\n\nundoes ${c.commit}`);
      this.exportSoon();
    }
    c.status = action === "keep-new" ? "kept-new" : action === "keep-old" ? "kept-old" : "dismissed";
    this.store.saveConflicts(list);
    this.act({
      kind: "resolve",
      text: action === "keep-old" ? `Kept the old version of "${c.name}"` : action === "keep-new" ? `Kept the new version of "${c.name}"` : `Dismissed the conflict on "${c.name}"`,
      memoryId: c.memoryId,
      source: "you",
      commit,
      sessionId: c.sessionId,
    });
    this.emit({ type: "conflict", conflict: c });
    return c;
  }

  // ---------------- skills ----------------

  listSkills(): ContextSkill[] {
    return listSkills(this.store.skillsDir, this.meta(), this.opts.projects?.() ?? []);
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<ContextSkill[]> {
    this.requireEnabled();
    await this.harnessLock.run(async () => {
      const meta = this.meta();
      if (!meta[name] && !this.listSkills().some((s) => s.name === name && !s.repo)) throw new Error("No such skill");
      meta[name] = { ...meta[name], sources: meta[name]?.sources ?? [], disabled: !enabled };
      writeMeta(join(this.store.dir, "skills.json"), meta);
      // Disabling only removes our links (their places stay recorded, so enabling puts them back).
      if (!enabled) unlinkSkill(this.store.skillsDir, name);
      await this.store.commitPaths([join(this.store.dir, "skills.json")], `skills: ${enabled ? "enable" : "disable"} ${name}`);
      if (enabled) await this.syncSkillsLocked();
    });
    return this.listSkills();
  }

  // ---------------- background model ----------------

  backgroundModel(): BackgroundModelSetting {
    return { model: backgroundModel(), judge: judgeEnabled(), harnesses: BACKGROUND_HARNESSES };
  }

  /** Sets the shared model only; whether the judge runs is setJudgeEnabled's business. */
  setBackgroundModel(model: string): BackgroundModelSetting {
    const norm = normalizeModelEntry(model);
    if (!norm) throw new Error("Pick a model");
    const e = parseEntry(norm, "claude-code");
    if (!BACKGROUND_HARNESSES.includes(e.harness)) throw new Error(`${e.harness} can't run background work`);
    config().backgroundModel = norm;
    saveConfig();
    return this.backgroundModel();
  }

  setJudgeEnabled(on: boolean): BackgroundModelSetting {
    setJudgeEnabled(on);
    return this.backgroundModel();
  }

  private requireEnabled() {
    if (!this.enabled) throw new Error("Run the first import before editing the master context.");
  }
}
