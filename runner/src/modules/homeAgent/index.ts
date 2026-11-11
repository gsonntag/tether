// The Home agent: a chat on Home that starts work in a project and sees it through. It is a Claude
// session in its own folder (RunnerOptions.homeFolder) with Tether's tools (core/adapter.ts
// AgentSetup): list the projects, look at one, start a session there with a prompt and full
// permissions, list every session on the machine and read how any of them is doing, and send more
// to any session the lists show (send_to_session). Each time a session it started, or one it
// messaged, ends a turn, its last reply goes to the chat as a message from Tether, so the agent can
// keep it going until the task is done. A session the person steps into (types in it, or stops
// it) is theirs from then on: no more reports until the agent messages it again (when the person
// asks it to).
//
// Unless the person turns "Watch all sessions" off, it also hears about every other session on the
// machine (watch): when one it doesn't follow finishes a turn, fails or starts waiting for the
// person, a short line about it goes to the current chat, several close together in one message.
//
// On request it also checks in with every session (check_in_sessions, checkIn.ts): it asks each
// idle one whether it's done and all its work is merged or applied, and tells the finished ones to
// remove the worktrees they made; it checks the answers against git, archives the finished ones,
// and sends the chat one report of what was archived and what wasn't.
//
// `/new` or `/clear` on Home (homeAgentClear) drops the current chat: the next message starts a
// fresh one, a new Claude session with none of the old context. The old chat is stopped if it runs
// and lets go of the sessions it started (they keep going on their own, in the lists). Every
// change of the current chat is broadcast, so each device's Home follows.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { FROM_TETHER, fromTether } from "../../../../shared/fromTether";
import { AGENT_NAMES, HARNESS_LABELS, type HarnessId, type Msg, type Request, type SessionSummary } from "../../../../shared/transcript";
import type { BillingSource, SourceOption } from "../../../../shared/credentials";
import type { HomeAgentSettings } from "../../../../shared/protocol";
import type { Adapter, AgentSetup, AgentTool } from "../../core/adapter";
import type { Module, ModuleContext } from "..";
import { CHECKIN_MAX, CHECKIN_WAIT_MS, checkInMessage, judge, parseAnswer, repoOf, runGit, skipReason, verify, type Git } from "./checkIn";

/** Reports a session may send before the agent stops following it: a loop can't run forever. */
export const MAX_REPORTS = 12;
/** How much of a session's last reply a report carries. */
const REPLY_MAX = 6000;
/** How much of a latest reply or prompt session_status carries. */
const STATUS_MAX = 3000;
/** How long a list_sessions line's "what it's on" may be. */
const LINE_MAX = 140;
/** list_sessions: rows by default, and at most. */
const LIST_DEFAULT = 20;
const LIST_MAX = 50;
/**
 * Watch reports: how long a line waits for others to come with it (each new one restarts the wait),
 * and the longest the first one waits. Tests shorten them.
 */
export const WATCH = { quietMs: 20_000, maxMs: 90_000 };
/** How much of a watched session's last reply its line carries. */
const WATCH_REPLY_MAX = 280;
/** Each harness's mode that runs without asking. */
const AUTONOMOUS: Record<HarnessId, string> = { claude: "bypassPermissions", codex: "full-access" };
/**
 * The mode the agent's own chats run in on each harness. Claude's tools that touch anything are
 * taken away (AgentSetup.deny); Codex's shell, patch and web tools are switched off by config
 * (adapters/codex/setup.ts), and its sandbox is read-only on top.
 */
const OWN_MODE: Record<HarnessId, string> = { claude: "default", codex: "read-only" };

interface Child {
  /** the chat that started it, or last messaged it */
  chat: string;
  reports: number;
  /** the agent didn't start it: it took it on by messaging it */
  messaged?: boolean;
  /** the agent's message waits behind a turn that isn't the agent's: that turn's end isn't reported */
  queued?: boolean;
  /** the person stepped in, it hit MAX_REPORTS, or its chat was cleared: no more reports (a new message follows it again, but past the limit) */
  released?: "person" | "limit" | "cleared";
}

/** One session in a check-in. */
interface Entry {
  title: string;
  project: string;
  /** other sessions' folders in its repo: never its worktrees to remove */
  keep?: string[];
  /** set once it's settled: archived, kept (with why), or not asked (with why) */
  outcome?: "archived" | "kept" | "skipped";
  reason?: string;
}

/** One "are you done?" round, from one chat. */
interface CheckIn {
  chat: string;
  at: number;
  /** when the sessions that haven't answered are reported as unanswered */
  deadline: number;
  entries: Record<string, Entry>;
}

interface State {
  current?: string;
  /** grows with each change of `current`, across restarts (HomeChatUpdate.rev) */
  rev: number;
  children: Record<string, Child>;
  /** what it runs on, as the person chose it; none: Claude Code on the source a new session gets */
  settings?: HomeAgentSettings;
  checkIns?: Record<string, CheckIn>;
  /** "Watch all sessions"; none: on */
  watchAll?: boolean;
}

/** What a watched session did, for the next watch report. */
interface Watched {
  kind: "finished" | "failed" | "waiting";
  detail?: string;
}

const HARNESSES: HarnessId[] = ["claude", "codex"];

/** `v` as settings, if it is one. */
export function settingsOf(v: unknown): HomeAgentSettings | undefined {
  const o = v as Partial<HomeAgentSettings> | undefined;
  if (!o || typeof o !== "object" || !HARNESSES.includes(o.harness as HarnessId) || typeof o.source !== "string" || !o.source) return undefined;
  const model = typeof o.model === "string" && o.model.trim() && o.model !== "default" ? o.model.trim() : undefined;
  return { harness: o.harness as HarnessId, source: o.source as BillingSource, ...(model ? { model } : {}) };
}

