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
// Home shows its chats as tabs (`tabs`): each is its own Claude session, with its own turns, and
// several can run at once. A session a chat starts (or messages) reports to that chat. Watch reports
// go to one chat only, `current`: the tab the person last wrote in (or opened). Closing a tab
// (homeAgentClose; `/new` or `/clear` in it) archives that chat: it's stopped if it runs and lets go
// of the sessions it started (they keep going on their own, in the lists). Every change of the tabs
// or of `current` is broadcast, so each device's Home follows. Settings are one for all chats.
//
// The person can text it over iMessage (texting module, through homeLine.ts): their texts go to one
// tab, "Texts" (made when the first text comes, again if it was closed), marked as texted. Unless
// they turn "Reply by text" off, that chat's answer to a text goes back as a short text, and so does
// its answer to a finished-turn report from a session it started (the outcome: done with a link, or
// what it needs); a turn that only kept a session going, a watch report, a "waiting for the person"
// report (Tether texts the request itself) and tool calls aren't texted. Any chat can also text the
// person itself with text_person: it's the person's PM over text, so the sessions it drives don't
// text them; their text_person comes to it as a report (relay) and it decides what's worth a text,
// condensed. A Texts turn that texted isn't texted again at its end.

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { FROM_IMESSAGE, FROM_TETHER, FROM_TETHER_CHECKIN, fromTether, fromTexted, TEXTED_VIA, tetherPurpose } from "../../../../shared/fromTether";
import { replyForPeople } from "../../../../shared/checkIn";
import { statusLabel, type HarnessReport, type HarnessVersion } from "../../../../shared/harnessUpdates";
import { AGENT_NAMES, HARNESS_LABELS, type HarnessId, type Msg, type Request, type SessionSummary } from "../../../../shared/transcript";
import type { BillingSource, SourceOption } from "../../../../shared/credentials";
import { HOME_AGENT_MODE, type HomeAgentSettings } from "../../../../shared/protocol";
import { mapMode } from "../../../../shared/move";
import type { Adapter, AgentSetup, AgentTool } from "../../core/adapter";
import type { Module, ModuleContext } from "..";
import { heicNote, HOME_SENDER, homeLabel, MAX_EXTRA_HOMES, PERSON_TEXT_MAX, type Home, type HomeEnd, type HomeTarget, type TakeVia } from "../homeLine";
import { failureKind } from "../push";
import { levelOf } from "../move";
import { CHECKIN_MAX, CHECKIN_WAIT_MS, checkInMessage, judge, parseAnswer, repoOf, runGit, skipReason, stillRunning, systemProbe, verify, type Git, type Probe } from "./checkIn";
import type { CheckInRow, CheckInStatus } from "../../../../shared/protocol";

/** Text going inside a <<< >>> fence, unable to close or open one: any run of 3+ "<" or ">" becomes 2 (can't rebuild a run). */
export function unfence(s: string): string {
  return s.replace(/<{3,}/g, "<<").replace(/>{3,}/g, ">>");
}

/** Reports a session may send before the agent stops following it: a loop can't run forever. */
export const MAX_REPORTS = 12;
/** How much of a session's last reply a report carries (session_status has more; the transcript keeps it all). */
export const REPLY_MAX = 2000;
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
/*
 * The agent's own chats run in the mode the person picks (HomeAgentSettings.mode), auto unless they
 * pick another. Whatever the mode, Claude's tools that touch anything are taken away
 * (AgentSetup.deny) and Codex's shell, patch and web tools are switched off by config
 * (adapters/codex/setup.ts): the mode only decides what its remaining tools ask before using.
 */

/** list_sessions' filters. */
interface ListArgs {
  state?: SessionState | "active";
  project?: string;
  query?: string;
  archived?: boolean;
  limit?: number;
}

