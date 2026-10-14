// /goal: an objective on the Tether session that keeps the agent working until it's done
// (docs/harness-platform.md, Phase 3, Decisions 6 and 7). The state lives on the session
// (LiveState.goal, saved with its prefs) and goes with a handoff. When a turn ends with the goal
// active and nothing waiting on the user, the session sends a short continuation prompt
// (session.ts, goalTurnEnded). The agent reports through the `tether-context` tools goal_get /
// goal_update; a "done" claim, several turns without progress, and every GOAL_CHECK_EVERY goal
// turns in any case (a busy agent that never reports) are checked by the background model against
// the transcript. There is no default budget: a goal runs until it's done.
//
// This file is the part without a session: the command, the prompts, the budget and the check.

import { splitAgentWritten } from "../../web/src/shared/subagents";
import type { GoalBudget, GoalNote, GoalStatus, Msg, SessionGoal, SlashCommand } from "../../web/src/shared/protocol";
import { budgetUsed, fmtDuration, fmtTokens, STATUS_LABEL } from "../../web/src/shared/goal";
import { parseJsonReply, runBackground } from "./context/background";

export { budgetUsed, fmtBudget, fmtDuration, fmtTokens, STATUS_LABEL } from "../../web/src/shared/goal";

/** Turns in a row with no tool call, no change to the working tree and no goal_update: blocked. */
export const GOAL_STALL_TURNS = 3;
/** Goal turns between background-model checks when nothing else triggered one (an agent that never reports). */
export const GOAL_CHECK_EVERY = 5;
/** How Tether's own goal prompts start (kept out of what the guard judge reads as the user's asks). */
export const GOAL_MARK = "[Tether goal]";
const NOTES_MAX = 20;

export const isGoalPrompt = (text: string) => text.trimStart().startsWith(GOAL_MARK);

// ---------------- the command ----------------

/** Tether's own `/` commands, on every harness (a harness's own /goal is left out of the menu). */
export const TETHER_COMMANDS: SlashCommand[] = [
  { name: "goal", kind: "tether", description: "Keep the agent working until it's done: /goal <objective> [--turns n] [--tokens n] [--time 2h]; /goal pause, resume or clear" },
  { name: "loop", kind: "tether", description: "Send a prompt now and on an interval: /loop 10m <prompt>; /loop list, /loop stop [n]" },
  { name: "schedule", kind: "tether", description: "Send a prompt later: /schedule <cron> <prompt>, /schedule at 15:00 <prompt>, /schedule in 2h <prompt>; /schedule list, /schedule delete <n>" },
  { name: "compact", kind: "tether", description: "Free up context: /compact [what to keep in focus]. On a harness that can't compact, the conversation goes on in a new session that gets a brief of it" },
  { name: "review", kind: "tether", description: "Have another harness review this session's changes: /review [harness[:model]] [what to focus on]. Findings show here, each one ready to send to the agent" },
];

export type GoalCommand =
  | { cmd: "status" | "pause" | "resume" | "clear" }
  | { cmd: "set"; objective: string; budget?: GoalBudget }
  | { cmd: "error"; text: string };

/** "20", "500k", "1.5M" */
function parseCount(v: string): number | undefined {
  const m = v.match(/^(\d+(?:\.\d+)?)([km]?)$/i);
  if (!m) return undefined;
  const n = Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1);
  return n > 0 ? Math.round(n) : undefined;
}

/** "45m", "2h", "1h30m", "90s" */
function parseDuration(v: string): number | undefined {
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m || !v) return undefined;
  const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
  return ms > 0 ? ms : undefined;
}

const USAGE = "Use /goal <objective> [--turns 20] [--tokens 2M] [--time 2h], or /goal pause, resume or clear.";

/**
 * `/goal …` as typed; undefined for any other message. Alone (or `status`) it shows the goal;
 * `pause`, `resume`, `clear` act on it; anything else sets a new one, with an optional budget at
 * the end.
 */
export function parseGoalCommand(text: string): GoalCommand | undefined {
  const m = text.trim().match(/^\/goal(?:\s+([\s\S]*))?$/);
  if (!m) return undefined;
  let rest = (m[1] ?? "").trim();
  if (!rest || /^status$/i.test(rest)) return { cmd: "status" };
  if (/^(pause|resume|clear)$/i.test(rest)) return { cmd: rest.toLowerCase() as "pause" | "resume" | "clear" };
  const budget: GoalBudget = {};
  for (let f: RegExpMatchArray | null; (f = rest.match(/(?:^|\s)--(turns|tokens|time)(?:=|\s+)(\S+)\s*$/i)); ) {
    const key = f[1]!.toLowerCase();
    const n = key === "time" ? parseDuration(f[2]!) : parseCount(f[2]!);
    if (!n || (key === "turns" && !Number.isInteger(Number(f[2])))) return { cmd: "error", text: `"--${key} ${f[2]}" isn't a budget I understand. ${USAGE}` };
    if (key === "turns") budget.turns = n;
    else if (key === "tokens") budget.tokens = n;
    else budget.ms = n;
    rest = rest.slice(0, f.index).trim();
  }
  if (!rest) return { cmd: "error", text: `Say what the goal is. ${USAGE}` };
  return { cmd: "set", objective: rest.slice(0, 2000), ...(Object.keys(budget).length ? { budget } : {}) };
}

