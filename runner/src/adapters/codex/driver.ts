// A live Codex thread through the shared app-server daemon (SPEC §6): one connection per thread,
// subscribed to it (thread/start or thread/resume). The thread lives in the daemon, not in this
// process: Codex's own TUI can join it at the same time (`codex resume`, terminal "shared"), and it
// outlives a runner restart. What the daemon says goes through CodexStream into the session's sink;
// approvals and questions go to the broker through the sink, and close as resolved elsewhere when
// another client (the TUI) answers first (serverRequest/resolved).

import { existsSync } from "node:fs";
import { NATIVE_IMAGE_TYPES, type Attachment } from "../../../../shared/attachments";
import { NATIVE_IMAGE_MAX } from "../../core/attachments";
import { FROM_TETHER, titleText } from "../../../../shared/fromTether";
import { RESOLVED_ELSEWHERE, type Driver, type Sink, type StartOpts } from "../../core/adapter";
import { connect } from "./daemon";
import { agentName } from "./items";
import { dropCache, hasTurnContext, PLACEHOLDER_NAME, turnContextOf } from "./discovery";
import { effOfRollout, effOfSettings, Running, UNKNOWN, type Eff } from "./running";
import { knownMode, looser, modeOf, sandboxOf, sandboxPolicy, type CodexModel } from "./modes";
import { remember, remembered } from "./remember";
import { ASKS, CANT_SHOW, cantShow, codexAnswer, codexAsk, DECLINE_ELICITATION } from "./requests";
import type { CodexRpc } from "./rpc";
import { CodexStream } from "./stream";

/** A message as Codex's input: its text, and the attached images Codex reads from disk. */
const input = (text: string, attachments: Attachment[] = []) => [
  { type: "text", text, text_elements: [] },
  ...attachments.filter((a) => NATIVE_IMAGE_TYPES.has(a.mimeType) && a.size <= NATIVE_IMAGE_MAX).map((a) => ({ type: "localImage", path: a.path })),
];

/** What Codex says when a thread has nothing on disk yet (no turn, no name). */
const NO_ROLLOUT = /no rollout found/i;

/** The settings a new thread starts with (a missing field: Codex's own config). */
function startSettings(opts: StartOpts) {
  const out: Record<string, unknown> = { approvalsReviewer: "user" };
  if (opts.model && opts.model !== "default") out.model = opts.model;
  const m = knownMode(opts.permissionMode);
  if (m) {
    out.approvalPolicy = m.approvalPolicy;
    out.sandbox = m.sandbox;
  }
  return out;
}

/** How long Codex has to confirm settings Tether applied. */
const CONFIRM_MS = Number(process.env.TETHER_CODEX_CONFIRM_MS ?? 8_000);

/** Threads Tether created (newId) that no driver has taken yet. */
const pending = new Map<string, { rpc: CodexRpc; started: any; timer: ReturnType<typeof setTimeout> }>();

/** Creates a thread in the daemon for a new session; its driver picks it up (CodexDriver.open). */
export async function createThread(projectPath: string, opts: StartOpts): Promise<string> {
  if (!existsSync(projectPath)) throw new Error(`There's no folder ${projectPath} on this runner.`);
  const rpc = await connect();
  try {
    const started = await rpc.call("thread/start", { cwd: projectPath, ...startSettings(opts) });
    const id: string = started.thread.id;
    // Until its first turn writes them to its rollout, they can't be read back (discovery.ts).
    remember(id, { start: opts });
    // Nobody took it (the session failed to open): let it go.
    const timer = setTimeout(() => {
      pending.delete(id);
      rpc.close();
    }, 60_000);
    pending.set(id, { rpc, started, timer });
    dropCache();
    return id;
  } catch (e) {
    rpc.close();
    throw e;
  }
}

export class CodexDriver implements Driver {
  readonly stream: CodexStream;
  private closed = false;
  /** a turn/start went out just now: its turn/started may not have arrived yet */
  private starting = false;
  /** open requests by the daemon's request id: aborted when another client answers */
  private asks = new Map<string, AbortController>();
  private defaultModel?: string;
  /** the thread has something on disk (a turn, or a name), so another client can join it */
  private materialized: boolean;
  onExit?: (error?: string) => void;

