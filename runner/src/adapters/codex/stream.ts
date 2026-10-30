// The daemon's notifications for one thread family as transcript events (SPEC §5, §6a): the main
// thread Tether drives, and its subagents, which are threads of their own (parentThreadId) whose
// events arrive on the same connection. Pure apart from the sinks it reports to, so recorded daemon
// streams replay through it in tests (fixtures/*.jsonl).
//
// Whoever starts a turn (Tether, Codex's own TUI on the same thread, a steer from either), its
// items arrive here the same way, so the transcript shows them all. Message ids match items.ts's
// stored transcript: `u-<item>` for user messages, `a-<first shown item>` for the assistant's.

import { randomUUID } from "node:crypto";
import type { Msg, Part, ToolPart } from "../../../../shared/transcript";
import type { Sink, SubagentStart } from "../../core/adapter";
import { agentName, compactionNotice, itemPart, pathLeaf, shown, turnError, userMsg } from "./items";

/** Shell output kept per tool card while streaming (the stored output is whole). */
const OUTPUT_MAX = 100_000;

interface ThreadView {
  id: string;
  sink: Sink;
  /** the running turn */
  turnId?: string;
  /** the assistant message being written */
  msg?: Msg;
  /** this turn's messages (the transcript may not be loaded: the stream keeps its own copy) */
  msgs: Map<string, Msg>;
  /** item id -> where its part is */
  parts: Map<string, { msgId: string; idx: number; delta?: "summary" | "content" }>;
  /** fileChange items by id: an approval request carries only the id */
  patches: Map<string, any>;
  /** a subagent: the spawn call in its parent, and whether it runs */
  parentToolId?: string;
  running?: boolean;
}

const firstLine = (s: string, n = 80) => s.trim().split("\n")[0]!.slice(0, n);

export class CodexStream {
  readonly main: ThreadView;
  private children = new Map<string, ThreadView>();
  /** subagent threads seen before their spawn call said whose they are: their events wait */
  private early = new Map<string, [string, any][]>();
  /** what thread/started said about subagent threads */
  private info = new Map<string, { parent?: string; name?: string; role?: string }>();
  /** subagent thread -> its spawn call (the parent's tool part) */
  private spawns = new Map<string, { toolId: string; parent: string; prompt?: string }>();

  constructor(
    sink: Sink,
    private cwd: string,
    threadId: string,
  ) {
    this.main = this.view(threadId, sink);
  }

  private view(id: string, sink: Sink): ThreadView {
    return { id, sink, msgs: new Map(), parts: new Map(), patches: new Map() };
  }

  get threadId() {
    return this.main.id;
  }

  /** The thread a notification is about: the main one, a known subagent, or none (yet). */
  private viewOf(threadId: string | undefined): ThreadView | undefined {
    if (!threadId || threadId === this.main.id) return this.main;
    return this.children.get(threadId);
  }

  /** A subagent's view (by its thread id). */
  child(threadId: string): ThreadView | undefined {
    return this.children.get(threadId);
  }

  /** Every subagent thread this stream has opened. */
  childIds(): string[] {
    return [...this.children.keys()];
  }

  /**
   * A subagent as resume found it (its spawn was in the turn seedTurn replayed): its running turn
   * so far, so stop and steer reach it; with no turn running, it has ended.
   */
  seedChildTurn(threadId: string, turn: any | undefined) {
    const v = this.children.get(threadId);
    if (!v) return;
    if (!turn || turn.status !== "inProgress") {
      if (v.running) {
        v.running = false;
        v.sink.ended?.();
      }
      return;
    }
    this.turnStarted(v, turn);
    for (const item of turn.items ?? []) {
      this.itemStarted(v, item);
      if (item.type !== "userMessage" && (item.status !== "inProgress" || item.type === "agentMessage" || item.type === "reasoning")) this.itemCompleted(v, item);
    }
  }

  /** Subagents with a turn running. */
  runningChildren(): ThreadView[] {
    return [...this.children.values()].filter((c) => c.running);
  }

  /** The fileChange item an approval is about. */
  patch(threadId: string, itemId: string) {
    return this.viewOf(threadId)?.patches.get(itemId);
  }

