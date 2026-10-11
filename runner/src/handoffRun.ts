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
export async function runHandoff(deps: HandoffDeps, from: LiveSession, to: ChainEntry, reason: string, pendingPrompt?: string, opts: HandoffOpts = {}) {
  const { sink, context } = deps;
  const a = deps.adapters[to.harness];
  // The old agent is done here: nothing it asked can be answered any more, and (mid-task) what it
  // left running in the background is stopped. The brief lists both.
  const cancelled = from.cancelOpenUi();
  const tasks = opts.interrupted
    ? await from.stopBackground()
    : (from.t.state.activity ?? []).filter((x) => isActive(x) && x.background !== false && !x.parentId).map((item) => ({ item, stopped: false }));
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
  });
  const mode = from.t.state.permissionMode;
  const next = a.create(from.projectPath, { model: to.model, permissionMode: mode && !APPROVING_MODES.has(mode) ? mode : undefined }, sink);
  next.t.state.guard = from.guardMode;
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
    guard: from.guardMode,
  });
  if (to.model !== "default" && next.t.state.model !== to.model) await next.applyModel(to.model);
  const goal = from.goalState;
  if (goal) {
    await next.adoptGoal(goal);
    from.handOverGoal(entryLabel(to, from.harness));
  }
  from.setState({ status: "idle", waitingReason: undefined, waitingUntil: undefined, handoffTo: { sessionId: next.id, reason } });
  const left = [
    cancelled.length ? `${cancelled.length} open ${cancelled.length === 1 ? "request was" : "requests were"} cancelled` : "",
    tasks.some((t) => t.stopped) ? `${tasks.filter((t) => t.stopped).length} background ${tasks.filter((t) => t.stopped).length === 1 ? "task was" : "tasks were"} stopped` : "",
  ].filter(Boolean);
  from.notice(`${reason}. Continued on ${entryLabel(to, from.harness)}.${left.length ? ` ${left.join("; ")}.` : ""}`, "warning");
  const carried = (memory?.carried.length ?? 0) + (memory?.captured.length ?? 0);
  if (memory && (carried || memory.native)) {
    const what = carried ? `${carried} ${carried === 1 ? "memory" : "memories"}` : "the shared memory";
    next.notice(
      `The agent was given the conversation, the repository state and ${what}.\n\n${carriedNotice(memory, to.harness)}`,
      "info",
      { title: `Continued from a ${from.harness} session: ${reason}. Carried ${what}.`, collapsed: true, source: "memory" },
    );
  } else next.notice(`Continued from a ${from.harness} session: ${reason}. The agent was given the conversation and the repository state.`, "info");
  if (prompt) next.addUserMessage(prompt);
  // Messages still waiting on the old session move over and wait on the new one.
  const carry = from.t.state.pending ?? [];
  if (carry.length) from.setState({ pending: [], pendingHeld: undefined });
  await next.continueTurn(brief);
  if (carry.length) next.setState({ pending: carry });
  sink.summary(next.summary());
}

/**
 * Turns that were running when the runner last stopped are resumed, and messages the agent had
 * not taken yet are sent again, so a restart never strands an agent or loses what you typed.
 * `getLive` opens (resumes) a stored session.
 */
export async function resumeActive(getLive: (id: string, projectPath?: string) => Promise<LiveSession>) {
  // Copy what was saved now: opening a session re-saves its prefs (as idle), overwriting these.
  const saved = Object.entries(config().sessions).map(([id, p]) => [id, structuredClone(p)] as const);
  for (const [id, p] of saved) {
    const unsent = p.pending ?? [];
    if (!p.active && !unsent.length) continue;
    try {
      const s = await getLive(id, p.projectPath);
      if (p.active && p.waitingUntil) {
        // It was waiting on a usage limit or a backoff: wait on, then continue as it would have.
        const bg = p.background ?? [];
        s.notice(`The runner restarted while this session was waiting. It continues at ${fmtTime(Math.max(p.waitingUntil, Date.now()))}.`, "info");
        s.resumeWait(
          p.waitingUntil,
          p.waitingReason ?? "Waiting on usage limits",
          bg.length ? `The session was interrupted by a restart, which also stopped these background tasks: ${bg.map((b) => `"${b.description}"`).join(", ")}. Restart the ones still needed, and continue where you left off.` : undefined,
        );
      } else if (p.active) {
        const bg = p.background ?? [];
        const parts = ["The runner restarted while this session was working. Resuming."];
        if (bg.length) parts.push(`Stopped background work: ${bg.map((b) => b.description).join("; ")}.`);
        if (unsent.length) parts.push(`Resending ${unsent.length} message${unsent.length > 1 ? "s" : ""} it had not received.`);
        s.notice(parts.join(" "), "warning");
        await s.continueTurn(
          bg.length
            ? `The session was interrupted by a restart, which also stopped these background tasks: ${bg
                .map((b) => `"${b.description}"${b.type ? ` (${b.type})` : ""}`)
                .join(", ")}. Check what they had finished, restart the ones still needed, and continue where you left off.`
            : "The session was interrupted by a restart. Continue where you left off.",
        );
      }
      // Sending would end the wait (a message while waiting means "go now"): they wait with it.
      if (p.active && p.waitingUntil) {
        if (unsent.length) s.setState({ pending: unsent });
      } else for (const m of unsent) await s.prompt(m.text, m.mode);
      console.log(`resumed ${id}${unsent.length ? ` (resent ${unsent.length})` : ""}`);
    } catch (e: any) {
      console.error(`could not resume ${id}: ${e?.message ?? e}`);
      prefs(id).active = false;
      saveConfig();
    }
  }
}