  private constructor(
    readonly nativeId: string,
    private projectPath: string,
    private rpc: CodexRpc,
    private sink: Sink,
    materialized: boolean,
  ) {
    this.materialized = materialized;
    this.placeholder = !!remembered(nativeId)?.placeholder;
    this.stream = new CodexStream(sink, projectPath, nativeId);
    this.stream.onSettings = (s) => this.settingsChanged(s);
    this.stream.onSpawn = (child, toolId) => this.rememberChild(child, toolId);
    rpc.onNotify((m, p) => this.notify(m, p));
    rpc.onRequest = (m, p, id) => this.request(m, p, id);
    rpc.onClose((reason) => {
      if (this.closed) return;
      this.closed = true;
      this.abortAll();
      this.onExit?.(`The connection to the Codex daemon closed (${reason}). Send again to reconnect.`);
    });
  }

  /** A new thread (made by createThread) or an existing one, joined. */
  static async open(nativeId: string, projectPath: string, opts: StartOpts, sink: Sink, resume: boolean): Promise<CodexDriver> {
    if (!existsSync(projectPath)) throw new Error(`The session's folder ${projectPath} doesn't exist any more.`);
    const p = pending.get(nativeId);
    if (p) {
      pending.delete(nativeId);
      clearTimeout(p.timer);
      const d = new CodexDriver(nativeId, projectPath, p.rpc, sink, false);
      d.threadPath = p.started.thread?.path;
      try {
        await d.started(p.started, opts);
      } catch (e) {
        d.closed = true;
        p.rpc.close();
        throw e;
      }
      return d;
    }
    if (!resume) throw new Error("This new Codex session is gone (the daemon may have restarted). Start a new one.");
    const rpc = await connect();
    const d = new CodexDriver(nativeId, projectPath, rpc, sink, true);
    try {
      // Joined as it is: the daemon ignores settings passed here when another client has the thread
      // loaded (Codex's TUI), so changes are applied after, and checked (started).
      const r = await rpc.call("thread/resume", { threadId: nativeId, excludeTurns: true }).catch((e: any) => {
        if (NO_ROLLOUT.test(String(e?.message))) throw new Error("This Codex session never got a message, so there's nothing to reopen. Start a new one.");
        throw e;
      });
      d.threadPath = r.thread?.path;
      await d.started(r, opts);
      // Mid-turn (Codex's TUI, or a turn that went on while the runner was away): carry on from it.
      if (r.thread?.status?.type === "active") {
        const t: any = await rpc.call("thread/turns/list", { threadId: nativeId, limit: 1, sortDirection: "desc", itemsView: "full" }).catch(() => undefined);
        const turn = t?.data?.[0];
        if (turn && turn.status === "inProgress") {
          // What that turn runs with: its turn_context (written when it started), whatever the
          // thread's settings are now (they may have been changed since, here or elsewhere). Not
          // found: unknown (fail closed).
          const ctx = await turnContextOf(r.thread?.path, turn.id);
          d.running.set(nativeId, "turn", ctx ? effOfRollout(ctx) : UNKNOWN);
          d.stream.seedTurn(turn);
        }
      }
      // Subagents still running, whether or not the turn that spawned them still does.
      await d.rejoinChildren();
      d.reportTurn();
    } catch (e) {
      d.closed = true;
      rpc.close();
      throw e;
    }
    return d;
  }

