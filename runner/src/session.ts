import {
  formatEntry,
  parseEntry,
  type ChainEntry,
  type HarnessId,
  type LiveState,
  type Msg,
  type SessionEvent,
  type SessionSnapshot,
  type SessionSummary,
  type UiRequest,
  type UiResponse,
} from "../../web/src/shared/protocol";
import { userParts } from "../../web/src/shared/bash";
import { applyEvent, emptyState, type Transcript } from "../../web/src/shared/reducer";
import { guardEnv, registerGuard, unregisterGuard } from "./bridge";
import { restore as restoreTree, snapshot } from "./checkpoint";
import { config, prefs, saveConfigSoon } from "./config";
import { usageChanged } from "./usage";
import { notify } from "./notify";
import { backoffMs, classify, markExhausted, pickEntry, profile, providerOf, type Classified } from "./fallback";
import { commandOf, judge, kindOf, rules, type GuardMode, type Verdict } from "./guard";
import type { Checkpoint, GuardVerdict, Part, PendingMessage } from "../../web/src/shared/protocol";

export type Emit = (sessionId: string, seq: number, event: SessionEvent) => void;
export type SummaryChanged = (s: SessionSummary) => void;
/** Moves the conversation to a new session in another harness (runner/src/index.ts). */
export type Handoff = (from: LiveSession, to: ChainEntry, reason: string, pendingPrompt?: string) => Promise<void>;

export interface SessionSink {
  emit: Emit;
  summary: SummaryChanged;
  handoff: Handoff;
}

