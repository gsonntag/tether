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

/** Text Tether or another agent wrote into a conversation as a user message (a note about a subagent, a parent's message or task). */
export const AGENT_WRITTEN = [SUBAGENT_NOTE_PREFIX, FROM_PARENT_PREFIX, SUBAGENT_TASK_PREFIX];

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
