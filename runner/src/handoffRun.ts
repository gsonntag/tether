// Moving a conversation to another harness (cross-harness fallback, "Continue on …") and picking
// sessions back up after a runner restart. Kept out of index.ts, which connects on import, so the
// fallback scenarios can run them against fake adapters (fallbackScenarios.test.ts).

import type { ChainEntry, HarnessId } from "../../web/src/shared/protocol";
import { APPROVING_MODES, isActive } from "../../web/src/shared/protocol";
import { displayText } from "../../web/src/shared/skill";
import type { Adapter, Sink } from "./adapters/types";
import { config, prefs, saveConfig } from "./config";
import type { ContextService } from "./context";
import { carriedNotice } from "./context/handoff";
import { buildBrief } from "./handoff";
import { briefSection } from "./goal";
import { briefSection as planBrief } from "./plan";
import { entryLabel, fmtTime, type HandoffOpts, type LiveSession } from "./session";
import { resolveForBrief } from "./skillcmd";

export interface HandoffDeps {
  adapters: Record<HarnessId, Pick<Adapter, "create">>;
  sink: Sink;
  context: Pick<ContextService, "handoffMemory">;
  /** registers the new session as live (index.ts track) */
  track: (s: LiveSession) => void;
}

/**
 * Cross-harness fallback: a new session in `to.harness`, same directory, seeded with a brief of
 * the conversation so far. The two sessions are linked both ways, and browsers on the old one
 * follow the link.
 */