let counter = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`;

const IDLE_CLOSE_MS = 30 * 60_000;
const STALL_WARN_MS = 15 * 60_000;

/**
 * One live agent session. The runner keeps the authoritative transcript here; every change goes
 * through emit(), which applies it locally and forwards it to the server with a sequence number,
 * so any number of browsers can join at any time (snapshot + following events).
 */
export abstract class LiveSession {
  readonly harness: HarnessId;
  nativeId: string;
  projectPath: string;
  title: string;
  createdAt: number;
  updatedAt = Date.now();
  t: Transcript = { messages: [], state: emptyState() };
  seq = 0;
  closed = false;

  private fallbackAttempt = 0;
  private waitTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private lastActivity = Date.now();
  private stallWarned = false;
  /** Saving waits until loadPrefs() ran, so start() can't overwrite stored settings. */
  private prefsLoaded = false;
  private diffBaseSha?: string;
  onClose?: () => void;

  constructor(
    harness: HarnessId,
    init: { nativeId: string; projectPath: string; title?: string; createdAt?: number },
    protected sink: SessionSink,
  ) {
    this.harness = harness;
    this.nativeId = init.nativeId;
    this.projectPath = init.projectPath;
    this.title = init.title ?? "New session";
    this.createdAt = init.createdAt ?? Date.now();
    this.t.state.preferEarlier = true;
    this.watchdog = setInterval(() => this.checkStall(), 60_000);
    this.guardKey = registerGuard(this);
  }

  get id() {
    return `${this.harness}:${this.nativeId}`;
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      harness: this.harness,
      nativeId: this.nativeId,
      projectPath: this.projectPath,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      live: !this.closed,
      // A closed session has no process, so nothing can be running.
      status: this.closed ? "idle" : this.t.state.status,
      needsInput: this.t.state.pendingUi.length > 0,
    };
  }

  snapshot(): SessionSnapshot {
    return { session: this.summary(), messages: this.t.messages, state: this.t.state, seq: this.seq };
  }

  emit(event: SessionEvent): void {
    const before = this.t.state.status;
    applyEvent(this.t, event);
    this.seq++;
    this.updatedAt = this.lastActivity = Date.now();
    this.stallWarned = false;
    this.sink.emit(this.id, this.seq, event);
    if (event.type === "state") {
      const s = event.state;
      if (s.status === "idle") usageChanged();
      if (s.status === "running" && before !== "running") this.turnTrouble = this.userStopped = false;
      if (s.status === "idle" && before !== "idle" && !s.handoffTo) this.turnOver();
      if (s.status === "running" || s.pending) this.scheduleSteers();
      if (s.status !== undefined || s.pendingUi !== undefined) {
        this.sink.summary(this.summary());
        this.armIdle();
      }
      if (["status", "chain", "profile", "preferEarlier", "handoffFrom", "handoffTo", "guard", "checkpoints", "pending", "background"].some((k) => k in s))
        this.savePrefs();
    }
    // A verdict can arrive before its tool card (Antigravity hooks run before the step event).
    if (event.type === "msg" && this.pendingVerdicts.size)
      for (const p of event.msg.parts)
        if (p.type === "tool" && this.pendingVerdicts.has(p.id)) {
          const guard = this.pendingVerdicts.get(p.id)!;
          this.pendingVerdicts.delete(p.id);
          this.emit({ type: "tool", msgId: event.msg.id, toolId: p.id, patch: { guard } });
        }
  }

  setState(state: Partial<LiveState>) {
    this.emit({ type: "state", state });
  }

  setTitle(title: string) {
    title = config().titles[this.id] ?? title;
    if (!title || title === this.title) return;
    this.title = title;
    this.sink.summary(this.summary());
  }

  notice(text: string, level: Msg["level"] = "info") {
    this.emit({ type: "msg", msg: { id: newId("n"), role: "notice", parts: [{ type: "text", text }], ts: Date.now(), level } });
    if (level === "error") {
      this.turnTrouble = true;
      this.alert("blocked", "Failed", text);
    }
  }

  // ---- notifications (runner/src/notify.ts pushes them to your devices) ----

  /** the running turn failed (already notified), so its end isn't also "finished" */
  private turnTrouble = false;
  private userStopped = false;

  protected alert(kind: "question" | "finished" | "blocked", what: string, detail: string) {
    const project = this.projectPath.split("/").pop() ?? "";
    notify({
      kind,
      title: `${what} · ${this.title}`.slice(0, 120),
      body: [project, detail.replace(/\s+/g, " ").trim()].filter(Boolean).join(": ").slice(0, 300),
      sessionId: this.id,
      projectPath: this.projectPath,
    });
  }

  private turnOver() {
    if (this.userStopped || this.turnTrouble || this.closed) return;
    const last = [...this.t.messages].reverse().find((m) => m.role === "assistant");
    const text = last?.parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text).join(" ") ?? "";
    this.alert("finished", "Finished", text.slice(-300) || "The agent is waiting for your next message.");
  }

  addUserMessage(text: string, id = newId("u")) {
    // Shell runs already have their own card; don't show them again inside the prompt they ride on.
    for (const block of this.shellShown) if (text.includes(block)) text = text.replace(block, "").trim();
    this.emit({ type: "msg", msg: { id, role: "user", parts: userParts(text, id), ts: Date.now() } });
  }

  // ---- `!` shell mode ----
  // The person runs a command themselves, outside the guard. It shows as a Bash card right away;
  // like Claude Code's `!`, the agent sees the command and its output with the next message.

  private shellContext: string[] = [];
  private shellShown = new Set<string>();

  async runShell(command: string) {
    const id = newId("sh");
    const toolId = `${id}:bash0`;
    const guard: GuardVerdict = { decision: "allow", by: "user", reason: "Run by you directly, outside the guard" };
    this.emit({ type: "msg", msg: { id, role: "user", parts: [{ type: "tool", id: toolId, name: "Bash", input: { command }, status: "running", guard }], ts: Date.now() } });
    const proc = Bun.spawn(["bash", "-lc", command], { cwd: this.projectPath, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10 * 60_000 });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const cap = (s: string) => (s.length > 30_000 ? s.slice(0, 30_000) + "\n…(truncated)" : s.trimEnd());
    const tail = code ? `\n(exit code ${code})` : "";
    const output = [cap(stdout), cap(stderr)].filter(Boolean).join("\n") + tail;
    this.emit({ type: "tool", msgId: id, toolId, patch: { status: code ? "error" : "done", output: output.trim() } });
    const block = `<bash-input>${command}</bash-input>\n<bash-stdout>${cap(stdout)}</bash-stdout><bash-stderr>${cap(stderr) + tail}</bash-stderr>`;
    this.shellContext.push(block);
    this.shellShown.add(block);
  }

  /** Shell runs the agent hasn't seen yet, to go with the next message. */
  withShellContext(text: string): string {
    if (!this.shellContext.length) return text;
    const ctx = this.shellContext.join("\n\n");
    this.shellContext = [];
    return `${text}\n\n${ctx}`;
  }

  // ---- messages the agent has not taken yet ----
  // Tether holds every message sent while the agent works in `pending`: an ordered list that any
  // device can edit, reorder or cancel, saved to disk. Messages only leave from the top:
  //  - steers at the top go into the running turn once their grace period is over (the harness
  //    folds them in at its next step); a queued message blocks everything behind it;
  //  - when the turn ends, the top of the list starts the next turn: the steers at the top (together),
  //    or else the first queued message alone. Queued messages go one per turn, never merged; steers
  //    right below a queued message become eligible to steer into the turn it starts.
  // After Stop nothing leaves on its own (`pendingHeld`) until you send.
  // A steer that already went out can't be taken back; editing it sends a correction instead.

  static STEER_GRACE_MS = 5_000;
  private steerTimer?: ReturnType<typeof setTimeout>;
  /** user messages delivered as steers into the running turn (editable through a correction) */
  private steered = new Map<string, string>();
  /** a turn is being started from the pending list: steers wait until it has been sent */
  private draining = false;

  /** Sends a message: starts a turn when idle, otherwise adds it to the pending list. */
  async prompt(text: string, mode: "steer" | "followUp" = "steer") {
    if (this.t.state.status === "waiting") this.cancelWait();
    if (this.t.state.status === "idle") {
      if (!this.t.state.pending?.length) return this.send(text);
      // Held after Stop: sending releases the hold; the new message joins the bottom of the list,
      // and the list goes out from the top as usual (one queued message per turn).
      this.pend(text, mode);
      this.setState({ pendingHeld: undefined });
      await this.drainPending();
      return;
    }
    this.pend(text, mode);
  }

  protected pend(text: string, mode: "steer" | "followUp", opts: { now?: boolean } = {}): PendingMessage {
    const now = Date.now();
    const p: PendingMessage = { id: crypto.randomUUID(), text, mode, ts: now, ...(mode === "steer" ? { readyAt: opts.now ? now : now + LiveSession.STEER_GRACE_MS } : {}) };
    const list = this.t.state.pending ?? [];
    this.setPending(opts.now ? [p, ...list] : [...list, p]);
    return p;
  }

  private setPending(list: PendingMessage[]) {
    this.setState({ pending: list, ...(list.length ? {} : { pendingHeld: undefined }) }); // emit() reschedules steers
  }

  private scheduleSteers() {
    clearTimeout(this.steerTimer);
    const head = this.t.state.pending?.[0];
    if (!head || head.mode !== "steer" || !this.steer || this.draining || this.t.state.pendingHeld || this.t.state.status !== "running") return;
    this.steerTimer = setTimeout(() => this.deliverSteers(), Math.max(0, (head.readyAt ?? 0) - Date.now()));
  }

  private async deliverSteers() {
    const list = this.t.state.pending ?? [];
    if (this.closed || this.draining || this.t.state.status !== "running" || this.t.state.pendingHeld) return;
    const now = Date.now();
    let n = 0;
    while (n < list.length && list[n]!.mode === "steer" && (list[n]!.readyAt ?? 0) <= now) n++;
    if (!n) return this.scheduleSteers();
    const batch = list.slice(0, n);
    const text = joinPending(batch);
    this.setState({ pending: list.slice(n) });
    let ok = false;
    try {
      ok = await this.steer!(text);
    } catch {}
    if (ok) {
      if (!this.echoesUserMessages) {
        const id = `u-${batch[0]!.id}`;
        this.addUserMessage(text, id);
        this.steered.set(id, text);
        this.setState({ amendable: [...this.steered.keys()] });
      }
    } else {
      // The turn ended meanwhile (or can't take steers right now): back on top, for the next turn.
      this.setState({ pending: [...batch, ...(this.t.state.pending ?? [])] });
      if ((this.t.state.status as string) === "idle") await this.drainPending();
      else if (this.t.state.status === "running" && !this.draining) {
        // Still running but not taking steers right now (e.g. compaction): try again shortly, not in a tight loop.
        clearTimeout(this.steerTimer);
        this.steerTimer = setTimeout(() => this.deliverSteers(), 1_000);
        return;
      }
    }
    this.scheduleSteers();
  }

  /** Adapter: the turn is over. Pending messages (unless held after Stop) start the next turn; true if they did. */
  protected async drainPending(): Promise<boolean> {
    clearTimeout(this.steerTimer);
    if (this.steered.size) {
      this.steered.clear();
      this.setState({ amendable: undefined });
    }
    if (this.closed || this.t.state.pendingHeld) return false;
    const list = this.t.state.pending ?? [];
    const n = nextTurnSize(list);
    if (!n) return false;
    // Steers left at the top may go into this new turn, but only once it has really been sent.
    this.draining = true;
    try {
      this.setPending(list.slice(n));
      await this.send(joinPending(list.slice(0, n)));
    } finally {
      this.draining = false;
    }
    this.scheduleSteers();
    return true;
  }

  private takeAllPending(): string | undefined {
    const list = this.t.state.pending ?? [];
    if (!list.length) return undefined;
    this.setPending([]);
    return joinPending(list);
  }

  /** Edits, reorders, cancels or sends one pending message (from any device). */
  async editPending(id: string, change: { text?: string; mode?: "steer" | "followUp"; index?: number; remove?: boolean; now?: boolean }) {
    const list = [...(this.t.state.pending ?? [])];
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) throw new Error("That message was already sent.");
    if (change.remove || change.text?.trim() === "") {
      list.splice(i, 1);
      return this.setPending(list);
    }
    const p: PendingMessage = { ...list[i]! };
    if (change.text !== undefined) p.text = change.text;
    if (change.mode) p.mode = change.mode;
    if (change.now) p.mode = "steer";
    // An edited steer gets a fresh grace period; "send now" skips it.
    if (p.mode === "steer") p.readyAt = change.now ? Date.now() : change.text !== undefined || change.mode ? Date.now() + LiveSession.STEER_GRACE_MS : (p.readyAt ?? Date.now());
    else delete p.readyAt;
    list.splice(i, 1);
    const to = change.now ? 0 : Math.max(0, Math.min(list.length, change.index ?? i));
    list.splice(to, 0, p);
    if (change.now && this.t.state.status === "idle") {
      // Held after Stop (or the turn just ended): the hold is released and this message starts the
      // next turn; the rest follow from the top as usual.
      this.setState({ pending: list, pendingHeld: undefined });
      await this.drainPending();
      return;
    }
    if (change.now) this.setState({ pendingHeld: undefined });
    this.setPending(list);
  }

  /** ↑ in an empty composer: everything pending comes back as one text to rewrite. */
  takePending(): string {
    return this.takeAllPending() ?? "";
  }

  /** Editing a steer the agent already has: it can't be taken back, so the change goes in as a correction. */
  amendSteer(msgId: string, text: string) {
    const before = this.steered.get(msgId);
    if (before === undefined) throw new Error("That message can't be changed any more: the turn it went into has ended.");
    if (text.trim() === before.trim()) return;
    this.pend(`I changed my earlier message. It said:\n\n${quote(before)}\n\nIt now says:\n\n${quote(text)}\n\nFollow the new version.`, "steer");
  }

  /** The Stop button: aborts the turn. Pending messages stay, held until you send them. */
  async stop() {
    this.userStopped = true;
    clearTimeout(this.steerTimer);
    if (this.t.state.pending?.length) this.setState({ pendingHeld: true });
    await this.abort();
  }

  // ---- persistence of per-session settings ----

  /** Restores settings saved by an earlier run of this session (call once the id is final). */
  loadPrefs() {
    this.prefsLoaded = true;
    const p = prefs(this.id);
    const restore: Partial<LiveState> = {};
    if (p.chain) restore.chain = p.chain;
    if (p.profile) restore.profile = p.profile;
    if (p.preferEarlier !== undefined) restore.preferEarlier = p.preferEarlier;
    if (p.handoffFrom) restore.handoffFrom = p.handoffFrom;
    if (p.handoffTo) restore.handoffTo = p.handoffTo;
    if (p.guard) restore.guard = p.guard;
    if (p.checkpoints) restore.checkpoints = p.checkpoints;
    this.diffBaseSha = p.diffBaseSha;
    if (Object.keys(restore).length) this.setState(restore);
  }

  /** Whether the agent is doing anything a restart would interrupt. */
  get busy(): boolean {
    return this.t.state.status !== "idle" || !!this.t.state.background?.length;
  }

  savePrefs() {
    if (!this.prefsLoaded || this.nativeId.startsWith("pending-")) return;
    const s = this.t.state;
    Object.assign(prefs(this.id), {
      chain: s.chain,
      profile: s.profile,
      preferEarlier: s.preferEarlier,
      handoffFrom: s.handoffFrom,
      handoffTo: s.handoffTo,
      guard: s.guard,
      checkpoints: s.checkpoints,
      diffBaseSha: this.diffBaseSha,
      pending: s.pending?.length ? s.pending : undefined,
      background: s.background?.length ? s.background : undefined,
      active: this.busy,
      projectPath: this.projectPath,
    });
    saveConfigSoon();
  }

  // ---- UI requests (permissions, extension dialogs, questions) ----

  private uiWaiters = new Map<string, (r: UiResponse) => void>();

  askUi(req: UiRequest, timeoutMs?: number): Promise<UiResponse> {
    this.setState({ pendingUi: [...this.t.state.pendingUi, req] });
    const tool = req.tool ? `${req.tool.name}${commandOf(req.tool.input) ? `: ${commandOf(req.tool.input)}` : ""}` : "";
    this.alert(
      "question",
      req.kind === "permission" ? "Approval needed" : "Question",
      req.questions?.[0]?.question ?? (req.kind === "permission" ? `Allow ${tool || req.title}?` : [req.title, req.message].filter(Boolean).join(": ")),
    );
    return new Promise((resolve) => {
      const done = (r: UiResponse) => {
        this.uiWaiters.delete(req.id);
        this.setState({ pendingUi: this.t.state.pendingUi.filter((u) => u.id !== req.id) });
        resolve(r);
      };
      this.uiWaiters.set(req.id, done);
      if (timeoutMs) setTimeout(() => this.uiWaiters.has(req.id) && done({ id: req.id, cancelled: true }), timeoutMs);
    });
  }

  uiRespond(r: UiResponse) {
    this.uiWaiters.get(r.id)?.(r);
  }

  cancelAllUi() {
    for (const [id, done] of this.uiWaiters) done({ id, cancelled: true });
  }

  // ---- model chain & fallback ----

  get chain(): string[] | undefined {
    const c = this.t.state.chain;
    return c && c.length ? c : undefined;
  }

  get currentEntry(): ChainEntry {
    return { harness: this.harness, model: this.t.state.model ?? "default" };
  }

  private sameEntry(a: ChainEntry, b: ChainEntry) {
    return a.harness === b.harness && a.model === b.model;
  }

  /**
   * Before a new user turn: go back to the earliest available chain entry. Returns true when the
   * conversation was handed off to another harness (the prompt went with it).
   */
  protected async preferBest(pendingPrompt: string): Promise<boolean> {
    await this.checkpoint(pendingPrompt);
    const chain = this.chain;
    if (!chain || this.t.state.preferEarlier === false) return false;
    const pick = pickEntry(chain, this.harness);
    if (!("entry" in pick) || this.sameEntry(pick.entry, this.currentEntry)) return false;
    // Only move *up* the chain here; never sideways to an entry after the current one.
    const idx = (e: ChainEntry) => chain.findIndex((c) => this.sameEntry(parseEntry(c, this.harness), e));
    const cur = idx(this.currentEntry);
    if (cur >= 0 && idx(pick.entry) > cur) return false;
    if (pick.entry.harness === this.harness) {
      await this.applyModel(pick.entry.model);
      this.notice(`Back on ${pick.entry.model}: its usage limit has reset.`);
      return false;
    }
    await this.sink.handoff(this, pick.entry, `${formatEntry(pick.entry)} is available again`, pendingPrompt);
    return true;
  }

  /**
   * Called by an adapter when a turn ended in an error. Returns true when fallback took over
   * (the adapter must not report the session idle-with-error then).
   */
  protected async handleTurnError(errorText: string | undefined, status?: number | null, hint?: Classified): Promise<boolean> {
    const chain = this.chain;
    if (!chain) return false;
    const c = hint ?? classify(errorText, status);
    if (c.kind === "other") return false;
    const current = this.currentEntry;

    if (c.kind === "quota") {
      const key = providerOf(current.model, current.harness);
      const until = markExhausted(key, c.resetAt);
      this.notice(`Usage limit reached on ${key} (resets ${fmtTime(until)}).`, "warning");
    }
    const pick = pickEntry(chain, this.harness);
    if ("waitUntil" in pick) {
      this.alert("blocked", "Waiting on usage limits", `Every model in the chain is at its limit; it continues at ${fmtTime(pick.waitUntil)}.`);
      this.waitThenContinue(pick.waitUntil, "Every model in this session's chain is at its usage limit");
      return true;
    }
    if (!this.sameEntry(pick.entry, current)) {
      this.fallbackAttempt = 0;
      if (pick.entry.harness !== this.harness) {
        await this.sink.handoff(this, pick.entry, c.kind === "quota" ? `${current.harness} (${current.model}) hit its usage limit` : `${current.harness} is rate limited`);
        return true;
      }
      await this.applyModel(pick.entry.model);
      this.notice(`Switched to ${pick.entry.model}.`);
      await this.continueTurn();
      return true;
    }
    // Same entry (rate limited, or nothing better available): back off and retry, indefinitely.
    const delay = c.resetAt ? Math.max(5_000, c.resetAt - Date.now()) : backoffMs(this.fallbackAttempt++);
    this.waitThenContinue(Date.now() + delay, c.kind === "rate_limit" ? `Rate limited on ${current.model}` : `Waiting on ${current.model}`);
    return true;
  }

  private waitThenContinue(until: number, reason: string) {
    clearTimeout(this.waitTimer);
    this.setState({ status: "waiting", waitingReason: reason, waitingUntil: until });
    this.waitTimer = setTimeout(async () => {
      this.waitTimer = undefined;
      if (this.closed || this.t.state.status !== "waiting") return;
      const chain = this.chain;
      if (chain) {
        const pick = pickEntry(chain, this.harness);
        if ("waitUntil" in pick) return this.waitThenContinue(pick.waitUntil, reason);
        if (pick.entry.harness !== this.harness) {
          this.setState({ waitingReason: undefined, waitingUntil: undefined });
          return this.sink.handoff(this, pick.entry, `${formatEntry(pick.entry)} has reset`);
        }
        if (pick.entry.model !== this.t.state.model) {
          await this.applyModel(pick.entry.model);
          this.notice(`Switched to ${pick.entry.model}.`);
        }
      }
      this.setState({ waitingReason: undefined, waitingUntil: undefined });
      await this.continueTurn();
    }, Math.max(1_000, until - Date.now()));
  }

  /** Clears fallback state after a successful turn. */
  protected turnSucceeded() {
    this.fallbackAttempt = 0;
  }

  protected cancelWait(): boolean {
    if (!this.waitTimer) return false;
    clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
    this.setState({ status: "idle", waitingReason: undefined, waitingUntil: undefined });
    return true;
  }

  /** Picks a profile (copied into this session's chain) or a single model (clears the chain). */
  async setModelOrProfile(model?: string, profileName?: string) {
    if (profileName) {
      const p = profile(profileName);
      if (!p) throw new Error(`No model profile "${profileName}"`);
      await this.setChain([...p.chain], undefined, p.name);
    } else if (model) {
      this.setState({ profile: undefined, chain: undefined });
      await this.applyModel(model);
    }
  }

  /** Sets this session's own fallback order. The first entry for this harness becomes current. */
  async setChain(chain: string[], preferEarlier?: boolean, profileName?: string) {
    this.setState({ chain, profile: profileName, ...(preferEarlier !== undefined ? { preferEarlier } : {}) });
    const pick = pickEntry(chain, this.harness);
    if ("entry" in pick && pick.entry.harness === this.harness && pick.entry.model !== this.t.state.model) await this.applyModel(pick.entry.model);
  }

  // ---- guard: who approves tool calls ----

  private pendingVerdicts = new Map<string, GuardVerdict>();
  private guardKey: string;
  /** Env for agent processes whose gate calls back into the guard (pi extension, agy hook). */
  get guardEnv() {
    return guardEnv(this.guardKey);
  }
  private approved = new Set<string>();

  get guardMode(): GuardMode {
    return this.t.state.guard ?? config().guard?.defaultMode ?? "auto";
  }

  /** What the user asked for, for the judge: the first request and the latest ones. */
  goal(): string {
    const asks = this.t.messages
      .filter((m) => m.role === "user")
      .map((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join(" ").trim())
      .filter((t) => t && !t.startsWith("You are taking over"));
    const pick = asks.length > 4 ? [asks[0]!, "…", ...asks.slice(-3)] : asks;
    return pick.map((t) => t.slice(0, 1500)).join("\n---\n");
  }

  /**
   * Decides one tool call. Adapters call this from their permission hook (Claude Code canUseTool,
   * ACP request_permission, the Antigravity PreToolUse bridge) and turn the answer into the
   * harness's own allow/deny.
   */
  async checkTool(tool: string, input: unknown, toolId?: string): Promise<{ allow: boolean; reason?: string; always?: boolean }> {
    const call = { tool, input, cwd: this.projectPath };
    const key = JSON.stringify([tool, input]);
    let v: Verdict;
    let always = false;
    if (this.approved.has(key)) v = { decision: "allow", by: "user", reason: "Approved after it was blocked." };
    else if (this.guardMode === "full") v = { decision: "allow", by: "mode", reason: "Full access." };
    else {
      const r = rules(call);
      const askEdit = this.guardMode === "ask" && r?.decision === "allow" && kindOf(tool) === "edit";
      if (r?.decision === "allow" && !askEdit) v = r;
      else if (this.guardMode === "ask" || this.guardMode === "edits") {
        const res = await this.askUi({
          id: newId("perm"),
          kind: "permission",
          title: `Allow ${tool}?`,
          message: r?.decision === "deny" ? `⚠ ${r.reason}` : undefined,
          tool: { name: tool, input },
        });
        v = res.allow ? { decision: "allow", by: "user", reason: "You allowed it." } : { decision: "deny", by: "user", reason: res.value || "You denied it." };
        always = !!res.always;
      } else if (r?.decision === "deny") v = r;
      else {
        this.setState({ statuses: { ...this.t.state.statuses, guard: `judging ${tool}…` } });
        v = await judge(call, this.goal());
        const statuses = { ...this.t.state.statuses };
        delete statuses.guard;
        this.setState({ statuses });
      }
    }
    const verdict: GuardVerdict = { decision: v.decision === "allow" ? "allow" : "deny", by: v.by, reason: v.reason };
    if (verdict.decision === "deny" && verdict.by !== "user")
      this.alert("blocked", "Guard blocked a call", `${commandOf(input) ?? tool}: ${(v.reason ?? "").replace(/^Blocked:\s*/, "")} (Approve & retry in the session)`);
    this.annotate(tool, toolId, verdict);
    return { allow: verdict.decision === "allow", reason: v.reason, always };
  }

  private annotate(tool: string, toolId: string | undefined, guard: GuardVerdict) {
    for (let i = this.t.messages.length - 1; i >= 0; i--) {
      const m = this.t.messages[i]!;
      const p = m.parts.find((x): x is Extract<Part, { type: "tool" }> => x.type === "tool" && (toolId ? x.id === toolId : x.name === tool && x.status === "running" && !x.guard));
      if (p) return this.emit({ type: "tool", msgId: m.id, toolId: p.id, patch: { guard } });
    }
    if (toolId) this.pendingVerdicts.set(toolId, guard);
  }

  /** "Approve & retry" on a blocked call: allow that exact call from now on and tell the agent. */
  async approveBlocked(toolId: string) {
    for (const m of this.t.messages)
      for (const p of m.parts)
        if (p.type === "tool" && p.id === toolId) {
          this.approved.add(JSON.stringify([p.name, p.input]));
          this.emit({ type: "tool", msgId: m.id, toolId, patch: { guard: { decision: "allow", by: "user", reason: "Approved after it was blocked." } } });
          const what = commandOf(p.input) ?? JSON.stringify(p.input).slice(0, 300);
          const text = `The user approved your earlier blocked ${p.name} call (${what}). Run it now if it is still needed, then continue.`;
          if (this.t.state.status === "running" && this.steer) this.pend(text, "steer", { now: true });
          else if (this.t.state.status === "running") this.pend(text, "followUp");
          else await this.continueTurn(text);
          return;
        }
    throw new Error("Tool call not found");
  }

  setGuard(mode: GuardMode) {
    this.setState({ guard: mode });
    this.onGuardChanged?.();
  }
  /** Adapters whose harness needs restarting or reconfiguring on a guard change. */
  protected onGuardChanged?: () => void;

  // ---- checkpoints ----

  async checkpoint(label: string) {
    try {
      const list = this.t.state.checkpoints ?? [];
      const n = list.length;
      const ref = `refs/tether/checkpoints/${this.harness}-${this.nativeId.replace(/[^\w.-]/g, "_")}/${n}`;
      const prev = list[n - 1]?.sha;
      const sha = await snapshot(this.projectPath, ref, label, prev);
      if (!sha) return;
      if (!this.diffBaseSha) {
        this.diffBaseSha = list[0]?.sha ?? sha;
        this.savePrefs();
      }
      if (sha === prev) return;
      const cp: Checkpoint = { id: newId("c"), sha, ts: Date.now(), label: label.replace(/\s+/g, " ").slice(0, 120) };
      this.setState({ checkpoints: [...list, cp].slice(-50) });
    } catch (e: any) {
      console.error(`checkpoint failed for ${this.id}: ${e?.message ?? e}`);
    }
  }

  get diffBase() {
    return this.diffBaseSha;
  }

  inheritDiffBase(sha?: string) {
    if (!sha || this.diffBaseSha) return;
    this.diffBaseSha = sha;
    this.savePrefs();
  }

  async restoreCheckpoint(id: string) {
    if (this.t.state.status !== "idle") throw new Error("Stop the agent before restoring a checkpoint.");
    const cp = this.t.state.checkpoints?.find((c) => c.id === id);
    if (!cp) throw new Error("Checkpoint not found");
    await this.checkpoint(`before restoring "${cp.label}"`);
    const r = await restoreTree(this.projectPath, cp.sha);
    this.notice(`Restored the files to how they were before "${cp.label}" (${r.removed} new files removed). The state just before the restore was saved as a checkpoint too.`, "warning");
  }

  // ---- housekeeping ----

  private checkStall() {
    const s = this.t.state;
    if (s.status !== "running" || s.pendingUi.length || this.stallWarned) return;
    if (Date.now() - this.lastActivity > STALL_WARN_MS) {
      this.stallWarned = true;
      this.notice(`No activity for ${Math.round(STALL_WARN_MS / 60_000)} minutes. A tool may be stuck; Stop and send "continue" if it doesn't recover.`, "warning");
      this.alert("blocked", "No activity", `Nothing for ${Math.round(STALL_WARN_MS / 60_000)} minutes; a tool may be stuck.`);
    }
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    if (this.t.state.status !== "idle" || this.t.state.pendingUi.length) return;
    this.idleTimer = setTimeout(() => {
      if (this.t.state.status === "idle" && this.t.state.pendingUi.length === 0) this.close();
    }, IDLE_CLOSE_MS);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.waitTimer);
    clearTimeout(this.steerTimer);
    clearTimeout(this.idleTimer);
    clearInterval(this.watchdog);
    unregisterGuard(this.guardKey);
    this.cancelAllUi();
    this.shutdown();
    this.sink.summary(this.summary());
    this.onClose?.();
  }

  // ---- adapter API ----
  abstract start(): Promise<void>;
  /**
   * Starts a turn with this message (the session is idle, or a turn just ended): fallback via
   * preferBest(), the user message in the transcript (unless the harness echoes it), the turn.
   */
  protected abstract send(text: string): Promise<void>;
  /** Folds a message into the running turn; false when the harness can't take it now. Absent: no steering. */
  protected steer?(text: string): Promise<boolean>;
  /** The harness puts user messages into the transcript itself (pi). */
  protected echoesUserMessages = false;
  abstract abort(): Promise<void>;
  /** Sets the model on the harness and records it in state. */
  abstract applyModel(model: string): Promise<void>;
  abstract setThinking(level: string): Promise<void>;
  abstract setPermissionMode(mode: string): Promise<void>;
  abstract rename(title: string): Promise<void>;
  abstract listCommands(): Promise<{ name: string; description?: string }[]>;
  /** Resumes after a fallback switch, a wait, or a runner restart. */
  abstract continueTurn(text?: string): Promise<void>;
  protected abstract shutdown(): void;
}

/** How many messages from the top start the next turn: the steers at the top, else one queued message. */
export function nextTurnSize(list: PendingMessage[]): number {
  let n = 0;
  while (n < list.length && list[n]!.mode === "steer") n++;
  return n || (list.length ? 1 : 0);
}
const joinPending = (list: PendingMessage[]) => list.map((p) => p.text).join("\n\n");
const quote = (t: string) => t.trim().split("\n").map((l) => `> ${l}`).join("\n");

export function fmtTime(ms: number) {
  const d = new Date(ms);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toTimeString().slice(0, 5) : d.toISOString().slice(0, 16).replace("T", " ");
}
