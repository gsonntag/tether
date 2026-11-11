// Sessions talking to each other (SPEC §9a). Every agent gets Tether's MCP server (mcp.ts) with four
// tools: list the other sessions, send one a message, ask one and wait for its answer, and send a
// note to all. A message goes through the target's queue like any other (core/queue.ts): it never
// steers, waits for a running turn, obeys holds and survives restarts; it starts with a marker
// (shared/fromTether.ts) so the transcript shows who wrote it. Nothing asks the person; loops are
// capped instead (caps.ts).
//
// The same server carries text_person (the texting module texts the person for the session, through
// homeLine.ts), and with it Tether's instructions for every session it runs (instructions.ts: concise
// replies, texting only through text_person) and TETHER_SESSION in its shell, so textme refuses.

import { join } from "node:path";
import { markTitle, parseSessionMessage, peerHops, sessionMessage } from "../../../../shared/fromTether";
import { MESSAGE_TEXT_MAX } from "../../../../shared/limits";
import { matching, PEER_SERVER, PEER_TOOLS, reachable, statusWord, TEXT_PERSON } from "../../../../shared/peers";
import { runnerSettings } from "../../core/runnerSettings";
import { SESSION_ENV, sessionInstructions } from "./instructions";
import { AGENT_NAMES, HARNESS_LABELS, type HarnessId, type Msg, type SessionSummary } from "../../../../shared/transcript";
import { LEVELS, type Level } from "../../../../shared/move";
import { LEVEL_WORDS, levelOf } from "../../core/permissionLevel";
import type { Module, ModuleContext, SessionLook } from "..";
import { BROADCAST_MAX, PeerCaps } from "./caps";
import { peerSecret, peerToken, PeerSocket, type PeerAnswer, type PeerCall } from "./server";
import { ASK_DEFAULT_MIN, ASK_MAX_MIN } from "./tools";

/** How much of an answer an ask returns. */
export const ANSWER_MAX = 20_000;