// ---------------- state ----------------

export function newGoal(objective: string, budget?: GoalBudget, now = Date.now()): SessionGoal {
  return { objective, status: "active", ...(budget ? { budget } : {}), used: { turns: 0, tokens: 0, ms: 0 }, notes: [], createdAt: now, updatedAt: now };
}

/** A copy with a note added (the newest NOTES_MAX kept). */
export function withNote(g: SessionGoal, text: string, by: GoalNote["by"], now = Date.now()): SessionGoal {
  const note = text.replace(/\s+/g, " ").trim().slice(0, 600);
  if (!note) return g;
  return { ...g, notes: [...g.notes, { ts: now, text: note, by }].slice(-NOTES_MAX), updatedAt: now };
}

export const latestNote = (g: SessionGoal) => g.notes[g.notes.length - 1]?.text;

/** Why the budget stops the goal, or undefined while there's budget left (or none was set). */
export function budgetHit(g: SessionGoal): string | undefined {
  const b = g.budget;
  if (!b) return undefined;
  if (b.turns && g.used.turns >= b.turns) return `It used its budget of ${b.turns} turns.`;
  if (b.tokens && g.used.tokens >= b.tokens) return `It used its budget of ${fmtTokens(b.tokens)} tokens.`;
  if (b.ms && g.used.ms >= b.ms) return `It used its budget of ${fmtDuration(b.ms)}.`;
  return undefined;
}

// ---------------- wording ----------------

/** The goal in a few lines: what /goal and goal_get show. */
export function describeGoal(g: SessionGoal): string {
  const lines = [`Goal: ${g.objective}`, `Status: ${STATUS_LABEL[g.status]}${g.reason && g.status !== "active" ? `. ${g.reason}` : ""}`];
  const used = budgetUsed(g);
  lines.push(used ? `Budget: ${used}` : `Turns so far: ${g.used.turns}`);
  const notes = g.notes.slice(-3);
  if (notes.length) lines.push("Latest progress:", ...notes.map((n) => `- ${n.text}`));
  return lines.join("\n");
}

const REPORT = `Report progress with the tether-context goal_update tool (status "active" and a short note). When the objective is achieved and verified, call goal_update with status "done"; if you can't go on without the user, call it with status "blocked" and say why.`;

/** The first turn of a goal set while the session was idle. */
export function kickoffPrompt(g: SessionGoal): string {
  return `${GOAL_MARK} Goal: ${g.objective}\n\nWork toward this goal until it is fully achieved; Tether keeps you going between turns. ${REPORT}`;
}