export async function runHandoff(deps: HandoffDeps, from: LiveSession, to: ChainEntry, reason: string, pendingPrompt?: string, opts: HandoffOpts & { compact?: { focus?: string } } = {}) {
  const { sink, context } = deps;
  const a = deps.adapters[to.harness];
  // The old agent is done here: nothing it asked can be answered any more, and (mid-task) what it
  // left running in the background is stopped. The brief lists both.
  const cancelled = from.cancelOpenUi();
  const tasks = opts.interrupted
    ? await from.stopBackground()
    : (from.t.state.activity ?? []).filter((x) => isActive(x) && x.background !== false && !x.parentId && !x.sessionId).map((item) => ({ item, stopped: false }));
  // The prompt comes as typed: `/skill args` is resolved for the new harness, not the old one.
  const prompt = pendingPrompt === undefined ? undefined : resolveForBrief(to.harness, from.projectPath, pendingPrompt);
  // Master context on: carry the relevant memories and capture what this session learned first.
  const memory = await context.handoffMemory({
    sessionId: from.id,
    projectPath: from.projectPath,
    messages: from.t.messages,
    target: to.harness,
    pendingPrompt: pendingPrompt && displayText(pendingPrompt),
  });
  const brief = await buildBrief({
    messages: from.t.messages,
    cwd: from.projectPath,
    fromLabel: `${from.harness}, ${entryLabel(from.currentEntry)}`,
    reason,
    pendingPrompt: prompt,
    memory: memory?.text,
    interrupted: opts.interrupted,
    cancelled,
    tasks,
    // Decision 6: an active goal goes with the conversation, and the loop keeps running there.
    goal: from.goalState?.status === "active" ? briefSection(from.goalState) : undefined,
    // The plan and todo list go with it too (an open review was cancelled above: it starts over there).
    plan: planBrief(from.planState),
    ...(opts.compact ? { kind: "compact" as const, focus: opts.compact.focus } : {}),
  });
  const mode = from.t.state.permissionMode;
  const next = a.create(from.projectPath, { model: to.model, permissionMode: mode && !APPROVING_MODES.has(mode) ? mode : undefined }, sink);
  next.t.state.guard = from.guardMode;
  // A review session stays one (before start: the launch narrows the harness's tools), never Dangerously skip.
  next.inheritReview(from);
  if (next.t.state.reviewOf) next.t.state.guard = "auto";
  // A cross-harness subagent stays one: its parent follows it to the new session.
  next.inheritStartedBy(from);
  // The leader stays the leader (before start: its launch adds the leader tools).
  next.inheritLeader(from);
  try {
    await next.start();
  } finally {
    memory?.settle?.(); // captured facts go to the merge pass only now: next's injection is fixed
  }
  deps.track(next);
  next.inheritDiffBase(from.diffBase);
  // The brief lists the earlier session's attachments: the new agent may read them too.
  next.inheritedAttachments = from.attachmentFolders();
  next.setTitle(from.title);
  next.setState({
    chain: from.t.state.chain,
    profile: from.t.state.profile,
    preferEarlier: from.t.state.preferEarlier,
    handoffFrom: { sessionId: from.id, reason },
    guard: next.t.state.reviewOf ? "auto" : from.guardMode,
    ...(next.t.state.reviewOf ? { reviewOf: next.t.state.reviewOf } : {}),
    ...(next.t.state.startedBy ? { startedBy: next.t.state.startedBy } : {}),
    ...(next.t.state.leader ? { leader: true } : {}),
  });
  if (to.model !== "default" && next.t.state.model !== to.model) await next.applyModel(to.model);
  const goal = from.goalState;
  if (goal) {
    await next.adoptGoal(goal);
    from.handOverGoal(entryLabel(to, from.harness));
  }
  const plan = from.planState;
  if (plan && (plan.text.trim() || plan.todos.length)) next.adoptPlan(plan);
  // Loops and schedules run on the new session from now on (a run waiting in the queue moves with it, below).
  if (from.schedules.length) {
    next.adoptSchedules(from.schedules);
    from.handOverSchedules();
  }
  // Review cards come along (findings can be sent to the new agent); a running review's result reaches both.
  if (from.reviews.length) next.adoptReviews(from.reviews);
  // Cross-harness subagents it started report to the new session (their parent link follows handoffTo).
  if (from.subagents.length) {
    next.adoptSubagents(from.subagents);
    from.handOverSubagents();
  }
  from.setState({ status: "idle", waitingReason: undefined, waitingUntil: undefined, handoffTo: { sessionId: next.id, reason } });
  const left = [
    cancelled.length ? `${cancelled.length} open ${cancelled.length === 1 ? "request was" : "requests were"} cancelled` : "",
    tasks.some((t) => t.stopped) ? `${tasks.filter((t) => t.stopped).length} background ${tasks.filter((t) => t.stopped).length === 1 ? "task was" : "tasks were"} stopped` : "",
  ].filter(Boolean);
  if (opts.compact) from.notice(`${reason}: this conversation goes on in a new session.`, "info");
  else from.notice(`${reason}. Continued on ${entryLabel(to, from.harness)}.${left.length ? ` ${left.join("; ")}.` : ""}`, "warning");
  const carried = (memory?.carried.length ?? 0) + (memory?.captured.length ?? 0);
  const focus = opts.compact?.focus ? `, and asked to keep “${opts.compact.focus}” in focus` : "";
  if (memory && (carried || memory.native)) {
    const what = carried ? `${carried} ${carried === 1 ? "memory" : "memories"}` : "the shared memory";
    next.notice(
      `The agent was given the conversation, the repository state and ${what}${focus}.\n\n${carriedNotice(memory, to.harness)}`,
      "info",
      { title: `Continued from a ${from.harness} session: ${reason}. Carried ${what}.`, collapsed: true, source: "memory" },
    );
  } else next.notice(`Continued from a ${from.harness} session: ${reason}. The agent was given the conversation and the repository state${focus}.`, "info");
  if (prompt) next.addUserMessage(prompt);
  // Messages still waiting on the old session move over and wait on the new one.
  const carry = from.t.state.pending ?? [];
  if (carry.length) from.setState({ pending: [], pendingHeld: undefined });
  // Held open until the brief has reached the agent (the idle close waits).
  await next.hold(() => next.continueTurn(brief));
  // Merged with runs queued on the new session meanwhile (its schedules were armed above); a run
  // of the same loop or schedule in both collapses into the carried one.
  if (carry.length) {
    const queued = (next.t.state.pending ?? []).filter((p) => !p.scheduleId || !carry.some((c) => c.scheduleId === p.scheduleId));
    next.setState({ pending: [...carry, ...queued] });
  }
  sink.summary(next.summary());
  return next;
}