export const INSTRUCTIONS = `You are Tether's Home agent. The person talks to you from Tether's home page. Your job is to turn what they ask for into a coding session in one of their projects, give it a strong first prompt, and see it through until the task is done.

How to work:
- Find the project with list_projects. Use project_overview when you need to know more about one. If more than one project could be meant, ask the person which in one short question. Never guess.
- Start the work with start_session. The prompt is everything the session knows, so write a complete brief: the goal, the context the person gave you (quote their words where it matters), constraints, and what done means (for example: tests pass, it builds, the change is committed on a branch, etc. only if they asked for it). Tell it to work autonomously to completion without stopping to ask for confirmation, and to verify its work before finishing. The session runs with full permissions.
- Use Claude Code unless the person asks for Codex. Leave the model at its default unless they name one.
- For questions about what's going on ("what's running?", "what's finished?", "is anything working on X?", "how is the session on Y doing?"), use list_sessions: it sees every session on this machine, whoever started it, with its state and what it's on. Filter by state or project rather than listing everything. Read one more closely with session_status.
- You can message any of those sessions with send_to_session, including ones you didn't start. Message a session you didn't start (or one the person has taken over) only when the person asks you to or it's part of the task they gave you, and say who it's from and what you need in the message. It goes now if the session is idle, else after its current turn; sessions that are waiting for the person, archived, or open in a terminal can't be messaged. Once you message one, you follow it like a session you started.
- After starting a session, tell the person in one casual sentence what you started and where. Don't poll: Tether sends you a report (a message starting with "[From Tether]") each time a session you started or messaged finishes a turn or needs the person.
- Tether also watches every other session on this machine for you (unless the person turned off "Watch all sessions"): when sessions you didn't start finish a turn, fail, or start waiting for the person, you get one short report ("[From Tether] Sessions you didn't start: ..."), several at once when they come close together. These aren't yours: don't message them unless the person asked you to. If one failed or is waiting for the person, tell them in one casual sentence which and what it needs. If one just finished, mention it only if the person was waiting on it or asked about it; otherwise reply with a few words at most. Sessions you started still get their own reports: keep those going until the task is done.
- On a report: if the task is complete and verified, tell the person in one casual sentence only what's notable (where the work is, e.g. the PR or issue link), or nothing more than that it's done. If the session stopped early (it asked something you can answer from what the person said, stopped halfway, or says it's done but skipped verification), use send_to_session with a specific instruction to keep it going. If it needs a decision only the person can make, or it keeps failing, tell the person in one sentence and stop.
- When the person asks you to check in with their sessions ("ask all agents if they're done", "clean up finished sessions"), use check_in_sessions (with project_path if they name a project). It asks every session that is idle right now (in the last few days' list, not archived, not your own chats; sessions that are running a turn, waiting for the person, or open in a terminal are skipped, not interrupted) whether its task is done and all its work is merged or applied, and tells the finished ones to remove the git worktrees they made (never the main checkout or another session's folder) before they answer. Tether checks each answer against git and archives only the sessions that are done, merged and cleaned up; one that still has a worktree left is kept, with the reason. Tell the person in one sentence how many you asked; one report comes back when they've all answered (or after ${CHECKIN_WAIT_MS / 60_000} minutes). Then give a short summary: which were archived, and which weren't and why, one line each. Don't send the sessions anything else about it.
- Use archive_session only when the person asks to archive a specific session (for example one the check-in kept). Never archive on your own judgment.
- Never do the coding yourself. You have no shell and can't edit files.
- Every reply is at most one casual sentence, like a coworker texting (links are fine). Only say what's notable or what needs the person: a decision, a failure, where to find the work. Never confirm that something works, that tests pass, or that it was verified. No file lists, no cause analysis, no caveats, unless the person asks. Never paste or summarize a session's reply: they can open the session. The person reads you on a phone.`;

const text = (m: Msg) =>
  m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();

/** The newest assistant text in `msgs`. */
export function lastReply(msgs: Msg[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant" && text(m)) return text(m);
  }
  return undefined;
}

/** The newest prompt the session was given (the person's, or Tether's), without Tether's marker. */
export function lastPrompt(msgs: Msg[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "user" || m.origin?.kind === "shell") continue;
    const t = text(m);
    if (t) return fromTether(t) ?? t;
  }
  return undefined;
}

/** What a session is doing, for the Home agent. */
export type SessionState = "running" | "waiting" | "finished" | "failed";
export const STATE_LABELS: Record<SessionState, string> = { running: "running", waiting: "waiting on you", finished: "finished", failed: "failed" };

/** A row's state; `error` is a failure the session has in memory (an unread failure is on the row). */
export function stateOf(s: SessionSummary, error?: string): SessionState {
  if (s.status === "waiting" || s.requests || s.queuePaused) return "waiting";
  if (s.status === "running" || s.backgroundSubagents) return "running";
  if (s.unread === "failed" || s.failure || error) return "failed";
  return "finished";
}

/** "just now", "5m ago", "3h ago", "2d ago" */
export function ago(t: number, now = Date.now()) {
  const m = Math.floor((now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

/** One line, at most `n` characters. */
const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Whether a session's folder is the project `want` names: its path (~ works), or the folder's name. */
export function inProject(projectPath: string, want: string) {
  const w = want.trim().replace(/\/+$/, "");
  if (!w) return true;
  const path = resolve(projectPath);
  if (w.includes("/")) return path === resolve(w.replace(/^~(?=\/|$)/, homedir()));
  return basename(path).toLowerCase() === w.toLowerCase();
}

/** What an open request asks for, in a few words. */
const asks = (r: Request) => {
  const what = r.title || r.question || (r.tool ? `permission for ${r.tool}` : "a question");
  const detail = r.command || r.path;
  return oneLine(detail && !what.includes(detail) ? `${what} (${detail})` : what, 300);
};

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (cut: ${s.length - n} more characters)` : s);

/** A small, read-only digest of a folder: its README, what's at the top, and git's view. */
async function overview(folder: string): Promise<string> {
  const out: string[] = [`Folder: ${folder}`];
  let names: string[] = [];
  try {
    names = readdirSync(folder, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") || e.name === ".github")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch (e) {
    out.push(`Can't list it: ${(e as Error).message}`);
  }
  if (names.length) out.push(`Top level (${names.length}): ${names.slice(0, 80).join("  ")}${names.length > 80 ? "  …" : ""}`);
  const run = runGit();
  const git = (...args: string[]) => run(folder, ...args);
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch) {
    const status = (await git("status", "--porcelain")) ?? "";
    const changed = status ? status.split("\n").length : 0;
    out.push(`Git: on ${branch}, ${changed ? `${changed} changed file${changed === 1 ? "" : "s"}` : "clean"}`);
    const log = await git("log", "--oneline", "-8");
    if (log) out.push(`Recent commits:\n${log}`);
  }
  const readme = names.find((n) => /^readme(\.(md|txt|rst))?$/i.test(n));
  if (readme) {
    try {
      out.push(`${readme}:\n${cut(readFileSync(join(folder, readme), "utf8"), 4000)}`);
    } catch {}
  }
  for (const f of ["CLAUDE.md", "AGENTS.md"])
    if (names.includes(f)) {
      try {
        out.push(`${f}:\n${cut(readFileSync(join(folder, f), "utf8"), 3000)}`);
      } catch {}
    }
  return out.join("\n\n");
}