const folderOf = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const ago = (t: number, now: number) => {
  const m = Math.round((now - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const textOf = (m: Msg) =>
  m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();

/**
 * The answer to a question from `asker` in a transcript: the last assistant text after the newest
 * message from it, cut at ANSWER_MAX.
 */
export function answerIn(msgs: Msg[], asker: string, target: string): string | undefined {
  let from = msgs.length - 1;
  while (from >= 0 && !(msgs[from]!.role === "user" && msgs[from]!.origin?.sessionId === asker)) from--;
  let answer: string | undefined;
  for (let i = from + 1; i < msgs.length; i++) if (msgs[i]!.role === "assistant" && textOf(msgs[i]!)) answer = textOf(msgs[i]!);
  if (answer === undefined) return undefined;
  return answer.length > ANSWER_MAX ? `${answer.slice(0, ANSWER_MAX)}\n… (truncated: open session ${target} for the rest)` : answer;
}

/** A question waiting for its answer. */
interface Ask {
  from: string;
  to: string;
  msgId: string;
  /** it went out to the target: its next turn end is the answer */
  delivered: boolean;
  done: (a: PeerAnswer) => void;
}

export class Peers {
  readonly caps: PeerCaps;
  private asks: Ask[] = [];

  constructor(
    private ctx: Pick<ModuleContext, "sessions" | "session" | "log" | "homeFolder" | "homeLine">,
    now: () => number = Date.now,
  ) {
    this.caps = new PeerCaps(now);
    this.now = now;
  }
  private now: () => number;

  // ---------------- events ----------------

  /**
   * A message left a queue (core event queueGone). One from another session starts a turn with the
   * hops its hint carries (so a message queued before a restart keeps them).
   */
  queueGone(sessionId: string, msgId: string, how: "sent" | "cancelled", text = "") {
    const peer = parseSessionMessage(text);
    if (peer && how === "sent") this.caps.turnFrom(sessionId, { hops: peerHops(text) ?? 1, ...(peer.all ? { broadcast: true } : {}) });
    const ask = this.asks.find((a) => a.msgId === msgId);
    if (!ask) return;
    if (how === "sent") ask.delivered = true;
    else this.finish(ask, { text: `Not delivered: the person removed your question from ${this.name(ask.to)}'s queue.`, isError: true });
  }

  /** A message in a transcript: one the person (or Tether) sent starts a fresh chain. */
  message(sessionId: string, msg: Msg) {
    if (msg.role !== "user" || msg.origin?.kind === "session") return;
    if (msg.origin && msg.origin.kind !== "tether" && msg.origin.kind !== "shell") return;
    this.caps.turnFrom(sessionId);
  }

  /** A turn ended: the oldest delivered question to that session has its answer. */
  async turnEnded(sessionId: string, error?: string, stopped?: boolean) {
    // Whatever starts its next turn says where that one comes from.
    this.caps.turnFrom(sessionId);
    const ask = this.asks.find((a) => a.to === sessionId && a.delivered);
    if (!ask) return;
    if (stopped) return this.finish(ask, { text: `The person stopped ${this.who(sessionId)}'s turn before it answered.`, isError: true });
    if (error) return this.finish(ask, { text: `${this.who(sessionId)}'s turn failed: ${error}`, isError: true });
    const msgs = await this.ctx.sessions.recent(sessionId, 60).catch(() => [] as Msg[]);
    const answer = answerIn(msgs, ask.from, sessionId);
    this.finish(ask, answer ? { text: `${this.who(sessionId)} answered:\n\n${answer}` } : { text: `${this.who(sessionId)} ended its turn without a written answer.` });
  }

  private finish(ask: Ask, a: PeerAnswer) {
    this.asks = this.asks.filter((x) => x !== ask);
    ask.done(a);
  }

  // ---------------- tools ----------------

  async call(c: PeerCall): Promise<PeerAnswer> {
    const from = this.root(c.from);
    const a = c.args;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    switch (c.tool) {
      case PEER_TOOLS.sessions:
        return { text: await this.list(from, str(a.project), str(a.query)) };
      case PEER_TOOLS.send:
        return this.send(from, str(a.to), str(a.text));
      case PEER_TOOLS.ask:
        return this.ask(from, str(a.to), str(a.text), Number(a.timeout_minutes) || ASK_DEFAULT_MIN, c.signal);
      case PEER_TOOLS.broadcast:
        return this.broadcastFrom(from, str(a.text), { project: str(a.project), status: str(a.status), scope: str(a.scope) });
      case TEXT_PERSON: {
        const phone = this.ctx.homeLine?.phone;
        if (!phone) return { text: "Texting is off in Tether, so nothing was sent. Say it in your reply instead.", isError: true };
        return phone.text(from, str(a.message));
      }
      default:
        return { text: `There's no tool ${c.tool}.`, isError: true };
    }
  }

  /** A subagent speaks for its main session. */
  private root(id: string): string {
    let s = this.ctx.session(id);
    for (let i = 0; i < 5 && s?.summary.parentSessionId; i++) {
      id = s.summary.parentSessionId;
      s = this.ctx.session(id);
    }
    return id;
  }

  private name(id: string) {
    const t = this.ctx.session(id)?.summary.title;
    return t ? `"${markTitle(t)}"` : id;
  }

  /**
   * `"<title>" (<id>)`: how an answer names the session a message reached, which the transcript's
   * tool card reads (shared/peers.ts peerTarget). Only once it reached it.
   */
  private who(id: string, title = this.ctx.session(id)?.summary.title ?? "") {
    return `"${markTitle(title)}" (${id})`;
  }

  /** Whether a message can reach `s`: listed, not archived, not a subagent, not the Home agent's chat. */
  private reaches(s: SessionSummary) {
    return reachable(s) && !(this.ctx.homeFolder && s.projectPath === this.ctx.homeFolder);
  }

  /** The sessions the lists show (recent ones and every live one) that `from` can message. */
  private others(from: string): SessionSummary[] {
    return this.ctx.sessions.list().filter((s) => this.reaches(s) && s.id !== from);
  }

  private inProject(s: SessionSummary, project: string) {
    const p = project.trim().replace(/\/+$/, "");
    return !p || s.projectPath === p || folderOf(s.projectPath) === p || s.projectPath.endsWith(`/${p.replace(/^~\//, "")}`);
  }

  private async list(from: string, project: string, query: string): Promise<string> {
    const q = query.trim().toLowerCase();
    const rows = this.others(from).filter((s) => this.inProject(s, project) && (!q || s.title.toLowerCase().includes(q)));
    if (!rows.length) return project || q ? "No other session matches." : "There are no other sessions.";
    const now = this.now();
    const shown = rows.slice(0, 50).map((s) => `- ${s.id} · "${markTitle(s.title)}" · ${HARNESS_LABELS[s.harness] ?? s.harness} · ${s.projectPath} · ${s.mode === "terminal" ? "in its terminal" : statusWord(s)} · ${ago(s.updatedAt, now)}`);
    return [...shown, ...(rows.length > 50 ? [`… and ${rows.length - 50} more: narrow it with project or query.`] : [])].join("\n");
  }

  /**
   * The session `to` names: an id (any session's, older than the lists too), or a title that only
   * one listed session has.
   */
  private async target(from: string, to: string): Promise<SessionSummary> {
    const t = to.trim();
    if (!t) throw new Error("Say which session: `to` is its id or title.");
    if (t === from) throw new Error("That's this session. Message another one.");
    const all = this.others(from);
    const byId = all.find((s) => s.id === t);
    if (byId) return byId;
    if (/^[a-z]+:[\w.-]+$/.test(t)) {
      const s = (await this.ctx.sessions.open(t).catch(() => undefined))?.summary;
      if (s && this.reaches(s)) return s;
      if (s) throw new Error(`Session ${t} can't be messaged (archived sessions, subagents and the Home agent can't be).`);
    }
    const lower = t.toLowerCase();
    for (const pick of [(s: SessionSummary) => s.title.toLowerCase() === lower, (s: SessionSummary) => s.title.toLowerCase().includes(lower)]) {
      const found = all.filter(pick);
      if (found.length === 1) return found[0]!;
      if (found.length > 1) throw new Error(`${found.length} sessions match "${t}": ${found.slice(0, 8).map((s) => `${s.id} ("${markTitle(s.title)}")`).join(", ")}. Use its id.`);
    }
    throw new Error(`There's no session "${markTitle(t)}" to message (archived sessions and subagents can't be). tether_sessions lists them.`);
  }

  /** Who sends: its title, and its permission level (unknown: the strictest). */
  private async sender(from: string): Promise<{ id: string; title: string; level: Level }> {
    const s = this.ctx.session(from) ?? (await this.ctx.sessions.open(from).catch(() => undefined));
    return { id: from, title: s?.summary.title || "Untitled", level: this.level(s) ?? LEVELS.readOnly };
  }

  /** How far a session's mode lets its agent go without asking (core/permissionLevel.ts), if known. */
  private level(s: SessionLook | undefined): Level | undefined {
    if (!s) return undefined;
    return levelOf(this.ctx.sessions.adapters().find((a) => a.id === s.summary.harness), s.state.permissionMode);
  }

  /** The hint the receiving agent reads: what it's for, and the sender's permissions. */
  private hint(me: { level: Level }, text: string) {
    return `${text} The sender's permissions: ${LEVEL_WORDS[me.level]}.`;
  }

  /** A cap hit: the tool says why, and the sender's transcript shows it. */
  private refused(from: string, why: string): PeerAnswer {
    void this.ctx.sessions
      .notice(from, { id: `n-peers-${this.now()}-${Math.random().toString(36).slice(2, 6)}`, role: "notice", level: "warning", ts: this.now(), parts: [{ type: "text", text: `Tether held back a message to another session: ${why}` }] })
      .catch(() => {});
    return { text: why, isError: true };
  }

  private checkText(text: string) {
    if (!text.trim()) throw new Error("The message is empty.");
    if (text.length > MESSAGE_TEXT_MAX) throw new Error("That message is too long.");
  }

  /**
   * Why `from` may not message `to`, if it may not: a session can't reach one whose permissions are
   * looser than its own (an unknown sender: the strictest; an unknown target: the loosest), so it
   * can't get done through another what it isn't allowed to do itself.
   */
  private async forbidden(from: string, to: SessionSummary): Promise<string | undefined> {
    const me = await this.sender(from);
    const target = this.level(await this.ctx.sessions.open(to.id).catch(() => undefined));
    if (target !== undefined && target <= me.level) return undefined;
    const theirs = target === undefined ? "permissions Tether can't tell" : LEVEL_WORDS[target];
    return `This session doesn't have permission to message ${this.who(to.id, to.title)}: it runs with ${theirs}, looser than this session's (${LEVEL_WORDS[me.level]}). Nothing was sent.`;
  }

  /** Puts a peer message in `to`'s queue; says where it stands. */
  private async deliver(to: SessionSummary, body: string): Promise<{ msgId: string; where: string; terminal: boolean }> {
    const { id } = await this.ctx.sessions.queue(to.id, body);
    const look = await this.ctx.sessions.open(to.id).catch(() => undefined);
    const agent = AGENT_NAMES[to.harness as HarnessId] ?? "It";
    const terminal = look?.state.mode === "terminal";
    const where = terminal
      ? "Its terminal is driving, so it waits in the queue until the person goes back to Tether."
      : look?.state.queueHeld
        ? "Its queue is paused for the person, so it waits there until they carry on."
        : look && look.status !== "idle"
          ? `${agent} is working: it gets this when its current turn ends.`
          : "It's idle, so it starts on it now.";
    return { msgId: id, where, terminal };
  }

  async send(from: string, to: string, text: string): Promise<PeerAnswer> {
    this.checkText(text);
    const t = await this.target(from, to);
    const no = await this.forbidden(from, t);
    if (no) return this.refused(from, no);
    const why = this.caps.check(from, t.id, "send");
    if (why) return this.refused(from, why);
    // Reserved before anything waits (and given back if it doesn't go).
    const hops = this.caps.hopsFrom(from);
    const undo = this.caps.count(from);
    const d = await (async () => {
      const me = await this.sender(from);
      const body = sessionMessage(me, text, this.hint(me, `from another session, not the person. To answer, use tether_send with to "${from}"; only if an answer is needed.`), false, hops);
      return this.deliver(t, body);
    })().catch((e) => {
      undo();
      throw e;
    });
    return { text: `Sent to ${this.who(t.id, t.title)}. ${d.where}` };
  }

  async ask(from: string, to: string, text: string, minutes: number, signal?: AbortSignal): Promise<PeerAnswer> {
    this.checkText(text);
    const t = await this.target(from, to);
    const no = await this.forbidden(from, t);
    if (no) return this.refused(from, no);
    const why = this.caps.check(from, t.id, "ask");
    if (why) return this.refused(from, why);
    // Reserved before anything waits, so two asks side by side see each other (a cycle, the open
    // asks, the rate); given back if it doesn't go.
    const hops = this.caps.hopsFrom(from);
    const undo = this.caps.count(from);
    const close = this.caps.open(from, t.id);
    const d = await (async () => {
      const me = await this.sender(from);
      const terminal = this.ctx.session(t.id)?.state.mode === "terminal";
      const hint = terminal
        ? `a question from another session, not the person. Answer it with tether_send to "${from}".`
        : "a question from another session, not the person. Your final reply this turn goes back to it automatically.";
      return this.deliver(t, sessionMessage(me, text, this.hint(me, hint), false, hops));
    })().catch((e) => {
      undo();
      close();
      throw e;
    });
    if (d.terminal) {
      close();
      return { text: `Queued for ${this.who(t.id, t.title)}, not waiting for the answer: ${d.where} It was asked to answer with tether_send.` };
    }
    const wait = Math.min(Math.max(minutes, 1), ASK_MAX_MIN) * 60_000;
    return new Promise<PeerAnswer>((resolve) => {
      const ask: Ask = {
        from,
        to: t.id,
        msgId: d.msgId,
        delivered: false,
        done: (a) => {
          clearTimeout(timer);
          close();
          resolve(a);
        },
      };
      this.asks.push(ask);
      const timer = setTimeout(() => {
        const still = ask.delivered ? "is still working on it" : "hasn't got to it yet (it waits in its queue)";
        this.finish(ask, { text: `No answer within ${Math.round(wait / 60_000)} minutes: ${this.who(t.id, t.title)} ${still}. Ask again later, or check with tether_sessions.`, isError: true });
      }, wait);
      // The asking agent stopped waiting (its turn was stopped): the question stays queued.
      signal?.addEventListener("abort", () => this.asks.includes(ask) && this.finish(ask, { text: "Stopped waiting.", isError: true }));
    });
  }

  /**
   * An agent's note to all: its own project's sessions unless it names a `project` or asks for
   * `scope: "all"`.
   */
  async broadcastFrom(from: string, text: string, f: { project?: string; status?: string; scope?: string }): Promise<PeerAnswer> {
    this.checkText(text);
    const project = f.project?.trim();
    const all = !project && f.scope === "all";
    const own = project || all ? undefined : (this.ctx.session(from) ?? (await this.ctx.sessions.open(from).catch(() => undefined)))?.summary.projectPath;
    if (!project && !all && !own) return { text: "Couldn't tell this session's project, so nothing was sent. Pass project, or scope \"all\".", isError: true };
    const why = this.caps.checkBroadcast(from);
    if (why) return this.refused(from, why);
    const status = f.status === "idle" || f.status === "working" || f.status === "waiting" ? f.status : undefined;
    const targets = matching(this.others(from), { ...(status ? { status } : {}), ...(own ? { projectPath: own } : {}) }).filter((s) => this.inProject(s, project ?? ""));
    if (!targets.length) return { text: own ? "No other session in this project matches, so nothing was sent. Pass project, or scope \"all\", for others." : "No other session matches, so nothing was sent." };
    if (targets.length > BROADCAST_MAX) return this.refused(from, `${targets.length} sessions match (at most ${BROADCAST_MAX} at once). Narrow it with project or status.`);
    // Reserved before anything waits; given back if it reached nobody.
    const hops = this.caps.hopsFrom(from);
    const undo = this.caps.count(from, true);
    const me = await this.sender(from);
    const body = sessionMessage(me, text, this.hint(me, `a note from another session to every session, not the person. Reply only if it asks you to, with tether_send to "${from}".`), true, hops);
    const sent: string[] = [];
    const failed: string[] = [];
    const denied: string[] = [];
    for (const t of targets) {
      try {
        // A looser session is left out (forbidden), the rest still get it.
        if (await this.forbidden(from, t)) {
          denied.push(`- ${t.id} ("${markTitle(t.title)}")`);
          continue;
        }
        await this.deliver(t, body);
        sent.push(`- ${t.id} ("${markTitle(t.title)}")`);
      } catch (e) {
        failed.push(`- ${t.id} ("${markTitle(t.title)}"): ${(e as Error).message}`);
      }
    }
    if (!sent.length) undo();
    return { text: [`Sent to ${sent.length} session${sent.length === 1 ? "" : "s"}:`, ...sent, ...(denied.length ? ["No permission (their permissions are looser than this session's), not sent to:", ...denied] : []), ...(failed.length ? ["Couldn't send to:", ...failed] : [])].join("\n") };
  }
}

/** How long an MCP call may run: an ask's longest wait, and a little. */
const CALL_MS = (ASK_MAX_MIN + 5) * 60_000;

export const peersModule: Module = {
  name: "peers",
  start(ctx) {
    if (process.env.TETHER_PEERS === "0") return;
    const peers = new Peers(ctx);
    const secret = peerSecret(ctx.dataDir);
    const socket = new PeerSocket(join(ctx.dataDir, "peers.sock"), secret, (c) => peers.call(c), ctx.log);
    socket.start();
    const home = ctx.homeFolder;
    const unset = ctx.sessions.adapters().map((a) =>
      a.toolServer?.({
        name: PEER_SERVER,
        command: process.execPath,
        args: [join(import.meta.dir, "mcp.ts")],
        env: (id) => ({ TETHER_PEERS_SOCKET: socket.socketPath, TETHER_PEERS_ID: id, TETHER_PEERS_TOKEN: peerToken(secret, id) }),
        timeoutMs: CALL_MS,
        // The Home agent has tools (and instructions) of its own.
        skip: (p) => !!home && p === home,
        instructions: () => sessionInstructions(runnerSettings()),
        shellEnv: (id) => ({ [SESSION_ENV]: id }),
      }),
    );
    const offs = [
      ctx.bus.on("queueGone", ({ sessionId, msgId, how, text }) => peers.queueGone(sessionId, msgId, how, text)),
      ctx.bus.on("message", ({ sessionId, msg }) => peers.message(sessionId, msg)),
      // A rate-limit retry is still that turn: its ask stays open for the turn that recovers.
      ctx.bus.on("turnEnded", ({ sessionId, error, stopped, recovering }) => void (!recovering && peers.turnEnded(sessionId, error, stopped))),
    ];
    ctx.log(`peers: tools for every session, calls on ${socket.socketPath}`);
    return () => {
      offs.forEach((off) => off());
      unset.forEach((u) => u?.());
      socket.stop();
    };
  },
};