  handle(method: string, p: any) {
    if (method === "thread/started") return this.threadStarted(p.thread);
    const threadId: string | undefined = p?.threadId;
    const v = this.viewOf(threadId);
    if (!v) {
      // A subagent we can't place yet (its spawn call hasn't said): kept until it does.
      if (threadId && (this.info.has(threadId) || this.early.size < 50)) {
        const list = this.early.get(threadId) ?? [];
        if (list.length < 2000) list.push([method, p]);
        this.early.set(threadId, list);
      }
      return;
    }
    switch (method) {
      case "turn/started":
        return this.turnStarted(v, p.turn);
      case "turn/completed":
        return this.turnCompleted(v, p.turn);
      case "thread/status/changed":
        return this.status(v, p.status);
      case "item/started":
        return this.itemStarted(v, p.item);
      case "item/completed":
        return this.itemCompleted(v, p.item);
      case "item/agentMessage/delta":
      case "item/plan/delta":
        return this.textDelta(v, p.itemId, "text", p.delta);
      case "item/reasoning/summaryTextDelta":
        return this.textDelta(v, p.itemId, "thinking", p.delta, "summary");
      case "item/reasoning/summaryPartAdded":
        if (p.summaryIndex > 0) this.textDelta(v, p.itemId, "thinking", "\n\n", "summary");
        return;
      case "item/reasoning/textDelta":
        return this.textDelta(v, p.itemId, "thinking", p.delta, "content");
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        return this.output(v, p.itemId, p.delta);
      case "thread/settings/updated":
        return v === this.main ? this.onSettings?.(p.threadSettings ?? {}) : undefined;
      case "model/rerouted":
        if (v === this.main) this.notice(v, `Codex moved this turn from ${p.fromModel} to ${p.toModel}.`);
        return;
      case "error":
        // A failed request Codex retries by itself: said once, inline.
        if (p.willRetry && v === this.main && p.error?.message) this.state(v, { error: `Retrying: ${p.error.message}` });
        return;
    }
  }

  /** Thread settings changed (by Tether, or in Codex's own TUI): the driver reads them. */
  onSettings?: (settings: any) => void;
  /** A subagent was spawned (its thread and the call that spawned it): the driver remembers it. */
  onSpawn?: (threadId: string, toolId: string) => void;

  /**
   * A subagent found running when joining the thread (a runner restart): opened as if its spawn had
   * just been seen, under the call that spawned it when that's remembered.
   */
  adoptChild(threadId: string, toolId: string | undefined, name?: string) {
    if (this.children.has(threadId)) return;
    this.spawns.set(threadId, { toolId: toolId ?? threadId, parent: this.main.id });
    if (name) this.info.set(threadId, { ...this.info.get(threadId), name });
    this.openChild(threadId);
  }

  // ---------------- turns ----------------

  private turnStarted(v: ThreadView, turn: any) {
    v.turnId = turn?.id;
    v.msg = undefined;
    v.msgs.clear();
    v.parts.clear();
    if (v === this.main) this.state(v, { status: "running", error: undefined });
    else this.childRunning(v);
  }

  private turnCompleted(v: ThreadView, turn: any) {
    if (turn?.id && v.turnId && turn.id !== v.turnId) return;
    const error = turnError(turn);
    // Calls the turn left running (it was stopped) are over.
    for (const id of [...v.msgs.keys()]) {
      const m = this.cur(v, id)!;
      const parts = m.parts.map((x) => (x.type === "tool" && x.status === "running" ? { ...x, status: "error" as const } : x));
      const changed = parts.some((x, i) => x !== m.parts[i]);
      const last = error && m.id === v.msg?.id;
      if (m.streaming || changed || last) this.put(v, { ...m, parts, streaming: false, ...(last ? { error } : {}) });
    }
    if (error && !v.msg) this.put(v, { id: `e-${turn.id}`, role: "assistant", ts: Date.now(), parts: [], error });
    v.turnId = undefined;
    v.msg = undefined;
    if (v === this.main) this.state(v, { status: "idle", ...(error ? {} : { error: undefined }) });
    else if (v.running) {
      v.running = false;
      v.sink.ended?.();
    }
  }

  private status(v: ThreadView, st: any) {
    if (v !== this.main || !v.turnId) return;
    const flags: string[] = st?.activeFlags ?? [];
    if (st?.type === "active") this.state(v, { status: flags.some((f) => /^waitingOn/.test(f)) ? "waiting" : "running" });
  }

  private state(v: ThreadView, patch: Parameters<Sink["state"]>[0]) {
    v.sink.state(patch);
  }

  /**
   * The running turn as resume found it (the thread was mid-turn, e.g. driven from Codex's TUI):
   * its items so far go into the transcript, and the stream carries on from them.
   */
  seedTurn(turn: any) {
    const v = this.main;
    this.turnStarted(v, turn);
    for (const item of turn?.items ?? []) {
      this.itemStarted(v, item);
      if (item.type !== "userMessage" && item.status !== "inProgress") this.itemCompleted(v, item);
      else if (item.type === "agentMessage" || item.type === "reasoning") this.itemCompleted(v, item);
    }
  }