  /**
   * After start or resume: what you changed in Tether (`opts`; for a new thread with no turn yet,
   * also what it started with) is applied with thread/settings/update and confirmed by the
   * daemon's thread/settings/updated before anything is sent. What isn't confirmed fails the start:
   * a turn never runs with looser settings than you chose. Then the thread's settings as they are
   * become the session's (the thread is the truth; Tether only changes what you change).
   */
  private async started(r: any, opts: StartOpts) {
    const start = remembered(this.nativeId)?.start;
    const want: StartOpts = { ...(start && !(await hasTurnContext(r.thread)) ? start : {}), ...opts };
    const cur = { model: r.model as string | undefined, effort: (r.reasoningEffort ?? undefined) as string | undefined, approvalPolicy: r.approvalPolicy as string | undefined, sandbox: sandboxOf(r.sandbox), reviewer: r.approvalsReviewer as string | undefined };
    // Default picked here (now, or before a restart): shown as Default while it runs the default model.
    if (want.model === "default" || (!want.model && remembered(this.nativeId)?.modelAlias === "default")) {
      this.setAlias("default");
      await this.defaultId();
    } else if (want.model) this.setAlias(undefined);
    const model = want.model === "default" ? await this.defaultId() : want.model;
    const mode = knownMode(want.permissionMode);
    const patch: Record<string, unknown> = {};
    if (model && model !== cur.model) patch.model = model;
    if (want.effort && want.effort !== cur.effort) patch.effort = want.effort;
    // A mode set in Tether includes who answers approvals (you, or Codex's reviewer: "Approve for me").
    if (mode && (mode.approvalPolicy !== cur.approvalPolicy || mode.sandbox !== cur.sandbox || (mode.reviewer ?? "user") !== (cur.reviewer ?? "user")))
      Object.assign(patch, { approvalPolicy: mode.approvalPolicy, sandboxPolicy: sandboxPolicy(mode.sandbox), approvalsReviewer: mode.reviewer ?? "user" });
    let now: any = { model: cur.model, effort: cur.effort, approvalPolicy: cur.approvalPolicy, sandboxPolicy: r.sandbox, approvalsReviewer: cur.reviewer };
    if (Object.keys(patch).length) {
      const seen = this.nextSettings(CONFIRM_MS);
      try {
        await this.rpc.call("thread/settings/update", { threadId: this.nativeId, ...patch });
      } catch (e: any) {
        throw new Error(`Codex didn't take your settings (${e?.message ?? e}). Nothing was sent.`);
      }
      const s = await seen;
      if (!s) throw new Error("Codex didn't confirm your settings. Nothing was sent; try again.");
      now = s;
      const missed = [
        patch.model && s.model !== patch.model ? `model ${patch.model}` : "",
        patch.effort && s.effort !== patch.effort ? `effort ${patch.effort}` : "",
        patch.approvalPolicy && (s.approvalPolicy !== mode!.approvalPolicy || sandboxOf(s.sandboxPolicy) !== mode!.sandbox) ? "permissions" : "",
      ].filter(Boolean);
      if (missed.length) throw new Error(`Codex didn't apply your ${missed.join(", ")}. Nothing was sent.`);
    }
    this.settingsChanged(now);
  }

  /** The model "Default" stands for (model/list's default). */
  private async defaultId(): Promise<string | undefined> {
    this.defaultModel ??= ((await this.rpc.call("model/list", {}).catch(() => ({ data: [] }))).data as CodexModel[]).find((m) => m.isDefault)?.id;
    return this.defaultModel;
  }

  /** "default" while the thread runs the default model because you picked Default (remembered across restarts). */
  private alias?: string;

  private setAlias(a: string | undefined) {
    if (this.alias === a) return;
    this.alias = a;
    remember(this.nativeId, { modelAlias: a });
  }

  /** Waiters for the thread's next thread/settings/updated. */
  private settingsWaiters: ((s: any) => void)[] = [];

