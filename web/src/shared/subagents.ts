// Cross-harness subagents (runner/src/crossAgents.ts): what the runner and the web app both need.

import { GUARD_MODES, HARNESSES, type ActivityItem, type GuardMode, type SubagentLink } from "./protocol";

/** How a subagent's first message starts: the transcript folds the instructions around its task. */
export const SUBAGENT_TASK_PREFIX = "You are a subagent:";

/** How Tether's messages about a subagent start in the parent's conversation (finished, failed, stopped). */
export const SUBAGENT_NOTE_PREFIX = "[Tether] Subagent";

/** How a parent's agent_message reaches its subagent. */
export const FROM_PARENT_PREFIX = "[From the agent that started you]";

/** A subagent may start one more level of subagents, no deeper. */
export const MAX_SUBAGENT_DEPTH = 2;

/** At most this many subagents run at once in one tree (a top-level session and everything under it). */
export const MAX_RUNNING_SUBAGENTS = 4;

/** Strictest first: ask, edits, auto, full. */
export const guardRank = (g: GuardMode) => GUARD_MODES.findIndex((m) => m.id === g);

/** Whether `child` gives no more permission than `parent`. */
export const guardWithin = (child: GuardMode, parent: GuardMode) => guardRank(child) <= guardRank(parent);

const isRunning = (l: SubagentLink) => l.status === "working" || l.status === "waiting";

/**
 * A subagent's activity item in its parent: from its link, plus what the live subagent says
 * (model, tokens, what it's doing now) when it runs. Also what a stopped parent shows.
 */
export function subagentItem(link: SubagentLink, live?: { model?: string; tokens?: number; doing?: string }): ActivityItem {
  const running = isRunning(link);
  const status: ActivityItem["status"] = running ? "running" : link.status === "finished" ? "done" : link.status === "failed" ? "failed" : "stopped";
  const model = live?.model && live.model !== "default" ? live.model : link.model;
  const latest = link.status === "waiting" ? (live?.doing ? `Waiting for you: ${live.doing}` : "Waiting for you") : running ? live?.doing : undefined;
  return {
    id: `xa:${link.id}`,
    kind: "subagent",
    title: link.id,
    description: link.task,
    status,
    startedAt: link.startedAt,
    ...(running ? {} : { endedAt: link.endedAt ?? link.startedAt }),
    background: true,
    stoppable: true,
    agentType: HARNESSES.find((h) => h.id === link.harness)?.label ?? link.harness,
    harness: link.harness,
    sessionId: link.sessionId,
    ...(model ? { model } : {}),
    ...(live?.tokens ? { tokens: live.tokens } : {}),
    ...(latest ? { latest } : {}),
    ...(link.worktree ? { worktree: { path: link.worktree.path, branch: link.worktree.branch } } : {}),
    ...(link.report && !running ? { summary: link.report.length > 2_000 ? `${link.report.slice(0, 1_999)}…` : link.report } : {}),
  };
}

// ---- the leader agent (runner/src/leader.ts) ----

/** The user's own words, copied by the runner from the leader chat (never written by the leader): they count as the user's. */
export const LEADER_RELAY_PREFIX = "[From you, via your leader]";

/** The leader's own words to a session: not the user's. */
export const LEADER_NOTE_PREFIX = "[From your leader]";

/** How Tether's batched updates start in the leader's conversation. */
export const LEADER_DIGEST_PREFIX = "[Tether] Updates";

/** Text Tether or another agent wrote into a conversation as a user message (a note about a subagent, a parent's message or task, the leader's note, an update). */
export const AGENT_WRITTEN = [SUBAGENT_NOTE_PREFIX, FROM_PARENT_PREFIX, SUBAGENT_TASK_PREFIX, LEADER_NOTE_PREFIX, LEADER_DIGEST_PREFIX];

/** Markers that say who wrote a message: none may appear as written inside text that's passed on. */
const MARKERS = [LEADER_RELAY_PREFIX, ...AGENT_WRITTEN, "[Tether]"];
/** Brackets, and what passes for one to a reader. */
const OPEN = "[\\[［【〔⟦〚〖﹝❲⁅〘⦋⦍⦏]";
const CLOSE = "[\\]］】〕⟧〛〗﹞❳⁆〙⦌⦎⦐]";
/**
 * Characters a reader doesn't see (zero-width, bidi controls, invisible operators, the combining
 * grapheme joiner, Hangul fillers, variation selectors, tag characters): a marker could be split
 * or disguised with them. They are dropped from any text passed on.
 */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁤⁦-⁯ㅤ︀-️﻿ﾠ\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