/** After a turn that left the goal active: short, so a long goal doesn't flood the transcript. */
export function continuationPrompt(g: SessionGoal, check?: string): string {
  const note = latestNote(g);
  return [
    `${GOAL_MARK} Continue working toward the goal: ${g.objective.length > 400 ? g.objective.slice(0, 400) + "…" : g.objective}`,
    check ? `Tether's check of your "done": ${check}` : note ? `Latest progress: ${note}` : "",
    `If it's achieved, call goal_update with status "done"; if you're stuck on something only the user can resolve, status "blocked".`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The goal section of a handoff brief (Decision 6: the goal carries over). */
export function briefSection(g: SessionGoal): string {
  const notes = g.notes.slice(-5);
  return [
    `The user set a goal for this session, and Tether keeps you working on it between turns until it's done:`,
    "",
    g.objective,
    ...(notes.length ? ["", "Progress so far:", ...notes.map((n) => `- ${n.text}`)] : []),
    "",
    REPORT,
  ].join("\n");
}

// ---------------- the done check (the background model, shared with the guard judge) ----------------

export interface GoalCheck {
  goal: SessionGoal;
  /** the end of the conversation, rendered (transcriptTail) */
  transcript: string;
  /**
   * done: the agent said so; stalled: several turns without progress; periodic: GOAL_CHECK_EVERY
   * turns went by without a check (the agent keeps working and never says it's done)
   */
  claim: "done" | "stalled" | "periodic";
  cwd: string;
}
/**
 * The check's answer: done, or not done yet (go on). `blocked`: not done and the agent is stuck
 * (going in circles, or waiting on something only the user can give); only a periodic check acts on it.
 */
export type GoalVerdict = { done: boolean; blocked?: boolean; reason: string };
export type GoalJudge = (c: GoalCheck) => Promise<GoalVerdict>;

const CHECK_SYSTEM = `You check whether a coding agent has achieved the goal its user set. You see the goal and the end of the conversation.
Answer with JSON only: {"status": "done"|"continue"|"blocked", "reason": "<one or two sentences>"}.
done only when the conversation shows the objective fully achieved and verified (for example tests run and passing, the change made and checked). A claim without evidence, a partial result, or remaining steps the agent mentions itself are not done; then say concretely what is still missing, addressed to the agent.
continue: not done, and the agent is making real progress toward it.
blocked: not done, and the agent is stuck: repeating the same failing steps, going in circles, or unable to go on without something only the user can give. Say what it's stuck on.`;

const CLAIM_TEXT: Record<GoalCheck["claim"], string> = {
  done: "The agent says the goal is done.",
  stalled: `The agent made no progress for ${GOAL_STALL_TURNS} turns in a row and never said the goal was done.`,
  periodic: `The agent has worked on the goal for ${GOAL_CHECK_EVERY} more turns without saying it's done. Check whether it is done already, still progressing, or stuck.`,
};

/** The background model's JSON reply as a verdict ({"status": …}, or the older {"done": true|false}). */
export function parseVerdict(json: any): GoalVerdict {
  const reason = String(json?.reason ?? "").slice(0, 600);
  const status = typeof json?.status === "string" ? json.status.toLowerCase() : json?.done === true ? "done" : "continue";
  return { done: status === "done", ...(status === "blocked" ? { blocked: true } : {}), reason };
}

const backgroundJudge: GoalJudge = async (c) => {
  const prompt = `Goal: ${c.goal.objective}\n\n${CLAIM_TEXT[c.claim]}\n\nEnd of the conversation:\n${c.transcript}`;
  return parseVerdict(parseJsonReply(await runBackground({ system: CHECK_SYSTEM, prompt, cwd: c.cwd, timeoutMs: 90_000 })));
};

let judge: GoalJudge = backgroundJudge;

/** Tests: a fake background model (none: the real one). */
export function setGoalJudge(j?: GoalJudge) {
  judge = j ?? backgroundJudge;
}

export const checkGoal = (c: GoalCheck) => judge(c);

/** The last `max` characters' worth of conversation: user and agent text, tool calls and short results. */
/** How agent-written user messages are labelled where a model reads the conversation. */
export const AGENT_LABEL = "Tether (about a subagent, or another agent's message; not the user)";

export function transcriptTail(messages: Msg[], max = 12_000): string {
  const out: string[] = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0 && size < max; i--) {
    const m = messages[i]!;
    if (m.role !== "user" && m.role !== "assistant") continue;
    const lines: string[] = [];
    for (const p of m.parts) {
      if (p.type === "text" && p.text.trim()) lines.push(p.text.trim().slice(0, 3000));
      else if (p.type === "tool") {
        const input = JSON.stringify(p.input ?? {}).slice(0, 300);
        const output = typeof p.output === "string" && p.output.trim() ? ` → ${p.output.trim().slice(-600)}` : "";
        lines.push(`[${p.name} ${input}${p.status === "error" ? " (failed)" : ""}${output}]`);
      }
    }
    if (!lines.length) continue;
    let block = `${m.role === "user" ? "User" : "Agent"}: ${lines.join("\n")}`;
    // Tether's notes about subagents and another agent's messages aren't the user's words.
    if (m.role === "user") {
      const { user, agent } = splitAgentWritten(lines.join("\n"));
      block = [user && `User: ${user}`, agent && `${AGENT_LABEL}: ${agent}`].filter(Boolean).join("\n\n");
      if (!block) continue;
    }
    out.unshift(block);
    size += block.length;
  }
  const text = out.join("\n\n");
  return text.length > max ? "…" + text.slice(-max) : text;
}

// ---------------- Codex thread goals (native passthrough, adapters/codex.ts) ----------------

/** Codex's ThreadGoalStatus for Tether's. */
export const CODEX_STATUS: Record<GoalStatus, string> = { active: "active", paused: "paused", done: "complete", blocked: "blocked", budget: "budgetLimited" };

/** Tether's status for Codex's; usageLimited is left to fallback (undefined). */
export function fromCodexStatus(s: string): GoalStatus | undefined {
  return (Object.entries(CODEX_STATUS) as [GoalStatus, string][]).find(([, c]) => c === s)?.[0];
}