interface Child {
  /** the chat that started it, or last messaged it */
  chat: string;
  reports: number;
  /** the agent didn't start it: it took it on by messaging it */
  messaged?: boolean;
  /** the agent's message waits behind a turn that isn't the agent's: that turn's end isn't reported */
  queued?: boolean;
  /** the person stepped in, it hit MAX_REPORTS, or its chat was closed: no more reports (a new message follows it again, but past the limit) */
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

/** One "are you done?" round, from one chat, or from Home's "Archive done sessions" (no chat). */
interface CheckIn {
  /** the chat the report goes to; none: started from the button, the result is only kept (`lastCheckIn`) */
  chat?: string;
  at: number;
  /** when the sessions that haven't answered are reported as unanswered */
  deadline: number;
  entries: Record<string, Entry>;
}

interface State {
  /** the chat watch reports go to: the tab the person last wrote in or opened */
  current?: string;
  /** the open chats (Home's tabs), oldest first */
  tabs: string[];
  /** grows with each change of `current`, across restarts (HomeChatUpdate.rev) */
  rev: number;
  children: Record<string, Child>;
  /** what it runs on, as the person chose it; none: Claude Code on the source a new session gets */
  settings?: HomeAgentSettings;
  checkIns?: Record<string, CheckIn>;
  /** the last finished "Archive done sessions" check-in's result, for Home until it's dismissed (a chat's goes to the chat) */
  lastCheckIn?: CheckInStatus["last"];
  /** "Watch all sessions"; none: on */
  watchAll?: boolean;
  /** the tab the person's texts go to ("Texts"), once one came: the primary home, `h` */
  texts?: string;
  /** the other tabs' home numbers (h1, h2, …), by chat: kept while the tab is open, the lowest free one for a new tab */
  labels?: Record<string, number>;
  /** tabs other than Texts that the person has texted (or made by text): their answers go back by text too */
  textHomes?: string[];
  /** "Reply by text"; none: on */
  replyByText?: boolean;
}

/** What started the Texts chat's turn, and so whether its answer is texted. */
interface TextTurn {
  /** text: the person texted; report: a texted-work report; quiet: anything else (not texted) */
  kind: "text" | "report" | "quiet";
  /** its last words this turn */
  said?: string;
  /** it messaged a session this turn (keeping it going): a report's answer then isn't texted */
  nudged?: boolean;
  /** it texted the person itself this turn (text_person): its answer isn't texted again */
  texted?: boolean;
  /**
   * the sessions this turn acted on: started, messaged, or reported on (a report from it). Its texts
   * are about that session when it's exactly one; never about what the person's text was about.
   */
  acted?: string[];
}

/** The one session a turn acted on, if it acted on exactly one. */
const actedOn = (t: TextTurn | undefined) => (t?.acted?.length === 1 ? t.acted[0] : undefined);
const act = (t: TextTurn, id: string) => {
  if (!(t.acted ??= []).includes(id)) t.acted.push(id);
};

/** The session a report starts with (describe: "Session <id> (…"). */
const REPORT_ABOUT = /^Session (\S+) \(/;

/** A report whose answer goes back by text carries this line, for the agent and to tell it apart. */
export const TEXTED = "(Your reply to this report is texted to the person.)";
/** The Texts tab's title. */
export const TEXTS_TITLE = "Texts";

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
  const mode = typeof o.mode === "string" && o.mode.trim() ? o.mode.trim() : undefined;
  return { harness: o.harness as HarnessId, source: o.source as BillingSource, ...(model ? { model } : {}), ...(mode ? { mode } : {}) };
}

/** The end-goal question's options, as the person sees them (one line, fits a phone). */
export const END_GOALS = "1) open a PR (you review and merge), 2) merge directly (and deploy/restart if it needs it), or 3) adversarial review first (subagents try to break it), then PR or merge?";

/**
 * What a brief says when the person picks adversarial review: one subagent implements, at least two
 * independent ones try to break it, and it loops until they find nothing blocking.
 */
export const ADVERSARIAL_BRIEF = "Work as a team of subagents: one implementer subagent makes the change; then at least two independent reviewer subagents, each given the diff and the goal but not the implementer's reasoning, try to break it, looking for bugs, security problems and regressions (including running the tests and the build). Fix every blocking issue they find and have fresh reviewers check again; repeat until the reviewers find no blocking issues. Only then deliver: <the chosen delivery: open a PR / merge directly (and deploy/restart if needed)>. In your report, say what the reviewers found and what you fixed.";

export const INSTRUCTIONS = `You are Tether's Home agent. The person talks to you from Tether's home page. Your job is to turn what they ask for into a coding session in one of their projects, give it a strong first prompt, and see it through until the task is done.

How to work:
- Find the project with list_projects. Use project_overview when you need to know more about one. If more than one project could be meant, ask the person which in one short question. Never guess.
- Start the work with start_session. The prompt is everything the session knows, so write a complete brief: the goal, the context the person gave you (quote their words where it matters), constraints, and what done means (for example: tests pass, it builds, the change is committed on a branch, a PR is opened, etc. only if they asked for it). Tell it to work autonomously through to completion without stopping to ask for confirmation, to verify its work before finishing, and to end with a short report: what it delivered (the PR link, or the merged commit), and the worktree and branch it made, if any. The session runs with full permissions.
- The end goal: before starting a session that changes code, know what "done" means for it. If the person hasn't said, and it isn't clear from context or from a standing instruction (one earlier in this chat, for example "when any PR comes back, merge it and restart", or a project rule such as "gavinsonntag.com: only the foliation branch"), first ask one short question, offering these options on one line: "${END_GOALS}". Then put their answer in the brief. One quick question, never a list of them. Research, questions and other read-only tasks don't need it. If they say it holds from now on ("always do X for jungle"), it's a standing instruction for that project for the rest of this chat: don't ask again there.
- When the person picks adversarial review, the brief must spell out the workflow, in these words (with the chosen delivery filled in): "${ADVERSARIAL_BRIEF}"
- Use Claude Code unless the person asks for Codex. Leave the model at its default unless they name one.
- For questions about what's going on ("what's running?", "what's finished?", "is anything working on X?", "how is the session on Y doing?"), use list_sessions: it sees every session on this machine, whoever started it, with its state and what it's on. Filter by state or project rather than listing everything. Read one more closely with session_status.
- You can message any of those sessions with send_to_session, including ones you didn't start. Message a session you didn't start (or one the person has taken over) only when the person asks you to or it's part of the task they gave you, and say who it's from and what you need in the message. It goes now if the session is idle, else after its current turn; sessions that are waiting for the person or open in a terminal can't be messaged. Once you message one, you follow it like a session you started.
- Follow-ups on finished work ("tweak the site again", "one more fix on that PR"): revive the session that did it rather than starting a new one, since it has the context. Find it with list_sessions (archived: true finds archived ones; query searches titles and projects), then send_to_session: messaging an archived session unarchives it and sends. Start a new session only when no earlier one fits.
- After starting a session, tell the person in one casual sentence what you started and where. Don't poll: Tether sends you a report (a message starting with "[From Tether]") each time a session you started or messaged finishes a turn or needs the person.
- Tether also watches every other session on this machine for you (unless the person turned off "Watch all sessions"): when sessions you didn't start finish a turn, fail, or start waiting for the person, you get one short report ("[From Tether] Sessions you didn't start: ..."), several at once when they come close together. These aren't yours: don't message them unless the person asked you to. If one failed or is waiting for the person, tell them in one casual sentence which and what it needs. If one just finished, mention it only if the person was waiting on it or asked about it; otherwise reply with a few words at most. Sessions you started still get their own reports: keep those going until the task is done.
- On a report: if the session stopped early (it asked something you can answer from what the person said, stopped halfway, or says it's done but skipped verification), use send_to_session with a specific instruction to keep it going. If it needs a decision only the person can make, or it keeps failing, tell the person in one sentence and stop.
- Close the loop on sessions you started. When one reports its task done and verified, send it the wrap-up yourself, matching the end goal: merge (only if that was chosen, or a standing instruction authorizes it), then deploy or restart if the project needs it, then remove the worktree and branch it made (never the main checkout or another session's folder), and confirm each step. For "open a PR", tell the person the PR link and wait: the wrap-up comes once the person says it's merged (or tells you to merge it). Once the session confirms it's done, delivered and cleaned up, archive it with archive_session (why: "done") and tell the person in one casual sentence only what's notable (the PR link, or that it's merged and live). No separate check-in is needed for sessions you drove.
- When the person asks you to check in with their sessions ("ask all agents if they're done", "clean up finished sessions"), use check_in_sessions (with project_path if they name a project). It asks every session that is idle right now (in the last few days' list, not archived, not your own chats; sessions that are running a turn, waiting for the person, or open in a terminal are skipped, not interrupted) whether its task is done and all its work is merged or applied, and tells the finished ones to remove the git worktrees they made (never the main checkout or another session's folder) before they answer. Tether checks each answer against git and archives only the sessions that are done, merged and cleaned up; one that still has a worktree left is kept, with the reason. Tell the person in one sentence how many you asked; one report comes back when they've all answered (or after ${CHECKIN_WAIT_MS / 60_000} minutes). Then give a short summary: which were archived, and which weren't and why, one line each. Don't send the sessions anything else about it.
- archive_session: with why "done" only for a session you started, once it has confirmed it's done, delivered and cleaned up. Any other session only when the person asks to archive it (why "person_asked"), for example one the check-in kept. Never archive anyone else's session on your own judgment. An archived session isn't gone: send_to_session revives it.
- Never do the coding yourself. You have no shell and can't edit files.
- Texts: a message starting with "[From iMessage]" is the person texting you from their phone (one starting with "[From <app>]", like "[From Discord]", is them writing from that messaging app, the same thing), and your reply goes back to them as a text, the way it came. Keep it to a few words, mostly an acknowledgement ("ok, on it", "started the login fix in web-coder"), or the one question you need answered. A report that says "${TEXTED}" goes back as a text too: say only the outcome in a few words ("done: <PR link>", or what the session needs from them); if you're just keeping the session going, your reply isn't texted. Tether texts the person a session's own permission requests itself: don't repeat them.
- Replies to texts: when the person answers soon after one of your texts about a session, their message starts with "(replying to your text about session <id>, ...)". Assume they mean that same session: relay instructions there with send_to_session ("merge it", "yes do that", "try again") without asking which session, unless their words clearly name a different one or ask for something new. Files they send come as attachments (listed with their paths): forward the paths in your message when a session needs them.
- The person can text several of your chats: "h" is the Texts tab, "h1", "h2", … are your other tabs (they start one by texting "hn"), and each tab's texts go out marked with its name. Answer in the chat the text came to.
- You're the person's PM over text: text_person texts their phone (or whichever messaging app Tether reaches them on), and the sessions you start or message don't text them themselves (if one tries, its message comes to you as a report). Text them when they're away or prefer texts: they texted you (the chat started from a messaging app), they asked ("text me when the PR is merged": text once it is), or "Reply by text" is on and the news matters. What's worth a text: what needs them (a decision, a blocker, a failure), what shipped (with the link), and decisions you made for them. Batch several sessions' news into one text where you can; never text routine progress. One or two short sentences, outcome first. Your replies to their texts (and to reports marked as texted) already go back by text, so don't also call text_person for those. Their replies come back to your Texts tab: relay any instruction to the right session with send_to_session. When a text is about one session, pass its session_id to text_person so their reply is tied to it. text_person can send an image too (image: an absolute path), for a screenshot a session made.
- Every reply is at most one casual sentence, like a coworker texting (links are fine). Only say what's notable or what needs the person: a decision, a failure, where to find the work. Never confirm that something works, that tests pass, or that it was verified. No file lists, no cause analysis, no caveats, unless the person asks. Never paste or summarize a session's reply: they can open the session. The person reads you on a phone.`;

const text = (m: Msg) =>
  m.parts
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();

/** The newest assistant text in `msgs`, as the agent wrote it (a check-in's answer line and all). */
export function lastRawReply(msgs: Msg[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === "assistant" && text(m)) return text(m);
  }
  return undefined;
}