  private nextSettings(ms: number): Promise<any | undefined> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.settingsWaiters = this.settingsWaiters.filter((w) => w !== done);
        resolve(undefined);
      }, ms);
      const done = (s: any) => {
        clearTimeout(t);
        resolve(s);
      };
      this.settingsWaiters.push(done);
    });
  }

  // ---------------- what the daemon says ----------------

  private notify(method: string, p: any) {
    if (method === "serverRequest/resolved") return this.resolved(String(p.requestId));
    if (method === "thread/name/updated" && p.threadId === this.nativeId && p.threadName && p.threadName !== PLACEHOLDER_NAME && this.placeholder) {
      this.placeholder = false;
      remember(this.nativeId, { placeholder: undefined });
    }
    // Its first turn wrote its settings to its rollout: they can be read back from there now.
    if (method === "turn/completed" && p.threadId === this.nativeId && remembered(this.nativeId)?.start) remember(this.nativeId, { start: undefined });
    if (method === "turn/completed" && p.threadId === this.nativeId && this.placeholder) void this.namePlaceholder();
    if (method === "thread/closed" && p.threadId === this.nativeId && !this.closed) {
      this.closed = true;
      this.abortAll();
      this.rpc.close();
      return this.onExit?.();
    }
    this.stream.handle(method, p);
    this.track(method, p);
  }

  /** What runs on this thread now, each with the settings it really runs with (running.ts). */
  readonly running = new Running();
  /** the thread's rollout file (where its turns' turn_contexts are) */
  threadPath?: string;
  /** the settings Tether pinned on the turn it is starting (turn/start carries them) */
  private pinned?: Eff;

  /** Keeps `running` in step with turns starting and ending, on the thread and its subagents. */
  private track(method: string, p: any) {
    const id: string | undefined = p?.threadId;
    if (!id || (method !== "turn/started" && method !== "turn/completed")) return;
    const main = id === this.nativeId;
    if (!main && !this.stream.child(id)) return;
    if (method === "turn/completed") {
      this.running.delete(id);
      if (!main) this.forgetChild(id);
      return this.reportTurn();
    }
    const turnId: string | undefined = p.turn?.id;
    if (main && this.pinned) {
      // A turn Tether started: it runs exactly what was pinned on it.
      this.running.set(id, "turn", this.pinned);
      this.pinned = undefined;
      return this.reportTurn();
    }
    // Started elsewhere (Codex's TUI), or a subagent's: what the daemon last said meanwhile, then
    // its turn_context once the rollout has it (not found: unknown).
    const provisional = main ? this.currentEff() : (this.running.get(this.nativeId)?.eff ?? this.currentEff());
    this.running.set(id, main ? "turn" : "subagent", provisional);
    this.reportTurn();
    if (turnId) void this.readTurnEff(id, turnId, main ? this.threadPath : undefined);
  }

  /** A turn's real settings from its turn_context, a few tries while the rollout catches up. */
  private async readTurnEff(id: string, turnId: string, path?: string) {
    let where = path;
    for (let i = 0; i < 6 && this.running.has(id) && !this.closed; i++) {
      where ??= (await this.rpc.call("thread/read", { threadId: id, includeTurns: false }).catch(() => undefined))?.thread?.path;
      const ctx = await turnContextOf(where, turnId);
      if (ctx) {
        const e = this.running.get(id);
        if (e) this.running.set(id, e.kind, effOfRollout(ctx));
        return this.reportTurn();
      }
      await Bun.sleep(this.retryMs);
    }
    const e = this.running.get(id);
    if (e) {
      this.running.set(id, e.kind, UNKNOWN);
      this.reportTurn();
    }
  }

  /** Pause between reads of a turn's turn_context. */
  retryMs = 700;

  private currentEff(): Eff {
    return effOfSettings(this.current ?? {});
  }

  /**
   * What the header shows beside the settings: anything running with other settings than shown
   * (`turnSettings`, with `looser` and Stop when it has more access, or isn't known).
   */
  reportTurn() {
    this.sink.state({ turnSettings: this.running.report(this.currentEff()) });
  }

  turnRunning() {
    return !!this.stream.main.turnId || this.running.has(this.nativeId);
  }

  /** A turn's settings are pinned on turn/start: a turn Tether starts runs exactly what's shown. */
  readonly pinsSettings = true;

  private rememberChild(id: string, toolId: string) {
    remember(this.nativeId, { children: { ...remembered(this.nativeId)?.children, [id]: toolId } });
  }

  private forgetChild(id: string) {
    const c = { ...remembered(this.nativeId)?.children };
    if (!(id in c)) return;
    delete c[id];
    remember(this.nativeId, { children: Object.keys(c).length ? c : undefined });
  }

  /**
   * After joining: subagents still running (remembered from their spawn, or listed as the thread's
   * children), with their running turns and the settings those really have.
   */
  async rejoinChildren() {
    const ids = new Set(Object.keys(remembered(this.nativeId)?.children ?? {}));
    const listed: any = await this.rpc.call("thread/list", { parentThreadId: this.nativeId, limit: 50, sourceKinds: ["subAgent", "subAgentThreadSpawn", "subAgentOther"] }).catch(() => undefined);
    for (const t of listed?.data ?? []) if (t?.id && t.status?.type === "active") ids.add(t.id);
    for (const child of ids) {
      const t = (await this.rpc.call("thread/read", { threadId: child, includeTurns: false }).catch(() => undefined))?.thread;
      const ct: any = await this.rpc.call("thread/turns/list", { threadId: child, limit: 1, sortDirection: "desc", itemsView: "full" }).catch(() => undefined);
      const turn = ct?.data?.[0];
      // Running: its latest turn is in progress (and the daemon, when it says, has it active).
      if (turn?.status !== "inProgress" || (t && t.status?.type !== "active")) {
        this.forgetChild(child);
        if (this.stream.child(child)) this.stream.seedChildTurn(child, undefined);
        continue;
      }
      this.stream.adoptChild(child, remembered(this.nativeId)?.children?.[child], agentName(t));
      this.stream.seedChildTurn(child, turn);
      const ctx = await turnContextOf(t?.path, turn.id);
      this.running.set(child, "subagent", ctx ? effOfRollout(ctx) : UNKNOWN);
    }
  }

  /** Settings changed on the thread (here, or /model and /approvals in Codex's TUI). */
  private settingsChanged(s: any) {
    this.current = { ...this.current, ...s };
    const mode = modeOf(s.approvalPolicy ?? this.current?.approvalPolicy, s.sandboxPolicy ?? this.current?.sandboxPolicy, s.approvalsReviewer ?? this.current?.approvalsReviewer);
    // Kept for when the session is stored: a change with no turn after it isn't in the rollout.
    const c = this.current;
    const cmode = modeOf(c.approvalPolicy, c.sandboxPolicy, c.approvalsReviewer);
    remember(this.nativeId, { applied: { ...(c.model ? { model: c.model } : {}), ...(c.effort ? { effort: c.effort } : {}), ...(cmode ? { permissionMode: cmode } : {}), at: Date.now() } });
    const waiters = this.settingsWaiters.splice(0);
    for (const w of waiters) w(s);
    // Default stays Default while it runs the default model (a model picked since ends it).
    if (s.model && this.alias === "default" && s.model !== this.defaultModel) this.setAlias(undefined);
    const model = s.model && this.alias === "default" ? "default" : s.model;
    this.sink.state({
      ...(s.model ? { model, modelResolved: s.model } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(mode ? { permissionMode: mode } : {}),
    });
    this.reportTurn();
  }

  /** The daemon asks (an approval, a question): the broker decides. */
  private request(method: string, p: any, id: number | string): Promise<unknown> | null {
    // Not about this thread (account, auth, …): another client may answer it; Tether never does.
    const thread: string | undefined = p?.threadId;
    if (!thread) return null;
    if (thread === this.nativeId || this.stream.child(thread)) return this.ask(method, p, id, thread);
    // A subagent's, before its spawn was reported: it shows in its own view once that comes, else
    // in the main session's (never lost, never answered on its own).
    return (async () => {
      for (let i = 0; i < 40 && !this.stream.child(thread) && !this.closed; i++) await Bun.sleep(250);
      return this.ask(method, p, id, thread);
    })();
  }

  private ask(method: string, p: any, id: number | string, thread: string): Promise<unknown> {
    const sink = thread === this.nativeId ? this.sink : (this.stream.child(thread)?.sink ?? this.sink);
    // What Tether can't show (an MCP form, a link, a method it doesn't know): left for Codex's TUI,
    // with a card saying so. Declining from Tether is the one answer it can give.
    const ask = (ASKS.has(method) && codexAsk(method, p, this.projectPath, p.itemId ? this.stream.patch(thread!, p.itemId) : undefined)) || cantShow(method, p);
    const ac = new AbortController();
    const key = String(id);
    if (this.resolvedEarly.delete(key)) return Promise.resolve(undefined);
    this.asks.set(key, ac);
    return sink.request(ask, ac.signal).then(async (d) => {
      this.asks.delete(key);
      // Answered elsewhere (the TUI) or stopped: the daemon isn't waiting for this answer.
      if (ac.signal.aborted) return undefined;
      // Codex's "decline" tells the model nothing: a reason goes into the turn as a steer.
      if (ask.tool === CANT_SHOW) {
        if (method === "mcpServer/elicitation/request") return DECLINE_ELICITATION;
        throw new Error("Declined in Tether.");
      }
      if (!d.allow && !d.interrupt && d.reason) void this.steerTurn(thread!, `${FROM_TETHER}${d.reason}`).catch(() => {});
      return codexAnswer(method, p, d);
    });
  }

  /** requests answered elsewhere before Tether showed them (a subagent's, waiting for its spawn) */
  private resolvedEarly = new Set<string>();

  private resolved(requestId: string) {
    const ac = this.asks.get(requestId);
    if (!ac) {
      this.resolvedEarly.add(requestId);
      if (this.resolvedEarly.size > 200) this.resolvedEarly.delete(this.resolvedEarly.values().next().value!);
      return;
    }
    this.asks.delete(requestId);
    ac.abort(RESOLVED_ELSEWHERE);
  }

  private abortAll() {
    for (const ac of this.asks.values()) ac.abort();
    this.asks.clear();
  }

  // ---------------- driving ----------------

  /**
   * Starts a turn with the settings shown (`shown`, the session's as Tether shows them) pinned on
   * it: turn/start carries model, effort, approval policy, sandbox and reviewer, so the turn runs
   * exactly what's shown, whatever the thread had a moment before.
   */
  async send(text: string, attachments: Attachment[] = [], shown: StartOpts = {}) {
    if (this.closed) throw new Error("This Codex session isn't connected.");
    if (this.turnRunning()) throw new Error("Codex is still working on a turn started elsewhere. Stop it first, or wait for it to finish.");
    const pin = await this.pins(shown);
    this.sink.state({ status: "running", error: undefined });
    try {
      this.starting = true;
      const pinned = { ...this.currentEff(), ...pin.eff };
      this.pinned = pinned;
      await this.rpc.call("turn/start", { threadId: this.nativeId, input: input(text, attachments), ...pin.params }).finally(() => setTimeout(() => (this.starting = false), 5000));
      // Its turn/started may come before or after this answer: either way it runs what was pinned.
      if (this.running.has(this.nativeId)) {
        this.running.set(this.nativeId, "turn", pinned);
        this.reportTurn();
      }
      this.materialized = true;
    } catch (e: any) {
      this.pinned = undefined;
      this.sink.state({ status: "idle" });
      throw new Error(`Codex didn't start the turn: ${e?.message ?? e}`);
    }
  }

  /** turn/start's settings for what's shown (a mode Tether can't express isn't pinned: it shows as Unknown). */
  private async pins(shown: StartOpts): Promise<{ params: Record<string, unknown>; eff: Eff }> {
    const params: Record<string, unknown> = {};
    const eff: Eff = {};
    const model = shown.model === "default" ? await this.defaultId() : shown.model;
    if (model) params.model = eff.model = model;
    if (shown.effort) params.effort = eff.effort = shown.effort;
    const m = knownMode(shown.permissionMode);
    if (m) {
      Object.assign(params, { approvalPolicy: m.approvalPolicy, sandboxPolicy: sandboxPolicy(m.sandbox), approvalsReviewer: m.reviewer ?? "user" });
      Object.assign(eff, { approvalPolicy: m.approvalPolicy, sandbox: m.sandbox, reviewer: m.reviewer ?? "user", mode: shown.permissionMode });
    }
    return { params, eff };
  }

  async steer(text: string, attachments: Attachment[] = []) {
    await this.steerTurn(this.nativeId, text, attachments);
  }

  private async steerTurn(threadId: string, text: string, attachments: Attachment[] = []) {
    const current = () => (threadId === this.nativeId ? this.stream.main.turnId : this.stream.child(threadId)?.turnId);
    // A turn Tether just started: the daemon says turn/started a moment later (slower when busy).
    for (let i = 0; !current() && this.starting && i < 50; i++) await Bun.sleep(100);
    const turnId = current();
    if (!turnId) throw new Error("Nothing is running to steer. Send it as a new message instead.");
    await this.rpc.call("turn/steer", { threadId, input: input(text, attachments), expectedTurnId: turnId });
  }

  /**
   * Stops the turn, and the subagents running on its settings (they outlive it otherwise), and the
   * commands they left running: interrupting a turn doesn't end a command already running in one
   * of Codex's background terminals, which would go on with the old settings.
   */
  async interrupt() {
    const turnId = this.stream.main.turnId;
    const children = this.stream.runningChildren().filter((c) => c.turnId);
    await Promise.all(children.map((c) => this.stopThread(c.id, c.turnId!)));
    if (turnId) await this.stopThread(this.nativeId, turnId);
    else this.sink.state({ status: "idle" });
  }

  private async stopThread(threadId: string, turnId: string) {
    await this.rpc.call("turn/interrupt", { threadId, turnId }).catch((e) => {
      if (threadId === this.nativeId) throw e;
    });
    await this.rpc.call("thread/backgroundTerminals/clean", { threadId }, 10_000).catch(() => {});
  }

  async setModel(model: string) {
    let id = model;
    if (model === "default") {
      id = (await this.defaultId()) ?? "";
      if (!id) throw new Error("Codex didn't say which model is its default.");
    }
    this.setAlias(model === "default" ? "default" : undefined);
    await this.update({ model: id }, this.current?.model === id);
  }

  async setEffort(effort: string) {
    await this.update({ effort }, this.current?.effort === effort);
  }

  async setPermissionMode(mode: string) {
    const m = knownMode(mode);
    if (!m) throw new Error(`Codex has no permission mode ${mode}.`);
    const reviewer = m.reviewer ?? "user";
    const same = this.current?.approvalPolicy === m.approvalPolicy && sandboxOf(this.current?.sandboxPolicy) === m.sandbox && (this.current?.approvalsReviewer ?? "user") === reviewer;
    await this.update({ approvalPolicy: m.approvalPolicy, sandboxPolicy: sandboxPolicy(m.sandbox), approvalsReviewer: reviewer }, same);
  }

  /** The thread's settings as the daemon last confirmed them (start, resume, thread/settings/updated). */
  private current?: any;

  /**
   * A setting change. The daemon confirms a change with thread/settings/updated (which reports it,
   * and the core then counts it applied); it says nothing when nothing changed, so a value the
   * thread already has is confirmed from what it last said.
   */
  private async update(patch: Record<string, unknown>, already: boolean) {
    await this.rpc.call("thread/settings/update", { threadId: this.nativeId, ...patch });
    if (already && this.current) this.settingsChanged(this.current);
  }

  async stopSubagent(nativeId: string) {
    const turnId = this.stream.child(nativeId)?.turnId;
    if (turnId) await this.stopThread(nativeId, turnId);
  }

  async steerSubagent(nativeId: string, text: string, attachments: Attachment[] = []) {
    await this.steerTurn(nativeId, text, attachments);
  }

  /**
   * Before Codex's TUI joins: a thread with nothing on disk can't be resumed by another client, so
   * a new one gets a name (a placeholder titles ignore) to have its rollout written.
   */
  async beforeTerminal() {
    if (this.materialized) return;
    await this.rpc.call("thread/name/set", { threadId: this.nativeId, name: PLACEHOLDER_NAME });
    this.materialized = true;
    this.placeholder = true;
    remember(this.nativeId, { placeholder: true });
  }

  /** The thread still carries the placeholder name (nobody named it since); kept across restarts. */
  private placeholder: boolean;

  /**
   * After the first turn: the placeholder can't be cleared (Codex refuses an empty name), so the
   * thread is named after its first message, as Tether titles an unnamed one anyway.
   */
  private async namePlaceholder() {
    this.placeholder = false;
    remember(this.nativeId, { placeholder: undefined });
    const t: any = await this.rpc.call("thread/read", { threadId: this.nativeId }).catch(() => undefined);
    const name = t?.thread?.name;
    // A first message of Tether's (a command's output) names the thread by what it is ("$ npm test").
    const first = titleText(String(t?.thread?.preview ?? "")).replace(/\s+/g, " ").trim().slice(0, 80);
    if (name === PLACEHOLDER_NAME && first) await this.rpc.call("thread/name/set", { threadId: this.nativeId, name: first }).catch(() => {});
  }

  busy() {
    return this.stream.runningChildren().length > 0;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abortAll();
    await this.rpc.call("thread/unsubscribe", { threadId: this.nativeId }, 5_000).catch(() => {});
    this.rpc.close();
  }
}