/** Why a compaction restarted the conversation: the link back and the notices say it. */
export const COMPACT_REASON = "Restarted to free up context";

/**
 * `/compact` where the harness can't compact itself (or not with a focus): the conversation goes
 * on in a new session on the same harness and model, seeded with a brief (the focus included) and
 * linked like a handoff: goal, plan, loops and waiting messages move with it. The old session is
 * marked done, so the new one takes its place in the session lists, and its process stops.
 */
export async function runCompact(deps: HandoffDeps, from: LiveSession, focus?: string) {
  const next = await runHandoff(deps, from, from.currentEntry, COMPACT_REASON, undefined, { compact: { focus } });
  const cfg = config();
  // Its title stays (the new session's first message is the brief).
  cfg.titles[next.id] ??= from.title;
  if (!cfg.archived.includes(from.id)) cfg.archived.push(from.id);
  saveConfig();
  from.close();
  deps.sink.summary(from.summary());
  return next;
}

/**
 * Turns that were running when the runner last stopped are resumed, and messages the agent had
 * not taken yet are sent again, so a restart never strands an agent or loses what you typed.
 * `getLive` opens (resumes) a stored session.
 */
export async function resumeActive(getLive: (id: string, projectPath?: string) => Promise<LiveSession>) {
  // Copy what was saved now: opening a session re-saves its prefs (as idle), overwriting these.
  const saved = Object.entries(config().sessions).map(([id, p]) => [id, structuredClone(p)] as const);
  const archived = new Set(config().archived);
  for (const [id, p] of saved) {
    // A session marked done keeps its waiting messages held (shown when opened) instead of sending them.
    const unsent = archived.has(id) ? [] : (p.pending ?? []);
    if (!p.active && !unsent.length) continue;
    try {
      const s = await getLive(id, p.projectPath);
      // Starting brought them back held (loadPrefs); they're sent again (or wait on) below, in order.
      if (unsent.length) s.setState({ pending: [], pendingHeld: undefined });
      if (p.active && p.waitingUntil) {
        // It was waiting on a usage limit or a backoff: wait on, then continue as it would have.
        const bg = p.background ?? [];
        s.notice(`The runner restarted while this session was waiting. It continues at ${fmtTime(Math.max(p.waitingUntil, Date.now()))}.`, "info");
        s.resumeWait(
          p.waitingUntil,
          p.waitingReason ?? "Waiting on usage limits",
          bg.length ? `The session was interrupted by a restart, which also stopped these background tasks: ${bg.map((b) => `"${b.description}"`).join(", ")}. Restart the ones still needed, and continue where you left off.` : undefined,
          p.waitingUsageLimitResume,
        );
      } else if (p.active) {
        const bg = p.background ?? [];
        const parts = ["The runner restarted while this session was working. Resuming."];
        if (bg.length) parts.push(`Stopped background work: ${bg.map((b) => b.description).join("; ")}.`);
        if (unsent.length) parts.push(`Resending ${unsent.length} message${unsent.length > 1 ? "s" : ""} it had not received.`);
        s.notice(parts.join(" "), "warning");
        await s.hold(() =>
          s.continueTurn(
            bg.length
              ? `The session was interrupted by a restart, which also stopped these background tasks: ${bg
                  .map((b) => `"${b.description}"${b.type ? ` (${b.type})` : ""}`)
                  .join(", ")}. Check what they had finished, restart the ones still needed, and continue where you left off.`
              : "The session was interrupted by a restart. Continue where you left off.",
          ),
        );
      }
      // Sending would end the wait (a message while waiting means "go now"): they wait with it.
      if (p.active && p.waitingUntil) {
        if (unsent.length) s.setState({ pending: unsent });
      } else
        for (const m of unsent)
          if (m.scheduleId) s.requeueRun(m);
          else await s.prompt(m.text, m.mode, { alone: m.alone });
      console.log(`resumed ${id}${unsent.length ? ` (resent ${unsent.length})` : ""}`);
    } catch (e: any) {
      console.error(`could not resume ${id}: ${e?.message ?? e}`);
      prefs(id).active = false;
      saveConfig();
    }
  }
}