/** The newest assistant text in `msgs` as people read it: a check-in's answer line as its status (shared/checkIn.ts). */
export function lastReply(msgs: Msg[]): string | undefined {
  const r = lastRawReply(msgs);
  return r === undefined ? undefined : replyForPeople(r);
}

/** The newest prompt the session was given (the person's, or Tether's), without Tether's marker. */
export function lastPrompt(msgs: Msg[]): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== "user" || m.origin?.kind === "shell") continue;
    const t = text(m);
    // The check-in's long machine prompt as what it is (shared/fromTether.ts).
    if (t && (m.origin?.purpose === "checkIn" || tetherPurpose(t) === "checkIn" || (m.origin?.kind === "tether" && tetherPurpose(FROM_TETHER + t) === "checkIn"))) return CHECKIN_PROMPT;
    if (t) return fromTether(t) ?? t;
  }
  return undefined;
}

/** A check-in prompt, as lastPrompt gives it. */
export const CHECKIN_PROMPT = "(the Home agent's check-in: is the task done and merged?)";

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

export class HomeAgent implements HomeEnd {
  state: State = { rev: 0, tabs: [], children: {} };
  /** each texting chat's turn now (homes: the Texts tab and the tabs the person texted) */
  private textTurns = new Map<string, TextTurn>();
  /** the Texts tab being made (two texts at once make one) */
  private makingTexts?: Promise<string>;
  private file: string;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** a button check-in being started (it awaits git before it's saved): a second press waits for it */
  private starting?: Promise<unknown>;
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
    /** the machine, for checking what a session says is still running (tests replace it) */
    private probe: Probe = systemProbe,
  ) {
    this.file = join(ctx.dataDir, "state.json");
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      if (v && typeof v === "object") {
        const current = typeof v.current === "string" ? v.current : undefined;
        this.state = {
          current,
          // A state from before tabs: its one chat is the one tab.
          tabs: Array.isArray(v.tabs) ? [...new Set(v.tabs.filter((t: unknown): t is string => typeof t === "string" && !!t))] : current ? [current] : [],
          rev: Number.isSafeInteger(v.rev) ? v.rev : 0,
          children: v.children && typeof v.children === "object" ? v.children : {},
          ...(settingsOf(v.settings) ? { settings: settingsOf(v.settings) } : {}),
          checkIns: v.checkIns && typeof v.checkIns === "object" ? v.checkIns : {},
          ...(v.lastCheckIn && typeof v.lastCheckIn === "object" ? { lastCheckIn: v.lastCheckIn } : {}),
          ...(v.watchAll === false ? { watchAll: false } : {}),
          ...(typeof v.texts === "string" && v.texts ? { texts: v.texts } : {}),
          ...(v.labels && typeof v.labels === "object" ? { labels: Object.fromEntries(Object.entries(v.labels).filter(([k, n]) => typeof k === "string" && Number.isSafeInteger(n) && (n as number) > 0)) as Record<string, number> } : {}),
          ...(Array.isArray(v.textHomes) ? { textHomes: v.textHomes.filter((x: unknown): x is string => typeof x === "string") } : {}),
          ...(v.replyByText === false ? { replyByText: false } : {}),
        };
      }
    } catch {}
    this.label();
    // Check-ins a restart interrupted: their clocks start again (one already past reports now).
    for (const id of Object.keys(this.state.checkIns ?? {})) this.arm(id);
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    clearTimeout(this.watchTimer);
  }

  /**
   * "Watch all sessions" (default on); `on` changes it. Off drops what's waiting to be reported.
   * Answers with the sessions its chats follow too (the Home chat's "Waiting for N sessions").
   */
  watch(on?: unknown): { watchAll: boolean; following: string[] } {
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
    const following = Object.entries(this.state.children).flatMap(([id, c]) => (c.released ? [] : [id]));
    return { watchAll: this.state.watchAll !== false, following };
  }

  /** "Reply by text" (default on); `on` changes it. */
  replyByText(on?: unknown): { replyByText: boolean } {
    if (typeof on === "boolean") {
      if (on) delete this.state.replyByText;
      else this.state.replyByText = false;
      this.save();
    }
    return { replyByText: this.state.replyByText !== false };
  }

  // ── texts (homeLine.ts) ──

  /** Whether a chat is one the person texts: the Texts tab (h), or another home they texted. */
  isTextsChat(id: string): boolean {
    return (!!this.state.texts && this.state.texts === id) || !!this.state.textHomes?.includes(id);
  }

  /**
   * Gives every open tab but Texts a home number (h1, h2, …), keeping the ones they have: a new tab
   * takes the lowest free one. Drops the numbers (and text marks) of tabs that closed. Whether
   * anything changed.
   */
  private label(): boolean {
    const before = JSON.stringify([this.state.labels, this.state.textHomes]);
    const open = this.state.tabs.filter((t) => t !== this.state.texts);
    const labels: Record<string, number> = {};
    for (const t of open) if (this.state.labels?.[t]) labels[t] = this.state.labels[t]!;
    const used = new Set(Object.values(labels));
    for (const t of open) {
      if (labels[t]) continue;
      let n = 1;
      while (used.has(n)) n++;
      labels[t] = n;
      used.add(n);
    }
    this.state.labels = labels;
    this.state.textHomes = (this.state.textHomes ?? []).filter((t) => open.includes(t));
    return JSON.stringify([this.state.labels, this.state.textHomes]) !== before;
  }

  /** The open homes: h (the Texts tab, absent until a text makes it) and h1, h2, … (the other tabs). */
  homes(): Home[] {
    const texts = this.state.texts && this.state.tabs.includes(this.state.texts) ? this.state.texts : undefined;
    const rest = Object.entries(this.state.labels ?? {})
      .filter(([chat]) => this.state.tabs.includes(chat))
      .map(([chat, n]) => ({ n, chat }))
      .sort((a, b) => a.n - b.n);
    return [{ n: 0, ...(texts ? { chat: texts } : {}) }, ...rest];
  }

  /** Each open tab's home number (the Texts tab: 0), for Home's tabs. */
  labels(): Record<string, number> {
    return Object.fromEntries(this.homes().flatMap((h) => (h.chat ? [[h.chat, h.n]] : [])));
  }

  /** A new home (a new tab), texted: its number. Its first message, if any, goes in as the person's text. */
  async newHome(text: string, via: TakeVia = {}): Promise<number> {
    const { sessionId } = await this.newChat();
    (this.state.textHomes ??= []).push(sessionId);
    this.save();
    const files = via.files ? await via.files(sessionId) : [];
    if (text.trim() || files.length) await this.ctx.sessions.queue(sessionId, (via.mark ?? FROM_IMESSAGE) + (text.trim() || "(sent a file)") + heicNote(files), files);
    return this.state.labels?.[sessionId] ?? 0;
  }

  /** Deletes home `n` (by text): closes its tab (its chat is archived). The homes left. */
  async deleteHome(n: number): Promise<Home[]> {
    if (n === 0) throw new Error("h is your main home, so it can't be deleted");
    const h = this.homes().find((x) => x.n === n);
    if (!h?.chat) throw new Error(`there's no h${n}`);
    await this.close(h.chat);
    return this.homes();
  }

  /** A home's chat (none: the Texts chat) is running a turn or has messages waiting. */
  textsBusy(chat?: string): boolean {
    const id = chat ?? this.state.texts;
    if (!id || !this.state.tabs.includes(id)) return false;
    const look = this.ctx.session(id);
    const st = look?.state;
    return !!look && (look.status !== "idle" || look.busy || (st?.queue?.length ?? 0) > 0 || st?.mode === "terminal" || !!st?.queueHeld || !!st?.restartWait || !!this.textTurns.get(id));
  }

  /** A session it drives wanted to text the person: a report to its chat instead (homeLine.ts relay). */
  async relay(sessionId: string, message: string, image?: string): Promise<string | undefined> {
    // (The chat it reports to hears it as a report on that session: textsMessage.)
    const c = this.state.children[sessionId];
    if (!c || c.released) return undefined;
    const words = message.trim().slice(0, PERSON_TEXT_MAX * 4);
    // The image's path is the session's words like the rest: inside the fence, on one line, and
    // unable to close it. (text_person checks the file again before anything goes.)
    const pic = image ? `\nimage path: ${unfence(image.replace(/[\x00-\x1f\x7f\u2028\u2029]+/g, " ")).slice(0, 500)}` : "";
    await this.report(sessionId, c, `${await this.describe(sessionId)} wanted to text the person${image ? " (with the image on its last \"image path:\" line, which text_person's image sends on)" : ""}:\n<<<\n${unfence(words)}${pic}\n>>>\n\nIt wasn't texted. You're their PM over text: if it needs them (a decision, a blocker) or something shipped, text them with text_person (session_id ${sessionId}), condensed and with any other news; otherwise keep it for your next reply. Don't relay routine progress.`);
    return "Not texted: Tether's Home agent drives this session and texts the person for it. Your message went to it as a report. Don't text the person yourself; put outcomes and questions in your final reply.";
  }

  /**
   * The person texted the Home agent: to a home (none, or h: the Texts tab, made if it's gone; h1,
   * …: that tab, if it's open), as theirs (marked with the connector it came by), after its turn if
   * one runs, with the files they sent.
   */
  async take(text: string, via: TakeVia = {}, to?: HomeTarget): Promise<void> {
    const chat = await this.chatOf(to);
    if (!this.isTextsChat(chat)) {
      (this.state.textHomes ??= []).push(chat);
      this.save();
    }
    const files = via.files ? await via.files(chat) : [];
    await this.ctx.sessions.queue(chat, (via.mark ?? FROM_IMESSAGE) + text + heicNote(files), files);
  }

  /** The chat a text to a home goes to: h's Texts tab (made if it's gone), or that home's tab if it's open. */
  async chatOf(to?: HomeTarget): Promise<string> {
    const n = to && "n" in to ? to.n : undefined;
    const want = to && "chat" in to ? to.chat : undefined;
    if (!to || n === 0 || (want && want === this.state.texts)) return this.textsChat();
    const h = this.homes().find((x) => x.n !== 0 && (n !== undefined ? x.n === n : x.chat === want));
    if (!h?.chat) throw new Error(`there's no ${n !== undefined ? homeLabel(n) : "such home"}`);
    return this.follow(h.chat).catch(() => h.chat!);
  }

  /** The Texts tab: the one texts went to, else a new one (current once a text lands in it). */
  private async textsChat(): Promise<string> {
    const id = this.state.texts;
    if (id && this.state.tabs.includes(id)) {
      const at = await this.follow(id).catch(() => undefined);
      if (at) return at;
    }
    this.makingTexts ??= (async () => {
      const { harness, source, model, mode } = await this.settings();
      const permissionMode = await this.modeFor(harness, mode);
      const chat = await this.ctx.sessions.create({ harness, projectPath: this.folder, source, permissionMode, ...(model ? { model } : {}) });
      await this.ctx.sessions.rename(chat, TEXTS_TITLE).catch(() => {});
      this.state.texts = chat;
      this.state.tabs.push(chat);
      this.label();
      this.announce();
      return chat;
    })().finally(() => (this.makingTexts = undefined));
    return this.makingTexts;
  }

  /** What a texting chat hears and says this turn (the message event). */
  private textsMessage(chat: string, msg: Msg) {
    const t = this.turnOf(chat);
    if (msg.role === "assistant") {
      const said = text(msg);
      if (said) t.said = replyForPeople(said);
      return;
    }
    if (msg.role !== "user") return;
    const raw = text(msg);
    const texted = (!!msg.origin && Object.hasOwn(TEXTED_VIA, msg.origin.kind)) || (!msg.origin && !!fromTexted(raw));
    const tether = msg.origin?.kind === "tether" || (!msg.origin && fromTether(raw) !== undefined);
    const report = tether && raw.includes(TEXTED);
    if (texted) t.kind = "text";
    else if (report && t.kind === "quiet") t.kind = "report";
    // A report on a session: this turn acts on it. (What the person's text was about doesn't count:
    // they may be turning to something else.)
    const reported = tether ? REPORT_ABOUT.exec(fromTether(raw) ?? raw)?.[1] : undefined;
    if (reported) act(t, reported);
  }

  /** The Texts chat's turn ended: its answer goes back by text when the turn was a text's or a texted-work report's. */
  private async textsTurnEnded(chat: string, error?: string, stopped?: boolean) {
    const t = this.textTurns.get(chat);
    this.textTurns.delete(chat);
    const phone = this.ctx.homeLine?.phone;
    if (!t || t.kind === "quiet" || stopped || !phone || this.state.replyByText === false) return;
    if (t.kind === "report" && t.nudged && !error) return;
    if (t.texted && !error) return;
    const words = error ? `Couldn't do that: ${failureKind(error)}.` : t.said;
    if (!words) return;
    // Only the answer to a text the person sent may go back to where they wrote it (a channel others
    // read); a report's outcome goes to them privately. It's about the one session the turn acted on.
    const about = error ? undefined : actedOn(t);
    await phone
      .send(words, { answer: t.kind === "text" && !error, ...(about ? { about } : {}), ...(chat === this.state.texts ? {} : { chat }) })
      .catch((e) => this.ctx.log(`couldn't text the person: ${(e as Error).message}`));
  }

  /** A texting chat's turn now (made when something happens in it). */
  private turnOf(chat: string): TextTurn {
    let t = this.textTurns.get(chat);
    if (!t) this.textTurns.set(chat, (t = { kind: "quiet" }));
    return t;
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

  /** `current` becomes `id` (none: no tab), saved and told to every browser with the tabs. */
  private setCurrent(id: string | undefined) {
    this.state.current = id;
    return this.announce();
  }

  /** Saves, and tells every browser the tabs and `current`. */
  private announce() {
    // A clock-based rev stays ahead of what browsers saw even if state.json was lost.
    this.state.rev = Math.max(this.state.rev + 1, Date.now());
    this.save();
    this.ctx.announceHomeChat?.({ ...(this.state.current ? { sessionId: this.state.current } : {}), chats: [...this.state.tabs], labels: this.labels(), rev: this.state.rev });
    return this.state.rev;
  }

  /**
   * The open tabs, each where it went on (a move), without those that are gone: a chat created but
   * never sent to has nothing stored, so it can't open after a restart.
   */
  async chats(): Promise<string[]> {
    const out: string[] = [];
    let changed = false;
    for (const id of [...this.state.tabs]) {
      const at = await this.follow(id).catch(() => undefined);
      if (at && !out.includes(at)) out.push(at);
      else changed = true;
    }
    if (changed || out.some((id, i) => id !== this.state.tabs[i])) {
      this.state.tabs = out;
      this.label();
      if (this.state.current && !out.includes(this.state.current)) this.state.current = out.at(-1);
      this.announce();
    }
    return out;
  }

  /** The person wrote in a chat: watch reports go there from now. */
  private touched(id: string) {
    if (this.state.current === id || !this.state.tabs.includes(id)) return;
    this.setCurrent(id);
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

  /** A chat went on in `to`: its tab is `to`'s, it's current if `from` was, and the sessions `from` started report there. */
  private moved(from: string, to: string) {
    for (const c of Object.values(this.state.children)) if (c.chat === from) c.chat = to;
    const tabs = this.state.tabs.map((t) => (t === from ? to : t));
    this.state.tabs = tabs.filter((t, i) => tabs.indexOf(t) === i);
    if (this.state.current === from) this.state.current = to;
    if (this.state.texts === from) this.state.texts = to;
    if (this.state.labels?.[from]) {
      this.state.labels[to] = this.state.labels[from]!;
      delete this.state.labels[from];
    }
    if (this.state.textHomes?.includes(from)) this.state.textHomes = this.state.textHomes.map((t) => (t === from ? to : t));
    this.label();
    // Replies to its texts follow it (texting's router keeps them by chat).
    this.ctx.homeLine?.phone?.moved?.(from, to);
    this.announce();
  }

  /** The harnesses that can run it here: the runner has them, and they take Tether's tools. */
  harnesses(): HarnessId[] {
    return this.ctx.sessions.adapters().filter((a) => a.agentSetup && HARNESSES.includes(a.id)).map((a) => a.id);
  }

  /** What it runs on: the person's choice, else Claude Code (or what there is) on the source a new session gets. */
  async settings(): Promise<HomeAgentSettings> {
    const have = this.harnesses();
    const set = this.state.settings;
    if (set && have.includes(set.harness)) return { ...set, mode: set.mode ?? HOME_AGENT_MODE };
    const harness = have.includes("claude") ? "claude" : (have[0] ?? "claude");
    return { harness, source: (await this.ctx.sessions.sources(harness)).default ?? "subscription", mode: HOME_AGENT_MODE };
  }

  /**
   * The mode a chat on `harness` runs in for `asked` (none: auto): the mode itself when the harness
   * offers it, else (auto on a Claude Code or model without it) the loosest mode at or below it, as a
   * move maps modes. A harness that can't list its modes gets it as asked.
   */
  async modeFor(harness: HarnessId, asked: string | undefined): Promise<string> {
    const mode = asked ?? HOME_AGENT_MODE;
    const a = this.adapter(harness);
    const offered = (await a?.listModels().catch(() => undefined))?.permissionModes.map((m) => m.id);
    if (!a || !offered?.length || offered.includes(mode)) return mode;
    const level = levelOf(a, mode);
    if (level === undefined || !a.move?.modes.length) throw new Error(`${HARNESS_LABELS[harness]} has no mode ${mode}.`);
    const usable = a.move.modes.filter((m) => offered.includes(m.mode));
    return mapMode(level, usable.length ? usable : a.move.modes);
  }

  async newChat(): Promise<{ sessionId: string; rev: number }> {
    // The slot is taken before anything is awaited: two at once can't both get the last one.
    if (this.homes().filter((h) => h.n !== 0).length + this.making >= MAX_EXTRA_HOMES)
      throw new Error(`At most ${MAX_EXTRA_HOMES} Home tabs besides Texts (h1 to h${MAX_EXTRA_HOMES}): close one first.`);
    this.making++;
    try {
      const { harness, source, model, mode } = await this.settings();
      const permissionMode = await this.modeFor(harness, mode);
      const id = await this.ctx.sessions.create({ harness, projectPath: this.folder, source, permissionMode, ...(model ? { model } : {}) });
      this.state.tabs.push(id);
      this.label();
      return { sessionId: id, rev: this.setCurrent(id) };
    } finally {
      this.making--;
    }
  }
  /** new tabs being made now (newChat): they count against the cap */
  private making = 0;

  /**
   * Puts every open chat on the chosen mode if it runs in another, between turns: a chat from
   * before the mode could be chosen ran in "Ask first" (or Codex's read only), and none chosen is auto.
   */
  async alignMode(): Promise<void> {
    for (const id of await this.chats()) await this.alignOne(id).catch((e) => this.ctx.log(`couldn't set ${id}'s mode: ${(e as Error).message}`));
  }

  private async alignOne(id: string): Promise<void> {
    const look = await this.ctx.sessions.open(id).catch(() => undefined);
    if (!look || look.status !== "idle") return;
    const { harness, mode } = await this.settings();
    if (look.summary.harness !== harness) return;
    const want = await this.modeFor(harness, mode);
    if (look.state.permissionMode !== want) await this.ctx.ops.call("setPermissionMode", { sessionId: id, mode: want });
  }

  /**
   * Keeps `asked` for every chat to come, and puts the chat in view (`sessionId`, an open tab; else
   * the current one) on it: the model at once,
   * Claude's source from its next start (the same session), and anything else (another harness, or
   * a Codex source, which needs a new thread) by a move, a new chat with the whole conversation.
   * The move needs the chat idle; until something is applied nothing is saved.
   */
  async set(asked: unknown): Promise<{ sessionId?: string; settings: HomeAgentSettings; rev: number }> {
    const inView = (asked as { sessionId?: unknown } | undefined)?.sessionId;
    const next = settingsOf(asked);
    if (!next) throw new Error("Pick an agent and a source.");
    if (!this.harnesses().includes(next.harness)) throw new Error(`${HARNESS_LABELS[next.harness]} can't run the Home agent on this runner.`);
    const mode = await this.modeFor(next.harness, next.mode);
    next.mode = mode;
    const sources = await this.ctx.sessions.sources(next.harness);
    // A runner with no choice of source: its harness's own login.
    const option = sources.options.length ? sources.options.find((o) => o.source === next.source) : next.source === "subscription" ? ({ source: next.source } as SourceOption) : undefined;
    if (!option) throw new Error(`${this.adapter(next.harness)?.billing?.label(next.source).label ?? next.source} isn't set up on this runner.`);
    const deployments = option.deployments?.map((d) => d.name) ?? (option.deployment ? [option.deployment] : undefined);
    if (deployments && !(next.model && deployments.includes(next.model))) {
      if (!deployments[0]) throw new Error("Add an Azure deployment in Credentials first.");
      next.model = deployments[0];
    }
    let id = typeof inView === "string" && this.state.tabs.includes(inView) ? await this.follow(inView).catch(() => undefined) : await this.current();
    if (id) {
      const look = await this.ctx.sessions.open(id);
      const s = this.ctx.sessions;
      const sameHarness = look.summary.harness === next.harness;
      const own = await s.sourceOf(id);
      const capabilities = this.adapter(next.harness)?.capabilities;
      if (!sameHarness || (next.source !== own && !(capabilities?.sourceSwitch && !capabilities.sourceCarry))) {
        const moved = await this.ctx.ops.call("moveSession", { sessionId: id, harness: next.harness, source: next.source, ...(next.model ? { model: next.model } : {}) });
        await this.ctx.ops.call("setPermissionMode", { sessionId: moved.sessionId, mode }).catch((e) => this.ctx.log(`couldn't set the moved chat's mode: ${(e as Error).message}`));
        this.moved(id, moved.sessionId);
        id = moved.sessionId;
      } else {
        if (next.model && next.model !== look.state.model) await this.ctx.ops.call("setModel", { sessionId: id, model: next.model });
        if (mode !== look.state.permissionMode) await this.ctx.ops.call("setPermissionMode", { sessionId: id, mode });
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
   * Closes a tab (none: the current one; `/new` and `/clear` from a Home from before tabs): the chat
   * is archived, its history kept. It's stopped if it runs, and the sessions it started go on
   * without it: a report would wake a chat nobody sees. Watch reports go to the newest tab left.
   */
  async close(sessionId?: unknown): Promise<{ rev: number }> {
    const old = typeof sessionId === "string" && sessionId ? sessionId : this.state.current;
    if (!old || (!this.isChat(old) && !this.state.tabs.includes(old))) return { rev: this.state.rev };
    for (const c of Object.values(this.state.children)) if (c.chat === old && !c.released) c.released = "cleared";
    const look = this.ctx.session(old);
    if (look && look.status !== "idle") await this.ctx.sessions.interrupt(old).catch((e) => this.ctx.log(`couldn't stop ${old}: ${(e as Error).message}`));
    this.state.tabs = this.state.tabs.filter((t) => t !== old);
    if (this.state.current === old) this.state.current = this.state.tabs.at(-1);
    // The next text makes a new Texts tab.
    if (this.state.texts === old) delete this.state.texts;
    this.label();
    const rev = this.announce();
    // Nothing stored yet (never sent to): there's nothing to archive.
    if (look || (await this.ctx.sessions.open(old).catch(() => undefined))) await this.ctx.sessions.setArchived(old, true).catch((e) => this.ctx.log(`couldn't archive ${old}: ${(e as Error).message}`));
    return { rev };
  }

  /** Whether `id` is one of the Home agent's own chats. */
  isChat(id: string) {
    const look = this.ctx.session(id);
    return !!look && resolve(look.summary.projectPath) === resolve(this.folder);
  }

  /**
   * send_to_session: any session the lists show (or an archived one, which it revives: unarchived,
   * then sent), but the agent's own chats and subagents. It's refused when it can't take a message
   * from Tether now (open in a terminal, waiting for the person); a turn that runs just means after it. The chat follows it from then on, as one
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
    if (look.summary.mode === "terminal" || look.state.mode === "terminal" || look.state.terminal) throw new Error("That session is open in a terminal: the person is working in it there. Leave it to them.");
    if (look.requests.length || look.state.requests.length) throw new Error(`That session is waiting for the person${look.state.requests[0] ? ` (${asks(look.state.requests[0])})` : ""}. Only they can answer it, in that session.`);
    if (look.summary.queuePaused || look.state.queueHeld) throw new Error("That session's queue is paused (after a Stop, a failure or a restart): it waits for the person.");
    // Its next turn's end would be read as its check-in answer.
    if (this.waiting(id)) throw new Error("That session is answering your check-in: wait for the check-in report.");
    // An archived session is revived: back in the lists, then the message goes.
    const revived = !!look.summary.archived;
    if (revived) await s.setArchived(id, false);
    // Behind a turn (or messages) that isn't this one's: that turn's end isn't the report.
    // A rate limit retry waiting is the previous turn, not over yet.
    const behind = look.status !== "idle" || look.state.queue.length > 0 || !!look.state.retry;
    const next: Child = c?.chat === chat && !c.released ? c : { chat, reports: 0, ...(c && !c.messaged ? {} : { messaged: true }) };
    if (behind) next.queued = true;
    this.state.children[id] = next;
    this.save();
    await s.queue(id, FROM_TETHER + message).catch(async (e) => {
      if (revived) await s.setArchived(id, true).catch(() => {});
      if (next === c) delete next.queued;
      else if (c) this.state.children[id] = c;
      else delete this.state.children[id];
      this.save();
      throw e;
    });
    return (revived ? "Unarchived it. " : "") + (behind ? "Queued: it goes after the session's current turn. You'll get a report when your message's turn finishes." : "Sent. You'll get a report when it finishes the turn.");
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
          if (this.isTextsChat(chat)) act(this.turnOf(chat), id);
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
          "Every coding session on this machine, whoever started it: active in the last 3 days, or running now (archived: true lists the archived ones instead, of any age). Newest activity first. Each line: id, title, project, agent, state (running, waiting on you, finished, failed), last active, and what it's on (its latest prompt or reply). Use for \"what's running?\", \"what's finished?\", \"is anything working on X?\", and to find a finished session to revive for a follow-up.",
        input: {
          state: z.enum(["running", "waiting", "finished", "failed", "active"]).optional().describe("Only sessions in this state. active = running or waiting on you."),
          project: z.string().optional().describe("Only this project: its folder (from list_projects) or the folder's name."),
          query: z.string().optional().describe("Only sessions whose title or project name contains this (any case)."),
          archived: z.boolean().optional().describe("true: only archived sessions (finished work you can revive with send_to_session)."),
          limit: z.number().int().min(1).max(LIST_MAX).optional().describe(`How many (default ${LIST_DEFAULT}, at most ${LIST_MAX}).`),
        },
        run: async (a: ListArgs) => this.listSessions(a),
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
            look.summary.queuePaused ? "Its queue is paused (after a Stop, a failure or a restart): it waits for the person." : "",
            look.state.queue.length ? `${look.state.queue.length} message${look.state.queue.length === 1 ? "" : "s"} queued.` : "",
            !mine
              ? "You didn't start it. You can message it with send_to_session when the person asks you to; you'd then get its reports."
              : c.released === "person"
                ? "The person has taken this session over: leave it to them unless they ask you to message it."
                : c.released === "limit"
                  ? "You've stopped following it (report limit)."
                  : c.released === "cleared"
                    ? "Your chat was closed; you've stopped following it."
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
        description:
          "Archives a session (keeps it out of Recent; it stays searchable, and send_to_session revives it), as the archive button does. why \"done\": a session you started that has confirmed it's done, delivered and cleaned up. why \"person_asked\": any session, only when the person asked to archive it.",
        input: { session_id: z.string(), why: z.enum(["done", "person_asked"]).describe("done: your own finished session; person_asked: the person asked for this one.") },
        run: async (a: { session_id: string; why: "done" | "person_asked" }) => {
          const said = await this.archive(chat, a.session_id, a.why);
          if (this.isTextsChat(chat)) act(this.turnOf(chat), a.session_id.trim());
          return said;
        },
      },
      {
        name: "send_to_session",
        description:
          "Sends a message to any session (an id from list_sessions or start_session), whoever started it: it goes now if the session is idle, else after its current turn. You get a report when that turn finishes, and you follow the session from then on. An archived session is unarchived and gets the message: use that to revive the session that did the work for a follow-up. Refused for sessions that are open in a terminal or waiting for the person. Message a session you didn't start only when the person asks you to or their task needs it.",
        input: { session_id: z.string(), message: z.string().min(1) },
        run: async (a: { session_id: string; message: string }) => {
          const said = await this.message(chat, a.session_id, a.message);
          if (this.isTextsChat(chat)) {
            const t = this.turnOf(chat);
            t.nudged = true;
            act(t, a.session_id.trim());
          }
          return said;
        },
      },
      {
        name: "text_person",
        description: `Texts the person in the messaging app Tether reaches them on, as "[home] <message>". One short sentence (cut at ${PERSON_TEXT_MAX} characters). Their reply comes back to your Texts tab. Pass session_id when the text is about one session: a reply right after it comes to you marked as about that session. Optionally send one image after the text (image: its absolute path; PNG, JPEG, GIF, WebP or HEIC, at most 10 MB; where the app takes images). Not for answering their texts: those replies are texted already.`,
        input: {
          message: z.string().min(1).describe("The text: one short sentence."),
          session_id: z.string().optional().describe("The session the text is about, if it's about one."),
          image: z.string().optional().describe("The absolute path of an image file to send after the text."),
        },
        run: async (a: { message: string; session_id?: string; image?: string }) => {
          const phone = this.ctx.homeLine?.phone;
          if (!phone) throw new Error("Texting is off in Tether, so nothing was sent. Say it in your reply instead.");
          // What it's about: the session it names (it must exist), else the one session this turn acted on.
          const named = a.session_id?.trim();
          if (named && (this.isChat(named) || !(this.ctx.session(named) ?? (await this.ctx.sessions.open(named).catch(() => undefined)))))
            throw new Error(`There's no session ${named.slice(0, 200)}: pass an id from list_sessions, or leave session_id out. Nothing was sent.`);
          const about = named || (this.isTextsChat(chat) ? actedOn(this.textTurns.get(chat)) : undefined);
          const r = await phone.text(HOME_SENDER, a.message, { ...(about ? { about } : {}), ...(a.image?.trim() ? { image: a.image.trim() } : {}), ...(chat !== this.state.texts ? { chat } : {}) });
          if (r.isError) throw new Error(r.text);
          if (this.isTextsChat(chat)) this.turnOf(chat).texted = true;
          return r.text;
        },
      },
      {
        name: "check_harness_updates",
        description: "Whether the coding agents installed on this machine (Claude Code, Codex, Tether's Claude Agent SDK) have newer versions out: installed vs latest, and how each was installed. Read-only: updates are run by the person from Settings → Updates.",
        input: { refresh: z.boolean().optional().describe("Look again instead of using the last few minutes' check.") },
        run: async (a: { refresh?: boolean }) => harnessUpdateLines(await this.ctx.ops.call("harnessVersions", { refresh: a.refresh === true })),
      },
    ];
  }

  /** list_sessions: every listed session but the Home agent's own chats and subagents, filtered. */
  async listSessions(a: ListArgs): Promise<string> {
    const s = this.ctx.sessions;
    const q = a.query?.trim().toLowerCase();
    const rows = (a.archived ? await s.archived() : s.list().filter((r) => !r.archived))
      .filter((r) => !r.parentSessionId && resolve(r.projectPath) !== resolve(this.folder))
      .filter((r) => !q || (r.title || "").toLowerCase().includes(q) || basename(r.projectPath).toLowerCase().includes(q))
      .map((r) => ({ r, st: stateOf(r, this.ctx.session(r.id)?.state.error) }))
      .filter(({ r, st }) => (!a.state || (a.state === "active" ? st === "running" || st === "waiting" : st === a.state)) && (!a.project || inProject(r.projectPath, a.project)));
    if (!rows.length) return `No${a.archived ? " archived" : ""} sessions${a.state ? ` ${a.state === "active" ? "running or waiting on you" : STATE_LABELS[a.state]}` : ""}${a.project ? ` in ${a.project}` : ""}${q ? ` matching "${a.query!.trim()}"` : ""}.`;
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
        const head = `${r.id} · "${oneLine(r.title || "Untitled", 60)}" · ${project} · ${AGENT_NAMES[r.harness] ?? r.harness} · ${r.archived ? "archived" : STATE_LABELS[st]} · ${ago(r.updatedAt)}`;
        return on ? `${head}\n  ${oneLine(on, LINE_MAX)}` : head;
      }),
    );
    const more = rows.length > page.length ? `\n(${page.length} of ${rows.length}: filter by state or project, or raise limit)` : "";
    return lines.join("\n") + more;
  }

  /**
   * archive_session. "done": only a session this chat started (not one it took on by messaging it,
   * nor one the person has taken over), and not while it's working or waiting for the person.
   * "person_asked": any session but the agent's own chats.
   */
  async archive(chat: string, sessionId: unknown, why: unknown): Promise<string> {
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("session_id is required.");
    const id = sessionId.trim();
    if (this.isChat(id)) throw new Error("That's one of your own chats.");
    if (why !== "done" && why !== "person_asked") throw new Error('why must be "done" or "person_asked".');
    if (why === "done") {
      const c = this.state.children[id];
      if (!c || c.chat !== chat || c.messaged) throw new Error("You didn't start that session: archive it only if the person asks you to (why: person_asked).");
      if (c.released === "person") throw new Error("The person has taken that session over: archive it only if they ask you to.");
      const look = await this.ctx.sessions.open(id).catch(() => undefined);
      if (!look) throw new Error(`There's no session ${id}.`);
      if (look.status !== "idle" || look.requests.length || look.state.requests.length || look.state.queue.length) throw new Error("That session isn't finished: it's still working, has messages queued, or waits for the person.");
    }
    await this.ctx.sessions.setArchived(id, true);
    return `Archived ${await this.describe(id)}. send_to_session revives it if it's needed again.`;
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

  /** Whether a chat's answers to its reports go back by text: it's the Texts tab and "Reply by text" is on. */
  private texted(chat: string) {
    return this.isTextsChat(chat) && this.state.replyByText !== false && !!this.ctx.homeLine?.phone;
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
    const { id, entries, project } = await this.begin(chat, a);
    if (!Object.keys(entries).length) return project ? `No recent sessions in ${project} to check in with.` : "No recent sessions to check in with.";
    const line = (sid: string) => `- ${sid} "${entries[sid]!.title}" (${entries[sid]!.project})${entries[sid]!.reason ? `: ${entries[sid]!.reason}` : ""}`;
    const sent = Object.keys(entries).filter((k) => !entries[k]!.outcome);
    const skipped = Object.keys(entries).filter((k) => entries[k]!.outcome === "skipped");
    if (!id) return [`Asked nobody: no session could answer now.`, `Skipped (${skipped.length}):`, ...skipped.map(line)].join("\n");
    return [
      `Asked ${sent.length} session${sent.length === 1 ? "" : "s"}; you'll get one report when they've answered (at most ${Math.round(this.waitMs / 60_000)} minutes).`,
      ...sent.map(line),
      ...(skipped.length ? [`Skipped, not asked (${skipped.length}):`, ...skipped.map(line)] : []),
    ].join("\n");
  }

  /**
   * "Archive done sessions" on Home (the homeAgentCheckIn op): the same check-in as
   * check_in_sessions, over every recent session, with no chat. Its result is kept for Home to show
   * (`lastCheckIn`) instead of going to a chat. A press while one runs (from any device or chat)
   * just answers where that one stands.
   */
  async checkInFromHome(a: { start?: boolean; dismiss?: boolean } = {}): Promise<CheckInStatus> {
    if (a.dismiss && this.state.lastCheckIn) {
      delete this.state.lastCheckIn;
      this.save();
    }
    if (a.start) {
      if (this.starting) await this.starting.catch(() => {});
      else if (!this.runningCheckIn()) {
        this.starting = this.begin(undefined, {}).then(({ id, entries }) => {
          // Nobody could be asked (or there's nobody): that's the result already.
          if (!id) this.keepResult(`c${Date.now().toString(36)}`, Date.now(), entries);
        });
        try {
          await this.starting;
        } finally {
          this.starting = undefined;
        }
      }
    }
    return this.checkInStatus();
  }

  /** The newest check-in still waiting on answers, if one is. */
  private runningCheckIn(): [string, CheckIn] | undefined {
    return Object.entries(this.state.checkIns ?? {}).sort(([, x], [, y]) => y.at - x.at)[0];
  }

  checkInStatus(): CheckInStatus {
    const r = this.runningCheckIn();
    const running = r && {
      id: r[0],
      at: r[1].at,
      deadline: r[1].deadline,
      asked: Object.values(r[1].entries).filter((e) => e.outcome !== "skipped").length,
      answered: Object.values(r[1].entries).filter((e) => e.outcome === "archived" || e.outcome === "kept").length,
    };
    return { ...(running ? { running } : {}), ...(this.state.lastCheckIn ? { last: this.state.lastCheckIn } : {}) };
  }

  /** Keeps a settled check-in's result as the last one, for Home. */
  private keepResult(id: string, at: number, entries: Record<string, Entry>) {
    const rows = (o: Entry["outcome"]): CheckInRow[] =>
      Object.entries(entries)
        .filter(([, e]) => e.outcome === o)
        .map(([sid, e]) => ({ id: sid, title: e.title, project: e.project, ...(e.reason ? { reason: e.reason } : {}) }));
    this.state.lastCheckIn = { id, at, archived: rows("archived"), kept: rows("kept"), skipped: rows("skipped") };
    this.save();
  }

  /**
   * Starts a check-in: settles who can't be asked now (skipped, with why) and asks the rest. No
   * `id`: nobody was asked, and nothing is waiting.
   */
  private async begin(chat: string | undefined, a: { project_path?: string; session_ids?: string[] }): Promise<{ id?: string; entries: Record<string, Entry>; project?: string }> {
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
    if (!rows.length) return { entries, project };
    const id = `c${Date.now().toString(36)}`;
    const batch: CheckIn = { ...(chat ? { chat } : {}), at: Date.now(), deadline: Date.now() + this.waitMs, entries };
    this.state.checkIns = { ...this.state.checkIns, [id]: batch };
    this.save();
    for (const sid of asked) {
      try {
        await s.queue(sid, FROM_TETHER_CHECKIN + checkInMessage(entries[sid]!.project, entries[sid]!.keep));
      } catch (e) {
        entries[sid]!.outcome = "skipped";
        entries[sid]!.reason = `couldn't send to it: ${(e as Error).message}`;
      }
    }
    this.save();
    if (!Object.values(entries).some((e) => !e.outcome)) {
      delete this.state.checkIns![id];
      this.save();
      return { entries, project };
    }
    this.arm(id);
    return { id, entries, project };
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
    const answer = parseAnswer(lastRawReply(await this.ctx.sessions.recent(id, 10).catch(() => [] as Msg[])));
    const found = answer?.done && (answer.merged || answer.nothingToMerge) ? await verify(e.project, answer, this.git, new Set(), e.keep).catch(() => undefined) : undefined;
    const running = answer ? await stillRunning(answer, this.probe, e.project).catch(() => answer.running) : undefined;
    const v = judge(answer, found, running);
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
    // From Home's button: its result is kept for Home to show, and no chat hears of it.
    if (!b.chat) return this.keepResult(batchId, b.at, b.entries);
    const body = [
      `Check-in finished: ${archived.length + kept.length} session${archived.length + kept.length === 1 ? "" : "s"} asked.`,
      `Archived (${archived.length}):${archived.length ? "" : " none"}`,
      ...archived.map(line),
      `Not archived (${kept.length}):${kept.length ? "" : " none"}`,
      ...kept.map(line),
      ...(skipped.length ? [`Not asked (${skipped.length}):`, ...skipped.map(line)] : []),
      "Give the person a short summary: which were archived, and which weren't and why.",
      ...(this.texted(b.chat) ? [TEXTED] : []),
    ].join("\n");
    try {
      await this.ctx.sessions.queue(b.chat, FROM_TETHER + body);
    } catch (e) {
      this.ctx.log(`couldn't report a check-in to ${b.chat}: ${(e as Error).message}`);
    }
  }

  async turnEnded(id: string, error?: string, stopped?: boolean) {
    if (this.isTextsChat(id)) return this.textsTurnEnded(id, error, stopped);
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
      reply ? `Its last reply:\n<<<\n${unfence(cut(reply, REPLY_MAX))}\n>>>${reply.length > REPLY_MAX ? "\n(session_status shows more.)" : ""}` : "It said nothing.",
      last
        ? `That's report ${MAX_REPORTS} of ${MAX_REPORTS}: you've stopped following this session and can't message it any more. Tell the person where it stands in one casual sentence.`
        : `Report ${c.reports} of ${MAX_REPORTS}. Keep it going with send_to_session if the task isn't done; if it is, send the wrap-up for its end goal (merge if chosen, deploy/restart if needed, remove its worktree and branch) and archive it once it confirms; or tell the person in one casual sentence: only what's notable or needs them (a decision, a failure, where the work is, e.g. a PR link). Don't say it works, tests pass or it was verified.`,
      ...(this.texted(c.chat) ? [TEXTED] : []),
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

  /**
   * Someone typed into a session the agent follows: it's theirs from now. Tether's own message going
   * in starts the agent's turn. The person writing in a chat makes it the one watch reports go to.
   */
  personSpoke(id: string, msg: Msg) {
    if (this.isTextsChat(id)) this.textsMessage(id, msg);
    if (msg.role === "user" && msg.origin?.kind !== "tether" && !msg.parts.some((p) => p.type === "text" && fromTether(p.text) !== undefined) && this.state.tabs.includes(id)) this.touched(id);
    const c = this.state.children[id];
    if (!c || c.released || msg.role !== "user") return;
    // A harness that hasn't parsed the marker yet shows Tether's own text as it was sent.
    if (msg.origin?.kind === "tether" || msg.parts.some((p) => p.type === "text" && fromTether(p.text) !== undefined)) {
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

/** check_harness_updates' answer: one line per harness. */
export function harnessUpdateLines(r: HarnessReport): string {
  const line = (h: HarnessVersion) =>
    `- ${h.name}: ${h.installed ? `${h.installed}${h.latest ? `, latest ${h.latest}` : ""}` : "not installed"} — ${statusLabel(h)}${h.error ? ` (${h.error})` : ""}${h.status === "available" && h.updatable ? ` (updates with \`${h.command}\`)` : ""}`;
  return [...r.harnesses.map(line), "", "To update, the person uses Settings → Updates in Tether."].join("\n");
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
      const chats = await agent.chats();
      const sessionId = await agent.current();
      return { ...(sessionId ? { sessionId } : {}), chats, labels: agent.labels(), folder, rev: agent.state.rev, settings: await agent.settings(), harnesses: agent.harnesses() };
    });
    ctx.ops.register("homeAgentSet", (a) => agent.set(a));
    ctx.ops.register("homeAgentWatch", (a) => agent.watch((a as { on?: unknown } | undefined)?.on));
    ctx.ops.register("homeAgentReplyByText", (a) => agent.replyByText((a as { on?: unknown } | undefined)?.on));
    if (ctx.homeLine) ctx.homeLine.home = agent;
    ctx.ops.register("homeAgentCheckIn", (a) => agent.checkInFromHome((a ?? {}) as { start?: boolean; dismiss?: boolean }));
    ctx.ops.register("homeAgentNew", () => agent.newChat());
    ctx.ops.register("homeAgentClear", () => agent.close());
    ctx.ops.register("homeAgentClose", (a) => agent.close((a as { sessionId?: unknown } | undefined)?.sessionId));
    // A chat from before modes could be chosen takes the chosen one (auto) once the runner is up.
    void agent.alignMode().catch((e) => ctx.log(`couldn't set the Home chats' mode: ${(e as Error).message}`));

    const offs = [
      // A rate-limit retry is still that turn: no report, answer or failure until it really ends.
      ctx.bus.on("turnEnded", ({ sessionId, error, stopped, recovering }) => void (!recovering && agent.turnEnded(sessionId, error, stopped))),
      ctx.bus.on("message", ({ sessionId, msg }) => agent.personSpoke(sessionId, msg)),
      ctx.bus.on("requestOpened", ({ request }) => void agent.needsPerson(request.sessionId, request.title || request.question || (request.tool ? `permission for ${request.tool}` : "a question"))),
      ctx.bus.on("attention", ({ sessionId, message }) => void agent.needsPerson(sessionId, message || "in its terminal")),
    ];
    return () => {
      if (ctx.homeLine?.home === agent) ctx.homeLine.home = undefined;
      agent.stop();
      unset();
      offs.forEach((off) => off?.());
    };
  },
};