  // ---------------- items ----------------

  private itemStarted(v: ThreadView, item: any) {
    if (!item?.id) return;
    switch (item.type) {
      case "userMessage": {
        const u = userMsg(item, Date.now());
        if (u) this.put(v, u);
        // What follows is a new assistant message.
        this.endMsg(v);
        return;
      }
      case "contextCompaction":
        this.put(v, compactionNotice(item.id, Date.now()));
        this.endMsg(v);
        return;
      case "fileChange":
        v.patches.set(item.id, item);
        break;
    }
    const part = itemPart(item, this.cwd);
    // Text and thinking get their part from their first delta: many stay empty.
    if (part && (part.type === "tool" || shown(part))) this.addPart(v, item.id, part);
    // After its card is in the transcript, so the core can link the card to the child session.
    this.spawned(v, item);
  }

  private itemCompleted(v: ThreadView, item: any) {
    if (!item?.id) return;
    if (item.type === "userMessage") {
      const u = userMsg(item, Date.now());
      if (u && !v.msgs.has(u.id)) this.put(v, u);
      return;
    }
    if (item.type === "contextCompaction") return;
    if (item.type === "fileChange") v.patches.delete(item.id);
    const part = itemPart(item, this.cwd);
    if (part && (shown(part) || v.parts.has(item.id))) this.setPart(v, item.id, part);
    this.spawned(v, item);
    this.reports(item);
  }

  /** A subagent's spawn call: its threads become child sessions. */
  private spawned(v: ThreadView, item: any) {
    if (item.type === "subAgentActivity" && item.kind === "started" && item.agentThreadId) {
      const child: string = item.agentThreadId;
      if (this.spawns.has(child)) return;
      const name = pathLeaf(item.agentPath);
      this.spawns.set(child, { toolId: item.id, parent: v.id });
      this.onSpawn?.(child, item.id);
      if (name) this.info.set(child, { ...this.info.get(child), name });
      return this.openChild(child);
    }
    if (item.type !== "collabAgentToolCall" || item.tool !== "spawnAgent") return;
    for (const child of item.receiverThreadIds ?? []) {
      if (this.spawns.has(child)) continue;
      this.spawns.set(child, { toolId: item.id, parent: v.id, ...(item.prompt ? { prompt: item.prompt } : {}) });
      this.onSpawn?.(child, item.id);
      this.openChild(child);
    }
  }

  /** A wait (or any agents call) that carries a subagent's final report: shown on its spawn card. */
  private reports(item: any) {
    if (item.type !== "collabAgentToolCall") return;
    for (const [child, st] of Object.entries<any>(item.agentsStates ?? {})) {
      const sp = this.spawns.get(child);
      if (!sp || !st?.message || sp.toolId === item.id) continue;
      const owner = this.viewOf(sp.parent);
      if (owner) this.patchTool(owner, sp.toolId, { output: st.message });
    }
  }

  private threadStarted(t: any) {
    const parent = t?.parentThreadId ?? t?.source?.subAgent?.thread_spawn?.parent_thread_id;
    if (!t?.id || !parent || t.id === this.main.id) return;
    this.info.set(t.id, { parent, name: agentName(t), role: t.agentRole ?? t?.source?.subAgent?.thread_spawn?.agent_role ?? undefined });
  }

  private openChild(threadId: string) {
    const sp = this.spawns.get(threadId);
    const owner = sp ? this.viewOf(sp.parent) : undefined;
    if (!sp || !owner) return;
    const info = this.info.get(threadId);
    const start: SubagentStart = {
      nativeId: threadId,
      parentToolId: sp.toolId,
      title: info?.name ?? (sp.prompt ? firstLine(sp.prompt) : "Subagent"),
      ...(info?.role ? { agentType: info.role } : {}),
    };
    const v = this.view(threadId, owner.sink.subagent(start));
    v.parentToolId = sp.toolId;
    v.running = true;
    this.children.set(threadId, v);
    // What arrived before we knew whose it is.
    const early = this.early.get(threadId) ?? [];
    this.early.delete(threadId);
    for (const [m, p] of early) this.handle(m, p);
  }