/** Cyrillic and Greek letters that read as the Latin ones of the marker words. */
const CONFUSABLE: Record<string, string> = {
  а: "a", А: "a", в: "b", В: "b", с: "c", С: "c", ԁ: "d", е: "e", Е: "e", ё: "e", һ: "h", Н: "h", і: "i", І: "i", ј: "j", Ј: "j", к: "k", К: "k",
  м: "m", М: "m", о: "o", О: "o", р: "p", Р: "p", ԛ: "q", ѕ: "s", Ѕ: "s", т: "t", Т: "t", у: "y", У: "y", ԝ: "w", х: "x", Х: "x", ү: "y",
  α: "a", Α: "a", β: "b", Β: "b", ε: "e", Ε: "e", Ζ: "z", η: "n", Η: "h", ι: "i", Ι: "i", κ: "k", Κ: "k", Μ: "m", ν: "v", Ν: "n", ο: "o", Ο: "o",
  ρ: "p", Ρ: "p", τ: "t", Τ: "t", υ: "u", Υ: "y", χ: "x", Χ: "x", ϲ: "c", Ϲ: "c", ı: "i",
};
/** A string of the same length that reads like `t`: confusables and case folded to ASCII lower case where one character stays one. */
function skeleton(t: string): string {
  let out = "";
  for (const c of t) {
    const m = CONFUSABLE[c] ?? c.toLowerCase();
    // Same length as the input, so positions carry over (astral characters stay as they are).
    out += m.length === c.length ? m : c;
  }
  return out;
}
const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&");
/** One marker as a pattern over the skeleton: any spacing (none too), the comma optional. */
function loose(p: string): string {
  let out = "";
  for (const c of p.toLowerCase()) {
    if (c === "[") out += `${OPEN}\\s*`;
    else if (c === "]") out += `\\s*${CLOSE}`;
    else if (/\s/.test(c)) out += "\\s*";
    else if (c === ",") out += ",?";
    else out += esc(c);
  }
  return out;
}
const MARKER_RE = new RegExp(MARKERS.map(loose).join("|"), "g");
const OPEN_RE = new RegExp(OPEN, "g");
const CLOSE_RE = new RegExp(CLOSE, "g");
const STARTS_OPEN = new RegExp(`^${OPEN}`);

/**
 * Text passed from one writer to another (the user's words relayed, the leader's note, another
 * session's report) with every authorship marker defused: "[From your leader]" becomes
 * "(From your leader)", "You are a subagent:" is quoted. Also when written in another case,
 * without spaces, with full-width, compatibility or Cyrillic / Greek look-alike letters, with
 * look-alike brackets, or split by invisible characters (always dropped). Text that holds a
 * disguised marker is passed on in its compatibility form (NFKC), so what's left reads as it is;
 * other text stays as written. Then nothing in it can pass for a block someone else wrote.
 */
export function defang(text: string): string {
  const visible = text.replace(INVISIBLE, "");
  const norm = visible.normalize("NFKC");
  const skel = skeleton(norm);
  // (matchAll starts at the pattern's lastIndex.)
  MARKER_RE.lastIndex = 0;
  const found = [...skel.matchAll(MARKER_RE)];
  // Most text: no marker even in disguise, kept exactly as written.
  if (!found.length) return visible;
  let out = "";
  let at = 0;
  for (const m of found) {
    const i = m.index!;
    const raw = norm.slice(i, i + m[0].length);
    out += norm.slice(at, i) + (STARTS_OPEN.test(raw) ? raw.replace(OPEN_RE, "(").replace(CLOSE_RE, ")") : `“${raw}”`);
    at = i + m[0].length;
  }
  return out + norm.slice(at);
}

/**
 * What the leader sends a session: the user's words (copied by the runner, never by the model)
 * under LEADER_RELAY_PREFIX, then the leader's own note under LEADER_NOTE_PREFIX. Both defused, so
 * the only relay block is the first one and the split between the two is unambiguous.
 */
export function leaderMessage(o: { relay?: string; note?: string }): string {
  const relay = o.relay?.trim();
  const note = o.note?.trim();
  return [relay && `${LEADER_RELAY_PREFIX}\n${defang(relay)}`, note && `${LEADER_NOTE_PREFIX} ${defang(note)}`].filter(Boolean).join("\n\n");
}

/** A leader message taken apart (the transcript's card); undefined when it isn't one. */
export function parseLeaderMessage(text: string): { relay?: string; note?: string } | undefined {
  const t = text.trimStart();
  if (t.startsWith(LEADER_NOTE_PREFIX)) return { note: t.slice(LEADER_NOTE_PREFIX.length).trim() };
  if (!t.startsWith(LEADER_RELAY_PREFIX)) return undefined;
  const body = t.slice(LEADER_RELAY_PREFIX.length);
  const i = body.indexOf(`\n\n${LEADER_NOTE_PREFIX}`);
  if (i < 0) return { relay: body.trim() };
  return { relay: body.slice(0, i).trim(), note: body.slice(i + 2 + LEADER_NOTE_PREFIX.length).trim() };
}

/** A message that carries the user's words relayed by the leader: sent alone, never joined with another. */
export const isRelay = (text: string) => text.trimStart().startsWith(LEADER_RELAY_PREFIX);

/** Whether a user message's text was written by Tether or another agent, not the user. */
export const agentWritten = (text: string) => AGENT_WRITTEN.some((p) => text.trimStart().startsWith(p));

/**
 * A user message's text split into what the user wrote and what Tether or another agent wrote, at
 * the paragraphs that start with an agent-written prefix: each such piece runs to the next one (or
 * the end) and counts as agent-written. Such messages always go out alone (PendingMessage.alone),
 * so this only guards against joined text passing agent words off as the user's; anything the user
 * wrote after one in the same message would be left out, never the other way round.
 */
export function splitAgentWritten(text: string): { user: string; agent: string } {
  // The leader's relay block is never a split point: inside agent-written text it stays agent-written.
  const pieces = text.split(new RegExp(`\\n\\n(?=${AGENT_WRITTEN.map((p) => p.replace(/[[\]]/g, "\\$&")).join("|")})`));
  const user: string[] = [];
  const agent: string[] = [];
  for (const p of pieces) (agentWritten(p) ? agent : user).push(p);
  return { user: user.join("\n\n").trim(), agent: agent.join("\n\n").trim() };
}

/** The task a subagent was given (its first message, after "## Task"). */
export function subagentTask(text: string): string | undefined {
  if (!text.trimStart().startsWith(SUBAGENT_TASK_PREFIX)) return undefined;
  const i = text.indexOf("\n## Task\n");
  return i >= 0 ? text.slice(i + 9).trim() : text.trim();
}