export class HomeAgent {
  state: State = { rev: 0, children: {} };
  private file: string;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** sessions whose check-in answer is being judged now */
  private judging = new Set<string>();
  /** watch news waiting for the next report, by session */
  private watched = new Map<string, Watched>();
  private watchTimer?: ReturnType<typeof setTimeout>;
  private watchSince?: number;

  constructor(
    private ctx: ModuleContext,
    readonly folder: string,
    /** git for checking answers (tests replace it) */
    private git: Git = runGit(),
    private waitMs = CHECKIN_WAIT_MS,
  ) {
    this.file = join(ctx.dataDir, "state.json");
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      if (v && typeof v === "object")
        this.state = {
          current: typeof v.current === "string" ? v.current : undefined,
          rev: Number.isSafeInteger(v.rev) ? v.rev : 0,
          children: v.children && typeof v.children === "object" ? v.children : {},
          ...(settingsOf(v.settings) ? { settings: settingsOf(v.settings) } : {}),
          checkIns: v.checkIns && typeof v.checkIns === "object" ? v.checkIns : {},
          ...(v.watchAll === false ? { watchAll: false } : {}),
        };
    } catch {}
    // Check-ins a restart interrupted: their clocks start again (one already past reports now).
    for (const id of Object.keys(this.state.checkIns ?? {})) this.arm(id);
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    clearTimeout(this.watchTimer);
  }

  /** "Watch all sessions" (default on); `on` changes it. Off drops what's waiting to be reported. */
  watch(on?: unknown): { watchAll: boolean } {
    if (typeof on === "boolean") {
      if (on) delete this.state.watchAll;
      else {
        this.state.watchAll = false;
        this.watched.clear();
        clearTimeout(this.watchTimer);
        this.watchTimer = undefined;
      }
      this.save();
    }
    return { watchAll: this.state.watchAll !== false };
  }

  /**
   * Whether a session's turn or request goes in a watch report: watching is on, it's a top-level
   * session that isn't archived, not one of the agent's chats, not answering a check-in, and not one
   * a chat follows (those report themselves).
   */
  private watchable(id: string): boolean {
    if (this.state.watchAll === false || this.isChat(id) || this.waiting(id)) return false;
    const c = this.state.children[id];
    if (c && !c.released) return false;
    const look = this.ctx.session(id);
    if (!look) return false;
    return !look.summary.archived && !look.summary.parentSessionId && resolve(look.summary.projectPath) !== resolve(this.folder);
  }

  /** Puts a session's news in the next watch report: the newest per session, sent once things go quiet. */
  private noteWatched(id: string, w: Watched) {
    this.watched.set(id, w);
    clearTimeout(this.watchTimer);
    this.watchSince ??= Date.now();
    const wait = Math.max(0, Math.min(WATCH.quietMs, this.watchSince + WATCH.maxMs - Date.now()));
    this.watchTimer = setTimeout(() => void this.flushWatched(), wait);
    this.watchTimer.unref?.();
  }

  /** Sends what's waiting as one report to the current chat (none: dropped, nobody would see it). */
  async flushWatched() {
    clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
    this.watchSince = undefined;
    const items = [...this.watched];
    this.watched.clear();
    const chat = await this.current();
    if (!chat || !items.length) return;
    const lines: string[] = [];
    for (const [id, w] of items) {
      const look = this.ctx.session(id);
      // Archived (or gone) since: not news any more.
      if (look?.summary.archived) continue;
      const head = look ? `${id} "${oneLine(look.summary.title || "Untitled", 60)}" (${basename(look.summary.projectPath) || look.summary.projectPath}, ${AGENT_NAMES[look.summary.harness] ?? look.summary.harness})` : id;
      if (w.kind === "waiting") lines.push(`- ${head}: waiting for the person: ${w.detail}`);
      else if (w.kind === "failed") lines.push(`- ${head}: failed: ${oneLine(w.detail ?? "", 300)}`);
      else {
        const reply = lastReply(await this.ctx.sessions.recent(id, 20).catch(() => [] as Msg[]));
        lines.push(`- ${head}: finished a turn${reply ? `. It said: ${oneLine(reply, WATCH_REPLY_MAX)}` : "."}`);
      }
    }
    if (!lines.length) return;
    const body = [
      `Sessions you didn't start (watching all sessions; they aren't yours to drive):`,
      ...lines,
      `Tell the person in one casual sentence if one failed or needs them; otherwise reply with a few words at most. Use session_status for more.`,
    ].join("\n");
    try {
      await this.ctx.sessions.queue(chat, FROM_TETHER + body);
    } catch (e) {
      this.ctx.log(`couldn't send a watch report to ${chat}: ${(e as Error).message}`);
    }
  }

  private save() {
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      this.ctx.log(`couldn't save: ${(e as Error).message}`);
    }
  }

  /** The current chat, if it still exists. */
  async current(): Promise<string | undefined> {
    const id = this.state.current;
    if (!id) return undefined;
    try {
      return await this.follow(id);
    } catch {
      // Created but never sent to: nothing is stored, so it can't open after a restart.
      return undefined;
    }
  }

  /** `current` becomes `id` (none: cleared), saved and told to every browser. */
  private setCurrent(id: string | undefined) {
    // A clock-based rev stays ahead of what browsers saw even if state.json was lost.
    this.state.rev = Math.max(this.state.rev + 1, Date.now());
    this.state.current = id;
    this.save();
    this.ctx.announceHomeChat?.({ ...(id ? { sessionId: id } : {}), rev: this.state.rev });
    return this.state.rev;
  }

  /**
   * Where a chat went on: a source change that took a new thread (a Codex carry) leaves the old one
   * pointing at it (`continuedIn`). Its sessions follow it, and so does `current`.
   */
  private async follow(id: string): Promise<string> {
    let at = id;
    for (let i = 0; i < 20; i++) {
      const next = (await this.ctx.sessions.open(at)).state.continuedIn;
      if (!next || next === at) break;
      at = next;
    }
    if (at !== id) this.moved(id, at);
    return at;
  }

  /** A chat went on in `to`: it's current if `from` was, and the sessions `from` started report there. */
  private moved(from: string, to: string) {
    for (const c of Object.values(this.state.children)) if (c.chat === from) c.chat = to;
    if (this.state.current === from) this.setCurrent(to);
    else this.save();
  }

  /** The harnesses that can run it here: the runner has them, and they take Tether's tools. */
  harnesses(): HarnessId[] {
    return this.ctx.sessions.adapters().filter((a) => a.agentSetup && HARNESSES.includes(a.id)).map((a) => a.id);
  }

  /** What it runs on: the person's choice, else Claude Code (or what there is) on the source a new session gets. */
  async settings(): Promise<HomeAgentSettings> {
    const have = this.harnesses();
    const set = this.state.settings;
    if (set && have.includes(set.harness)) return set;
    const harness = have.includes("claude") ? "claude" : (have[0] ?? "claude");
    return { harness, source: (await this.ctx.sessions.sources(harness)).default ?? "subscription" };
  }

  async newChat(): Promise<{ sessionId: string; rev: number }> {
    const { harness, source, model } = await this.settings();
    const id = await this.ctx.sessions.create({ harness, projectPath: this.folder, source, permissionMode: OWN_MODE[harness], ...(model ? { model } : {}) });
    return { sessionId: id, rev: this.setCurrent(id) };
  }

  /**
   * Keeps `asked` for every chat to come, and puts the current chat on it: the model at once,
   * Claude's source from its next start (the same session), and anything else (another harness, or
   * a Codex source, which needs a new thread) by a move, a new chat with the whole conversation.
   * The move needs the chat idle; until something is applied nothing is saved.
   */
  async set(asked: unknown): Promise<{ sessionId?: string; settings: HomeAgentSettings; rev: number }> {
    const next = settingsOf(asked);
    if (!next) throw new Error("Pick an agent and a source.");
    if (!this.harnesses().includes(next.harness)) throw new Error(`${HARNESS_LABELS[next.harness]} can't run the Home agent on this runner.`);
    const sources = await this.ctx.sessions.sources(next.harness);
    // A runner with no choice of source: its harness's own login.
    const option = sources.options.length ? sources.options.find((o) => o.source === next.source) : next.source === "subscription" ? ({ source: next.source } as SourceOption) : undefined;
    if (!option) throw new Error(`${this.adapter(next.harness)?.billing?.label(next.source).label ?? next.source} isn't set up on this runner.`);
    const deployments = option.deployments?.map((d) => d.name) ?? (option.deployment ? [option.deployment] : undefined);
    if (deployments && !(next.model && deployments.includes(next.model))) {
      if (!deployments[0]) throw new Error("Add an Azure deployment in Credentials first.");
      next.model = deployments[0];
    }
    let id = await this.current();
    if (id) {
      const look = await this.ctx.sessions.open(id);
      const s = this.ctx.sessions;
      const sameHarness = look.summary.harness === next.harness;
      const own = await s.sourceOf(id);
      const capabilities = this.adapter(next.harness)?.capabilities;
      if (!sameHarness || (next.source !== own && !(capabilities?.sourceSwitch && !capabilities.sourceCarry))) {
        const moved = await this.ctx.ops.call("moveSession", { sessionId: id, harness: next.harness, source: next.source, ...(next.model ? { model: next.model } : {}) });
        await this.ctx.ops.call("setPermissionMode", { sessionId: moved.sessionId, mode: OWN_MODE[next.harness] }).catch((e) => this.ctx.log(`couldn't set the moved chat's mode: ${(e as Error).message}`));
        this.moved(id, moved.sessionId);
        id = moved.sessionId;
      } else {
        if (next.model && next.model !== look.state.model) await this.ctx.ops.call("setModel", { sessionId: id, model: next.model });
        if (next.source !== own) await this.ctx.ops.call("setSessionSource", { sessionId: id, source: next.source });
      }
    }
    this.state.settings = next;
    this.save();
    return { ...(id ? { sessionId: id } : {}), settings: next, rev: this.state.rev };
  }

  private adapter(h: HarnessId): Adapter | undefined {
    return this.ctx.sessions.adapters().find((a) => a.id === h);
  }

  /**
   * `/new` and `/clear`: no current chat, so the next message starts a fresh one with none of this
   * one's context. This one is stopped if it runs, and the sessions it started go on without it:
   * a report would wake a chat nobody sees.
   */
  async clear(): Promise<{ rev: number }> {
    const old = this.state.current;
    if (old) {
      for (const c of Object.values(this.state.children)) if (c.chat === old && !c.released) c.released = "cleared";
      const look = this.ctx.session(old);
      if (look && look.status !== "idle") await this.ctx.sessions.interrupt(old).catch((e) => this.ctx.log(`couldn't stop ${old}: ${(e as Error).message}`));
    }
    return { rev: this.setCurrent(undefined) };
  }

  /** Whether `id` is one of the Home agent's own chats. */
  isChat(id: string) {
    const look = this.ctx.session(id);
    return !!look && resolve(look.summary.projectPath) === resolve(this.folder);
  }

  /**
   * send_to_session: any session the lists show, but the agent's own chats and subagents. It's
   * refused when it can't take a message from Tether now (archived, open in a terminal, waiting for
   * the person); a turn that runs just means after it. The chat follows it from then on, as one
   * it started: a session the person had taken over, or another chat's, is this chat's again.
   */
  async message(chat: string, sessionId: unknown, message: string): Promise<string> {
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("session_id is required.");
    const id = sessionId.trim();
    const s = this.ctx.sessions;
    if (this.isChat(id)) throw new Error("That's one of your own chats.");
    const c = this.state.children[id];
    if (c?.chat === chat && c.released === "limit") throw new Error(`This session has sent ${MAX_REPORTS} reports; you've stopped following it. Tell the person where it stands.`);
    const look = await s.open(id).catch(() => undefined);
    if (!look) throw new Error(`There's no session ${id}.`);
    if (resolve(look.summary.projectPath) === resolve(this.folder)) throw new Error("That's one of your own chats.");
    if (look.summary.parentSessionId) throw new Error("That's a subagent of another session: message its session instead.");
    if (look.summary.archived) throw new Error("That session is archived. Ask the person to unarchive it first if it should go on.");
    if (look.summary.mode === "terminal" || look.state.mode === "terminal" || look.state.terminal) throw new Error("That session is open in a terminal: the person is working in it there. Leave it to them.");
    if (look.requests.length || look.state.requests.length) throw new Error(`That session is waiting for the person${look.state.requests[0] ? ` (${asks(look.state.requests[0])})` : ""}. Only they can answer it, in that session.`);
    if (look.summary.queuePaused || look.state.queueHeld) throw new Error("That session's queue is paused (after a Stop, a failure or a restart): it waits for the person.");
    // Its next turn's end would be read as its check-in answer.
    if (this.waiting(id)) throw new Error("That session is answering your check-in: wait for the check-in report.");
    // Behind a turn (or messages) that isn't this one's: that turn's end isn't the report.
    const behind = look.status !== "idle" || look.state.queue.length > 0;
    const next: Child = c?.chat === chat && !c.released ? c : { chat, reports: 0, ...(c && !c.messaged ? {} : { messaged: true }) };
    if (behind) next.queued = true;
    this.state.children[id] = next;
    this.save();
    await s.queue(id, FROM_TETHER + message).catch((e) => {
      if (next === c) delete next.queued;
      else if (c) this.state.children[id] = c;
      else delete this.state.children[id];
      this.save();
      throw e;
    });
    return behind ? "Queued: it goes after the session's current turn. You'll get a report when your message's turn finishes." : "Sent. You'll get a report when it finishes the turn.";
  }

  /** The tools a chat (by its session id) gets. */
  tools(chat: string): AgentTool[] {
    const s = this.ctx.sessions;
    return [
      {
        name: "list_projects",
        description: "The person's projects on this machine (folders with coding sessions), newest activity first.",
        input: {},
        run: async () => {
          const list = await s.projects();
          if (!list.length) return "No projects yet.";
          const ago = (t: number) => {
            const d = Math.round((Date.now() - t) / 86_400_000);
            return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
          };
          return list
            .slice(0, 100)
            .map((p) => `${p.path}  (${p.name}; ${p.sessions} session${p.sessions === 1 ? "" : "s"}; last active ${ago(p.updatedAt)})`)
            .join("\n");
        },
      },
      {
        name: "project_overview",
        description: "A quick read-only look at a project folder: top-level files, git branch and recent commits, README, CLAUDE.md/AGENTS.md.",
        input: { path: z.string().describe("The project's folder, as list_projects gives it (~ works).") },
        run: async (a: { path: string }) => overview(s.folder(a.path)),
      },
      {
        name: "start_session",
        description:
          "Starts a new coding session in a project with your prompt as its first message. It runs with full permissions (no approval prompts) and works on its own; you get a report each time it finishes a turn.",
        input: {
          project_path: z.string().describe("The project's folder (from list_projects)."),
          prompt: z.string().min(1).describe("The complete brief for the session."),
          title: z.string().max(80).optional().describe("A short title for the session, as the sidebar shows it."),
          harness: z.enum(["claude", "codex"]).optional().describe("claude (Claude Code, the default) or codex."),
          model: z.string().optional().describe("Only when the person names a model."),
        },
        run: async (a: { project_path: string; prompt: string; title?: string; harness?: HarnessId; model?: string }) => {
          const harness: HarnessId = a.harness === "codex" ? "codex" : "claude";
          if (!s.adapters().some((x) => x.id === harness)) throw new Error(`${HARNESS_LABELS[harness]} isn't available on this runner.`);
          const folder = s.folder(a.project_path);
          if (resolve(folder) === resolve(this.folder)) throw new Error("That's your own folder, not a project.");
          const source = (await s.sources(harness)).default ?? "subscription";
          const mode = AUTONOMOUS[harness];
          const id = await s.create({ harness, projectPath: folder, source, permissionMode: mode, ...(a.model ? { model: a.model } : {}) });
          this.state.children[id] = { chat, reports: 0 };
          this.save();
          const title = a.title?.replace(/[\x00-\x1f\x7f]/g, " ").trim();
          if (title) await s.rename(id, title).catch(() => {});
          await s.send(id, FROM_TETHER + a.prompt);
          // A way there from the chat.
          const name = folder.replace(/\/+$/, "").split("/").pop() || folder;
          await s.notice(chat, { id: `n-started-${id}`, role: "notice", level: "info", ts: Date.now(), parts: [{ type: "text", text: `Started ${title ? `“${title}”` : "a session"} in ${name}.` }], link: { sessionId: id, label: "Open it" } }).catch(() => {});
          return `Started session ${id} in ${folder} (${HARNESS_LABELS[harness]}, ${mode}). It's working now. You'll get a report when it finishes a turn.`;
        },
      },
      {
        name: "list_sessions",
        description:
          "Every coding session on this machine, whoever started it: active in the last 3 days, or running now. Newest activity first. Each line: id, title, project, agent, state (running, waiting on you, finished, failed), last active, and what it's on (its latest prompt or reply). Use for \"what's running?\", \"what's finished?\", \"is anything working on X?\".",
        input: {
          state: z.enum(["running", "waiting", "finished", "failed", "active"]).optional().describe("Only sessions in this state. active = running or waiting on you."),
          project: z.string().optional().describe("Only this project: its folder (from list_projects) or the folder's name."),
          limit: z.number().int().min(1).max(LIST_MAX).optional().describe(`How many (default ${LIST_DEFAULT}, at most ${LIST_MAX}).`),
        },
        run: async (a: { state?: SessionState | "active"; project?: string; limit?: number }) => this.listSessions(a),
      },
      {
        name: "session_status",
        description:
          "A closer look at any session (an id from list_sessions or start_session): its state, its latest prompt and reply, and what it waits on.",
        input: { session_id: z.string() },
        run: async (a: { session_id: string }) => {
          if (typeof a.session_id !== "string" || !a.session_id.trim()) throw new Error("session_id is required.");
          const id = a.session_id.trim();
          const c = this.state.children[id];
          const look = await s.open(id);
          const msgs = await s.recent(id, 40).catch(() => [] as Msg[]);
          const reply = lastReply(msgs);
          const prompt = lastPrompt(msgs);
          const st = stateOf({ ...look.summary, status: look.status, requests: look.requests.length }, look.state.error);
          const error = look.state.error ?? look.summary.failure;
          const mine = c?.chat === chat;
          const whose = c?.messaged ? "You messaged it" : "You started it";
          return [
            `Session ${id} ("${look.summary.title || "Untitled"}", ${look.summary.projectPath}, ${AGENT_NAMES[look.summary.harness] ?? look.summary.harness})`,
            `State: ${STATE_LABELS[st]}, last active ${ago(look.summary.updatedAt)}${error ? `. Last error: ${oneLine(error, 300)}` : ""}`,
            ...look.state.requests.map((r) => `Waiting for the person: ${asks(r)}`),
            look.summary.queuePaused ? "Its queue is paused (after a Stop, a failure, a restart, or a message from a stricter session): it waits for the person." : "",
            look.state.queue.length ? `${look.state.queue.length} message${look.state.queue.length === 1 ? "" : "s"} queued.` : "",
            !mine
              ? "You didn't start it. You can message it with send_to_session when the person asks you to; you'd then get its reports."
              : c.released === "person"
                ? "The person has taken this session over: leave it to them unless they ask you to message it."
                : c.released === "limit"
                  ? "You've stopped following it (report limit)."
                  : c.released === "cleared"
                    ? "Your chat was cleared; you've stopped following it."
                    : `${whose}. Reports so far: ${c.reports} of ${MAX_REPORTS}.`,
            prompt ? `Latest prompt:\n${cut(prompt, STATUS_MAX)}` : "",
            reply ? `Latest reply:\n${cut(reply, STATUS_MAX)}` : "No reply yet.",
          ]
            .filter(Boolean)
            .join("\n");
        },
      },
      {
        name: "check_in_sessions",
        description:
          "Asks every idle session (recent, not archived; optionally one project's) whether its task is done and all its work is merged or applied. Tether checks the answers against git, archives the finished sessions, and sends you one report when all have answered. Sessions that are busy or waiting for the person are skipped, not interrupted.",
        input: {
          project_path: z.string().optional().describe("Only this project's sessions (from list_projects)."),
          session_ids: z.array(z.string()).optional().describe("Only these sessions."),
        },
        run: async (a: { project_path?: string; session_ids?: string[] }) => this.checkIn(chat, a),
      },
      {
        name: "archive_session",
        description: "Archives a session (keeps it out of Recent; it stays searchable), as the archive button does. Only when the person asks for that session.",
        input: { session_id: z.string() },
        run: async (a: { session_id: string }) => {
          if (typeof a.session_id !== "string" || !a.session_id) throw new Error("session_id is required.");
          if (this.isChat(a.session_id)) throw new Error("That's one of your own chats.");
          await s.setArchived(a.session_id, true);
          return `Archived ${await this.describe(a.session_id)}.`;
        },
      },
      {
        name: "send_to_session",
        description:
          "Sends a message to any session (an id from list_sessions or start_session), whoever started it: it goes now if the session is idle, else after its current turn. You get a report when that turn finishes, and you follow the session from then on. Refused for sessions that are archived, open in a terminal, or waiting for the person. Message a session you didn't start only when the person asks you to or their task needs it.",
        input: { session_id: z.string(), message: z.string().min(1) },
        run: async (a: { session_id: string; message: string }) => this.message(chat, a.session_id, a.message),
      },
    ];
  }

  /** list_sessions: every listed session but the Home agent's own chats and subagents, filtered. */
  async listSessions(a: { state?: SessionState | "active"; project?: string; limit?: number }): Promise<string> {
    const s = this.ctx.sessions;
    const rows = s
      .list()
      .filter((r) => !r.parentSessionId && resolve(r.projectPath) !== resolve(this.folder))
      .map((r) => ({ r, st: stateOf(r, this.ctx.session(r.id)?.state.error) }))
      .filter(({ r, st }) => (!a.state || (a.state === "active" ? st === "running" || st === "waiting" : st === a.state)) && (!a.project || inProject(r.projectPath, a.project)));
    if (!rows.length) return `No sessions${a.state ? ` ${a.state === "active" ? "running or waiting on you" : STATE_LABELS[a.state]}` : ""}${a.project ? ` in ${a.project}` : ""}.`;
    const limit = Math.min(Math.max(1, Math.floor(a.limit ?? LIST_DEFAULT)), LIST_MAX);
    const page = rows.slice(0, limit);
    const lines = await Promise.all(
      page.map(async ({ r, st }) => {
        const msgs = await s.recent(r.id, 20).catch(() => [] as Msg[]);
        const prompt = lastPrompt(msgs);
        const reply = lastReply(msgs);
        // Whichever came last: a reply after the prompt says where it got to.
        const replyIdx = msgs.findLastIndex((m) => m.role === "assistant" && !!text(m));
        const promptIdx = msgs.findLastIndex((m) => m.role === "user" && m.origin?.kind !== "shell" && !!text(m));
        const on = reply && replyIdx > promptIdx ? `replied: ${reply}` : prompt ? `asked: ${prompt}` : "";
        const project = basename(r.projectPath) || r.projectPath;
        const head = `${r.id} · "${oneLine(r.title || "Untitled", 60)}" · ${project} · ${AGENT_NAMES[r.harness] ?? r.harness} · ${STATE_LABELS[st]} · ${ago(r.updatedAt)}`;
        return on ? `${head}\n  ${oneLine(on, LINE_MAX)}` : head;
      }),
    );
    const more = rows.length > page.length ? `\n(${page.length} of ${rows.length}: filter by state or project, or raise limit)` : "";
    return lines.join("\n") + more;
  }

  setup(chat: string): AgentSetup {
    return {
      server: "tether",
      tools: this.tools(chat),
      instructions: INSTRUCTIONS,
      // No shell, no edits, nothing from the network, no subagents: the sessions it starts do the work.
      deny: ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"],
    };
  }

  /** Tells a chat about one of its sessions, through its queue (after its own turn, if one runs). */
  private async report(id: string, c: Child, body: string) {
    try {
      await this.ctx.sessions.queue(await this.follow(c.chat).catch(() => c.chat), FROM_TETHER + body);
    } catch (e) {
      this.ctx.log(`couldn't report ${id} to ${c.chat}: ${(e as Error).message}`);
    }
  }

  private async describe(id: string) {
    const look = await this.ctx.sessions.open(id).catch(() => undefined);
    return look ? `Session ${id} ("${look.summary.title || "Untitled"}" in ${look.summary.projectPath}, ${AGENT_NAMES[look.summary.harness] ?? look.summary.harness})` : `Session ${id}`;
  }

  /** The check-in waiting on a session's answer, if one is. */
  private waiting(id: string): [string, CheckIn] | undefined {
    for (const [k, b] of Object.entries(this.state.checkIns ?? {})) if (b.entries[id] && !b.entries[id]!.outcome) return [k, b];
    return undefined;
  }

  /** Starts a check-in from `chat`: asks the sessions that can answer now, and says who was asked. */
  async checkIn(chat: string, a: { project_path?: string; session_ids?: string[] }): Promise<string> {
    const s = this.ctx.sessions;
    // What Recent shows: top-level sessions that aren't archived, but the Home agent's own chats.
    const all = s.list().filter((r) => !r.archived && !r.parentSessionId && !this.isChat(r.id) && resolve(r.projectPath) !== resolve(this.folder));
    const project = a.project_path ? resolve(s.folder(a.project_path)) : undefined;
    const only = a.session_ids?.length ? new Set(a.session_ids) : undefined;
    const rows = all
      .filter((r) => (!project || resolve(r.projectPath) === project) && (!only || only.has(r.id)))
      .sort((x, y) => y.updatedAt - x.updatedAt);
    const entries: Record<string, Entry> = {};
    const asked: string[] = [];
    for (const r of rows) {
      const e: Entry = { title: r.title || "Untitled", project: r.projectPath };
      entries[r.id] = e;
      const why = this.waiting(r.id) ? "an earlier check-in is still waiting on it" : asked.length >= CHECKIN_MAX ? `only ${CHECKIN_MAX} sessions are asked at a time` : skipReason(r, this.ctx.session(r.id));
      if (why) {
        e.outcome = "skipped";
        e.reason = why;
      } else asked.push(r.id);
    }
    // Every recent session's folder, by repo: a session asked to clean up must leave the others' alone.
    const folders = [...new Set(all.map((r) => resolve(r.projectPath)))];
    const repos = new Map(await Promise.all(folders.map(async (f) => [f, await repoOf(f, this.git)] as const)));
    for (const sid of asked) {
      const own = resolve(entries[sid]!.project);
      const repo = repos.get(own);
      entries[sid]!.keep = repo ? folders.filter((f) => f !== own && repos.get(f) === repo) : [];
    }
    if (!rows.length) return project ? `No recent sessions in ${project} to check in with.` : "No recent sessions to check in with.";
    const id = `c${Date.now().toString(36)}`;
    const batch: CheckIn = { chat, at: Date.now(), deadline: Date.now() + this.waitMs, entries };
    this.state.checkIns = { ...this.state.checkIns, [id]: batch };
    this.save();
    for (const sid of asked) {
      try {
        await s.queue(sid, FROM_TETHER + checkInMessage(entries[sid]!.project, entries[sid]!.keep));
      } catch (e) {
        entries[sid]!.outcome = "skipped";
        entries[sid]!.reason = `couldn't send to it: ${(e as Error).message}`;
      }
    }
    this.save();
    const line = (sid: string) => `- ${sid} "${entries[sid]!.title}" (${entries[sid]!.project})${entries[sid]!.reason ? `: ${entries[sid]!.reason}` : ""}`;
    const sent = Object.keys(entries).filter((k) => !entries[k]!.outcome);
    const skipped = Object.keys(entries).filter((k) => entries[k]!.outcome === "skipped");
    if (!sent.length) {
      delete this.state.checkIns![id];
      this.save();
      return [`Asked nobody: no session could answer now.`, `Skipped (${skipped.length}):`, ...skipped.map(line)].join("\n");
    }
    this.arm(id);
    return [
      `Asked ${sent.length} session${sent.length === 1 ? "" : "s"}; you'll get one report when they've answered (at most ${Math.round(this.waitMs / 60_000)} minutes).`,
      ...sent.map(line),
      ...(skipped.length ? [`Skipped, not asked (${skipped.length}):`, ...skipped.map(line)] : []),
    ].join("\n");
  }

  private arm(id: string) {
    const b = this.state.checkIns?.[id];
    if (!b) return;
    clearTimeout(this.timers.get(id));
    const t = setTimeout(() => void this.finish(id), Math.max(0, b.deadline - Date.now()));
    t.unref?.();
    this.timers.set(id, t);
  }

  /** A session answered the check-in (its turn ended): judge it, and archive it when it's finished. */
  private async answered(batchId: string, id: string, error?: string, stopped?: boolean) {
    const b = this.state.checkIns?.[batchId];
    const e = b?.entries[id];
    if (!b || !e || e.outcome || this.judging.has(id)) return;
    // Not settled until it's judged (the report waits for it), but judged once.
    this.judging.add(id);
    try {
      await this.judge(e, id, error, stopped);
    } finally {
      this.judging.delete(id);
    }
    this.save();
    if (Object.values(b.entries).every((x) => x.outcome)) await this.finish(batchId);
  }

  /** Settles one answer: archived when it's finished, else kept with why. Set only at the end. */
  private async judge(e: Entry, id: string, error?: string, stopped?: boolean) {
    if (stopped) return Object.assign(e, { outcome: "kept", reason: "the person stopped it" });
    if (error) return Object.assign(e, { outcome: "kept", reason: `its turn failed: ${error}` });
    const answer = parseAnswer(lastReply(await this.ctx.sessions.recent(id, 10).catch(() => [] as Msg[])));
    const found = answer?.done && answer.merged ? await verify(e.project, answer, this.git, new Set(), e.keep).catch(() => undefined) : undefined;
    const v = judge(answer, found);
    if (!v.archive) return Object.assign(e, { outcome: "kept", reason: v.reason });
    try {
      await this.ctx.sessions.setArchived(id, true);
      Object.assign(e, { outcome: "archived", reason: v.reason });
    } catch (err) {
      Object.assign(e, { outcome: "kept", reason: `finished, but archiving failed: ${(err as Error).message}` });
    }
  }


  /** Reports a check-in to its chat and forgets it; those that haven't answered are reported so. */
  async finish(batchId: string) {
    const b = this.state.checkIns?.[batchId];
    if (!b) return;
    clearTimeout(this.timers.get(batchId));
    this.timers.delete(batchId);
    delete this.state.checkIns![batchId];
    this.save();
    const all = Object.entries(b.entries);
    for (const [, e] of all) if (!e.outcome) Object.assign(e, { outcome: "kept", reason: "no answer in time (it may still be working)" });
    const line = ([id, e]: [string, Entry]) => `- ${id} "${e.title}" (${e.project})${e.reason ? `: ${e.reason}` : ""}`;
    const of = (o: Entry["outcome"]) => all.filter(([, e]) => e.outcome === o);
    const [archived, kept, skipped] = [of("archived"), of("kept"), of("skipped")];
    const body = [
      `Check-in finished: ${archived.length + kept.length} session${archived.length + kept.length === 1 ? "" : "s"} asked.`,
      `Archived (${archived.length}):${archived.length ? "" : " none"}`,
      ...archived.map(line),
      `Not archived (${kept.length}):${kept.length ? "" : " none"}`,
      ...kept.map(line),
      ...(skipped.length ? [`Not asked (${skipped.length}):`, ...skipped.map(line)] : []),
      "Give the person a short summary: which were archived, and which weren't and why.",
    ].join("\n");
    try {
      await this.ctx.sessions.queue(b.chat, FROM_TETHER + body);
    } catch (e) {
      this.ctx.log(`couldn't report a check-in to ${b.chat}: ${(e as Error).message}`);
    }
  }

  async turnEnded(id: string, error?: string, stopped?: boolean) {
    // A check-in's answer isn't one of the session's reports.
    const w = this.waiting(id);
    if (w) return this.answered(w[0], id, error, stopped);
    const c = this.state.children[id];
    if (!c || c.released) return this.watchTurn(id, error, stopped);
    // The turn the agent's message waited behind: not its report (a Stop there is still the person's).
    if (c.queued && !stopped) return;
    if (stopped) {
      // The person pressed Stop: it's theirs now.
      c.released = "person";
      this.save();
      return;
    }
    c.reports++;
    const last = c.reports >= MAX_REPORTS;
    if (last) c.released = "limit";
    this.save();
    const reply = lastReply(await this.ctx.sessions.recent(id, 30).catch(() => [] as Msg[]));
    const lines = [
      `${await this.describe(id)} finished a turn${error ? ` with an error: ${error}` : "."}`,
      reply ? `Its last reply:\n<<<\n${cut(reply, REPLY_MAX)}\n>>>` : "It said nothing.",
      last
        ? `That's report ${MAX_REPORTS} of ${MAX_REPORTS}: you've stopped following this session and can't message it any more. Tell the person where it stands in one casual sentence.`
        : `Report ${c.reports} of ${MAX_REPORTS}. Keep it going with send_to_session if the task isn't done, or tell the person in one casual sentence: only what's notable or needs them (a decision, a failure, where the work is, e.g. a PR link). Don't say it works, tests pass or it was verified.`,
    ];
    await this.report(id, c, lines.join("\n\n"));
  }

  /**
   * A turn ended in a session the agent doesn't follow. Not news: the person stopped it, or it goes
   * straight on (messages queued, or background work it will come back from), or the person has it
   * open (they see it end). A failure always is.
   */
  private watchTurn(id: string, error?: string, stopped?: boolean) {
    if (stopped || !this.watchable(id)) return;
    const look = this.ctx.session(id)!;
    if (error) return this.noteWatched(id, { kind: "failed", detail: error });
    if (look.state.queue.length || look.background || look.requests.length || this.ctx.viewersOf(id).length) return;
    this.noteWatched(id, { kind: "finished" });
  }

  async needsPerson(id: string, what: string) {
    const w = this.waiting(id);
    if (w) {
      const e = w[1].entries[id]!;
      e.outcome = "kept";
      e.reason = `it's waiting for the person: ${what}`;
      this.save();
      if (Object.values(w[1].entries).every((x) => x.outcome)) await this.finish(w[0]);
    }
    const c = this.state.children[id];
    if (!c || c.released) {
      if (!w && this.watchable(id) && !this.ctx.viewersOf(id).length) this.noteWatched(id, { kind: "waiting", detail: oneLine(what, 300) });
      return;
    }
    await this.report(id, c, `${await this.describe(id)} is waiting for the person: ${what}. Only they can answer it, in that session. Tell them in one casual sentence.`);
  }

  /** Someone typed into a session the agent follows: it's theirs from now. Tether's own message going in starts the agent's turn. */
  personSpoke(id: string, msg: Msg) {
    const c = this.state.children[id];
    if (!c || c.released || msg.role !== "user") return;
    // A harness that hasn't parsed the marker yet shows Tether's own text as it was sent.
    if (msg.origin?.kind === "tether" || msg.parts.some((p) => p.type === "text" && p.text.startsWith(FROM_TETHER))) {
      if (c.queued) {
        delete c.queued;
        this.save();
      }
      return;
    }
    c.released = "person";
    delete c.queued;
    this.save();
  }
}