  /** A subagent's turn started: it runs again (it may take more input after its first task). */
  private childRunning(v: ThreadView) {
    if (v.running) return;
    const sp = this.spawns.get(v.id);
    const owner = sp ? this.viewOf(sp.parent) : undefined;
    if (!sp || !owner) return;
    const info = this.info.get(v.id);
    v.sink = owner.sink.subagent({ nativeId: v.id, parentToolId: sp.toolId, title: info?.name ?? (sp.prompt ? firstLine(sp.prompt) : "Subagent"), ...(info?.role ? { agentType: info.role } : {}) });
    v.running = true;
  }

  // ---------------- parts ----------------

  /** The assistant message being written is done (a user message or a compaction follows). */
  private endMsg(v: ThreadView) {
    const m = v.msg && this.cur(v, v.msg.id);
    v.msg = undefined;
    if (m?.streaming) this.put(v, { ...m, streaming: false });
  }

  /** A message as it is now: the transcript's copy (the core patches it too), else the stream's. */
  private cur(v: ThreadView, id: string): Msg | undefined {
    return v.sink.message(id) ?? v.msgs.get(id);
  }

  private put(v: ThreadView, m: Msg) {
    v.msgs.set(m.id, m);
    if (v.msg?.id === m.id) v.msg = m;
    v.sink.event({ type: "msg", msg: m });
  }

  private addPart(v: ThreadView, itemId: string, part: Part): void {
    if (v.parts.has(itemId)) return this.setPart(v, itemId, part);
    const m: Msg = (v.msg && this.cur(v, v.msg.id)) ?? { id: `a-${itemId}`, role: "assistant", ts: Date.now(), parts: [], streaming: true };
    v.msg = m;
    v.parts.set(itemId, { msgId: m.id, idx: m.parts.length });
    this.put(v, { ...m, parts: [...m.parts, part], streaming: true });
  }

  private setPart(v: ThreadView, itemId: string, part: Part): void {
    const at = v.parts.get(itemId);
    const m = at && this.cur(v, at.msgId);
    if (!at || !m) return this.addPart(v, itemId, part);
    const old = m.parts[at.idx];
    // The streamed output (or a subagent's report) stays when the final item has none; the link
    // to a subagent's session stays too.
    if (part.type === "tool" && old?.type === "tool") {
      if (!part.output && old.output) part = { ...part, output: old.output };
      if (old.childSessionId) part = { ...part, childSessionId: old.childSessionId };
    }
    const parts = [...m.parts];
    parts[at.idx] = part;
    this.put(v, { ...m, parts });
  }

  private textDelta(v: ThreadView, itemId: string, kind: "text" | "thinking", text: string, source?: "summary" | "content") {
    if (!text) return;
    let at = v.parts.get(itemId);
    if (!at) {
      this.addPart(v, itemId, { type: kind, text: "" });
      at = v.parts.get(itemId)!;
    }
    // Reasoning can stream a summary and raw content: whichever comes first shows.
    if (source) {
      at.delta ??= source;
      if (at.delta !== source) return;
    }
    const m = this.cur(v, at.msgId);
    const p = m?.parts[at.idx];
    if (!m || !p || (p.type !== "text" && p.type !== "thinking")) return;
    const parts = [...m.parts];
    parts[at.idx] = { ...p, text: p.text + text };
    v.msgs.set(m.id, { ...m, parts });
    if (v.msg?.id === m.id) v.msg = v.msgs.get(m.id);
    v.sink.event({ type: "delta", msgId: m.id, part: at.idx, text });
  }

  private output(v: ThreadView, itemId: string, delta: string) {
    const at = v.parts.get(itemId);
    const p = at && this.cur(v, at.msgId)?.parts[at.idx];
    if (p?.type !== "tool" || !delta) return;
    this.patchTool(v, itemId, { output: ((p.output ?? "") + delta).slice(-OUTPUT_MAX) });
  }

  private patchTool(v: ThreadView, toolId: string, patch: Partial<ToolPart>) {
    const at = v.parts.get(toolId);
    const m = at && this.cur(v, at.msgId);
    const p = m?.parts[at!.idx];
    if (!m || p?.type !== "tool") return;
    const parts = [...m.parts];
    parts[at!.idx] = { ...p, ...patch };
    v.msgs.set(m.id, { ...m, parts });
    if (v.msg?.id === m.id) v.msg = v.msgs.get(m.id);
    v.sink.event({ type: "tool", msgId: m.id, toolId, patch });
  }

  /** One of Tether's notices (it isn't in Codex's store; the core keeps it). */
  notice(v: ThreadView, text: string, level: Msg["level"] = "info") {
    v.sink.event({ type: "msg", msg: { id: `n-${randomUUID()}`, role: "notice", level, ts: Date.now(), parts: [{ type: "text", text }] } });
  }
}