export const homeAgentModule: Module = {
  name: "homeAgent",
  start(ctx) {
    const folder = ctx.homeFolder;
    const hosts = ctx.sessions.adapters().filter((a) => a.agentSetup && HARNESSES.includes(a.id));
    if (!folder || !existsSync(folder) || !hosts.length) return;
    const agent = new HomeAgent(ctx, folder);
    const unsets = hosts.map((a) => a.agentSetup!(folder, (nativeId) => agent.setup(`${a.id}:${nativeId}`)));
    const unset = () => unsets.forEach((f) => f());

    ctx.ops.register("homeAgent", async () => {
      const sessionId = await agent.current();
      return { ...(sessionId ? { sessionId } : {}), folder, rev: agent.state.rev, settings: await agent.settings(), harnesses: agent.harnesses() };
    });
    ctx.ops.register("homeAgentSet", (a) => agent.set(a));
    ctx.ops.register("homeAgentWatch", (a) => agent.watch((a as { on?: unknown } | undefined)?.on));
    ctx.ops.register("homeAgentNew", () => agent.newChat());
    ctx.ops.register("homeAgentClear", () => agent.clear());

    const offs = [
      ctx.bus.on("turnEnded", ({ sessionId, error, stopped }) => void agent.turnEnded(sessionId, error, stopped)),
      ctx.bus.on("message", ({ sessionId, msg }) => agent.personSpoke(sessionId, msg)),
      ctx.bus.on("requestOpened", ({ request }) => void agent.needsPerson(request.sessionId, request.title || request.question || (request.tool ? `permission for ${request.tool}` : "a question"))),
      ctx.bus.on("attention", ({ sessionId, message }) => void agent.needsPerson(sessionId, message || "in its terminal")),
    ];
    return () => {
      agent.stop();
      unset();
      offs.forEach((off) => off?.());
    };
  },
};
