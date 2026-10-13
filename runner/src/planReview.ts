// Plan review on the runner (the formats are in web/src/shared/plan.ts). Each plan's review lives
// in LiveState.plans, so every browser on the session sees it live, and in a file per session:
//  - the draft comments, saved by whichever device is typing (a save based on an older revision
//    of the draft is refused, so a stale device can't undo newer changes);
//  - Discuss: the comments go to the agent with short ids, and its answer is split back into the
//    threads once it's written. A waiting approval is declined for it; the plan stays "held", so
//    it can still be approved, and its review follows the plan if the agent submits it again;
//  - Revise: the comments are remembered, the plan written in reply is linked to the one it
//    revises, and the background model checks once whether each comment was addressed.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveState, Msg, SessionEvent, UiResponse } from "../../web/src/shared/protocol";
import {
  addDiscussion,
  approveNotes,
  checkPrompt,
  cleanDraft,
  discussionMessage,
  EMPTY_DRAFT,
  isEmptyDraft,
  mergeAgentReplies,
  parseDiscussion,
  parseVerdicts,
  reviseMessage,
  type PlanDraft,
  type PlanReviewState,
} from "../../web/src/shared/plan";
import { findPlan, type Transcript } from "../../web/src/shared/reducer";
import { CONFIG_DIR } from "./config";
import { parseJsonReply, runBackground, type BackgroundRequest } from "./context/background";

/** What plan review needs from its session (LiveSession). */
export interface PlanHost {
  readonly id: string;
  readonly harness: string;
  t: Transcript;
  setState(s: Partial<LiveState>): void;
  prompt(text: string, mode?: "steer" | "followUp"): Promise<void>;
  uiRespond(r: UiResponse): boolean;
}

export type PlanAction = "discuss" | "revise" | "approve";
type Plans = Record<string, PlanReviewState>;

/** Revisions that keep the earlier plan's text (for the Changes view); older ones drop it. */
const KEEP_TEXTS = 3;

const fileOf = (sessionId: string) => join(CONFIG_DIR, "plans", `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
const textOf = (m: Msg) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
/** Drops fields set to undefined, so an empty review can be removed. */
const prune = (p: PlanReviewState): PlanReviewState => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));

function readPlans(sessionId: string): Plans {
  try {
    return JSON.parse(readFileSync(fileOf(sessionId), "utf8")) ?? {};
  } catch {
    return {};
  }
}

function writePlans(sessionId: string, plans: Plans) {
  if (sessionId.includes(":pending-")) return;
  try {
    const file = fileOf(sessionId);
    mkdirSync(join(CONFIG_DIR, "plans"), { recursive: true });
    writeFileSync(file + ".tmp", JSON.stringify(plans));
    renameSync(file + ".tmp", file);
  } catch (e: any) {
    console.error(`saving plan reviews of ${sessionId} failed: ${e?.message ?? e}`);
  }
}

/** A removed session's plan reviews go with it. */
export const forgetPlans = (sessionId: string) => rmSync(fileOf(sessionId), { force: true });

/** One review changed: the draft's revision moves with every change to it; old plan texts are dropped. */
function update(plans: Plans, planId: string, f: (p: PlanReviewState) => PlanReviewState): Plans {
  const cur = plans[planId] ?? {};
  const next = prune(f(cur));
  if (JSON.stringify(next.draft) !== JSON.stringify(cur.draft)) next.rev = (cur.rev ?? 0) + 1;
  const out = { ...plans };
  if (Object.keys(next).filter((k) => k !== "rev").length) out[planId] = next;
  else delete out[planId];
  const texts = Object.keys(out).filter((id) => out[id]!.previous?.text);
  for (const id of texts.slice(0, -KEEP_TEXTS)) out[id] = { ...out[id]!, previous: { ...out[id]!.previous!, text: "" } };
  return out;
}

/**
 * A device's save. Refused (stale) when it started from an older revision of the draft; without a
 * base (a migration from browser storage) agent replies that arrived meanwhile are kept.
 */
function draftUpdate(p: PlanReviewState, draft: PlanDraft | null, base?: number): PlanReviewState | undefined {
  if (base !== undefined && base !== (p.rev ?? 0)) return undefined;
  const d = (draft && cleanDraft(draft)) || EMPTY_DRAFT;
  const next = base === undefined ? mergeAgentReplies(d, p.draft) : d;
  return { ...p, draft: isEmptyDraft(next) ? undefined : next };
}

/** setPlanDraft for a session that isn't running: straight to its file (nothing to push to). */
export function saveStoredDraft(sessionId: string, planId: string, draft: PlanDraft | null, base?: number): { rev?: number; stale?: boolean } {
  const plans = readPlans(sessionId);
  const next = draftUpdate(plans[planId] ?? {}, draft, base);
  if (!next) return { stale: true, rev: plans[planId]?.rev ?? 0 };
  const out = update(plans, planId, () => next);
  writePlans(sessionId, out);
  return { rev: out[planId]?.rev ?? 0 };
}

let replyN = 0;

export class PlanReviews {
  private loaded = false;
  /** Approved after a discussion declined the approval: the plan the agent submits again is approved without asking, once. */
  private approveNext?: { planId: string; text: string };

  constructor(
    private s: PlanHost,
    private run: (req: BackgroundRequest) => Promise<string> = (req) => runBackground(req),
  ) {}

  get all(): Plans {
    return this.s.t.state.plans ?? {};
  }

  /** Puts back what was saved (call once the session id is final). */
  load() {
    const plans = readPlans(this.s.id);
    // A check a restart cut short runs again (settle).
    for (const p of Object.values(plans)) if (p.check?.status === "checking") delete p.check;
    this.loaded = true;
    this.s.setState({ plans });
    this.settle();
  }

  private patch(planId: string, f: (p: PlanReviewState) => PlanReviewState) {
    const plans = update(this.all, planId, f);
    this.s.setState({ plans });
    writePlans(this.s.id, plans);
  }

  private request(planId: string) {
    return this.s.t.state.pendingUi.find((r) => r.kind === "plan" && r.planId === planId);
  }

  private planText(planId: string) {
    return findPlan(this.s.t.messages, planId)?.part.text ?? "";
  }

  /** The newest plan in the transcript. */
  private latest(): { id: string; text: string; ts: number; approved: boolean } | undefined {
    for (let i = this.s.t.messages.length - 1; i >= 0; i--) {
      const m = this.s.t.messages[i]!;
      for (let j = m.parts.length - 1; j >= 0; j--) {
        const p = m.parts[j]!;
        if (p.type === "plan") return { id: p.id, text: p.text, ts: m.ts, approved: p.outcome === "approved" };
      }
    }
  }

  setDraft(planId: string, draft: PlanDraft | null, base?: number): { rev?: number; stale?: boolean } {
    const cur = this.all[planId] ?? {};
    const next = draftUpdate(cur, draft, base);
    if (!next) return { stale: true, rev: cur.rev ?? 0 };
    this.patch(planId, () => next);
    return { rev: this.all[planId]?.rev ?? 0 };
  }

  /** Answers the plan's waiting approval when there is one; false when there's none (or it just went). */
  private answer(planId: string, r: Omit<UiResponse, "id">): boolean {
    const req = this.request(planId);
    return !!req && this.s.uiRespond({ id: req.id, ...r });
  }

  async act(planId: string, action: PlanAction, draft: PlanDraft) {
    const d = cleanDraft(draft) ?? EMPTY_DRAFT;
    const review = this.all[planId] ?? {};
    const waiting = !!this.request(planId);
    const idle = this.s.t.state.status === "idle";
    if (review.discussing) throw new Error("The agent is still answering your comments.");
    if (action === "discuss") {
      const { text, ids } = discussionMessage(d);
      if (!text) throw new Error("Write a comment first.");
      // Its answer has to be the agent's next turn: never steered into work in progress.
      const latest = this.latest();
      if (!waiting && !idle) throw new Error("The agent is working: discuss the plan once it has finished.");
      if (!waiting && !review.held && (latest?.id !== planId || latest.approved)) throw new Error("A newer plan has replaced this one.");
      this.patch(planId, (p) => ({ ...p, draft: mergeAgentReplies(d, p.draft), discussing: { text, ids, ts: Date.now() }, held: waiting ? Date.now() : p.held }));
      // Declining a waiting approval this way keeps the plan under review (the adapters see `discuss`).
      if (!this.answer(planId, { allow: false, value: text, discuss: true })) await this.s.prompt(text, "followUp");
      return;
    }
    if (action === "revise") {
      const text = reviseMessage(d);
      if (!text) throw new Error("Write a comment first.");
      // Remembered first: the revised plan can come back before the prompt call returns.
      this.patch(planId, (p) => ({ ...p, revised: { comments: d.comments.filter((c) => !c.resolved), general: d.general, ts: Date.now() } }));
      try {
        if (!this.answer(planId, { allow: false, value: text })) await this.s.prompt(text);
      } catch (e) {
        this.patch(planId, (p) => ({ ...p, revised: review.revised }));
        throw e;
      }
      this.patch(planId, (p) => ({ ...p, draft: undefined, held: undefined }));
      return;
    }
    const notes = approveNotes(d);
    if (this.answer(planId, { allow: true })) {
      if (notes) await this.s.prompt(notes, "steer");
    } else if (review.held) {
      const text = this.planText(planId);
      const other = this.s.t.state.pendingUi.find((r) => r.kind === "plan" && r.planId !== planId);
      if (other) {
        // Already submitted again: approve that request if it's the same plan.
        if (squash(this.planText(other.planId ?? "")) !== squash(text)) throw new Error("The agent has since presented a different plan: review that one.");
        this.s.uiRespond({ id: other.id, allow: true });
        if (notes) await this.s.prompt(notes, "steer");
      } else {
        if (!idle) throw new Error("The agent is working: approve once it has finished.");
        const claude = this.s.harness === "claude-code";
        const ask = claude ? "I approve the plan as it stands. Call ExitPlanMode with it unchanged, then implement it." : "I approve the plan as it stands. Implement it now.";
        await this.s.prompt(notes ? `${ask}\n\nNotes for the work:\n\n${notes}` : ask);
        // Armed after the prompt went out (its own message would disarm it).
        this.approveNext = { planId, text: squash(text) };
      }
    } else throw new Error("The plan isn't waiting for approval any more.");
    this.patch(planId, (p) => ({ ...p, draft: undefined, held: undefined }));
  }

  /** The agent submits a plan approved after a discussion: true (once) when it's that plan, unchanged. */
  autoApproves(text: string): boolean {
    const want = this.approveNext;
    this.approveNext = undefined;
    return !!want && squash(text) === want.text;
  }

  /** A plan approval was answered, the agent stopped, the turn ended or a new message went in: no auto-approval. */
  disarm() {
    this.approveNext = undefined;
  }

  /** Every session event, after it was applied. */
  observe(e: SessionEvent) {
    if (!this.loaded) return;
    if (e.type === "msg" && e.msg.role === "user") this.disarm();
    if (e.type === "msg" && e.msg.role === "assistant") for (const p of e.msg.parts) if (p.type === "plan") this.link(p.id, e.msg.ts);
    if (e.type === "state" && e.state.status === "idle") this.disarm();
    if (e.type === "state" && (e.state.status === "idle" || e.state.pendingUi?.some((r) => r.kind === "plan"))) this.settle();
  }

  /** A plan written in the turn that took a revision request is that revision. */
  private link(planId: string, ts: number) {
    const plans = this.all;
    if (plans[planId]?.previous || plans[planId]?.revised) return;
    const from = Object.entries(plans)
      .filter(([id, p]) => id !== planId && p.revised && !p.revised.next && !p.revised.closed && ts >= p.revised.ts)
      .sort(([, a], [, b]) => b.revised!.ts - a.revised!.ts)[0];
    if (!from) return;
    const [oldId, old] = from;
    this.patch(oldId, (p) => ({ ...p, revised: { ...p.revised!, next: planId } }));
    this.patch(planId, (p) => ({ ...p, previous: { planId: oldId, text: this.planText(oldId), comments: old.revised!.comments, general: old.revised!.general } }));
  }

  /** A turn ended or a plan waits for approval. */
  private settle() {
    const idle = this.s.t.state.status === "idle";
    for (const [id, p] of Object.entries(this.all)) if (p.discussing) this.collect(id, p.discussing);
    this.rehome();
    for (const [id, p] of Object.entries(this.all)) {
      // The turn that took the revision request is over without a new plan: a later one isn't its revision.
      if (idle && p.revised && !p.revised.next && !p.revised.closed && this.s.t.messages.some((m) => m.role === "user" && m.ts >= p.revised!.ts))
        this.patch(id, (q) => ({ ...q, revised: { ...q.revised!, closed: true } }));
      if (p.previous && !p.check && (idle || this.request(id))) void this.check(id);
    }
  }

  /**
   * A held plan (approval declined to discuss it) followed by a newer plan: the same plan again
   * takes over its review; a different one is its revision.
   */
  private rehome() {
    const latest = this.latest();
    if (!latest?.text.trim()) return;
    for (const [id, p] of Object.entries(this.all)) {
      if (!p.held || id === latest.id || latest.ts < p.held) continue;
      const text = this.planText(id);
      if (squash(text) === squash(latest.text)) {
        this.patch(id, (q) => ({ ...q, draft: undefined, discussing: undefined, held: undefined }));
        this.patch(latest.id, (q) => ({
          ...q,
          draft: q.draft ?? p.draft,
          discussing: q.discussing ?? p.discussing,
          // With its own approval waiting, it isn't held.
          held: this.request(latest.id) ? q.held : p.held,
        }));
      } else {
        const comments = (p.draft?.comments ?? []).filter((c) => !c.resolved);
        const general = p.draft?.general ?? "";
        this.patch(id, (q) => ({ ...q, draft: undefined, held: undefined, revised: { comments, general, ts: p.held!, next: latest.id } }));
        if (!this.all[latest.id]?.previous) this.patch(latest.id, (q) => ({ ...q, previous: { planId: id, text, comments, general } }));
      }
    }
  }

  /** The agent's answer to a discussion (its turn after the request), split into the comment threads. */
  private collect(planId: string, disc: NonNullable<PlanReviewState["discussing"]>) {
    const msgs = this.s.t.messages;
    // The whole request: it quotes this plan's comments, so another plan's discussion can't match.
    const sent = disc.text.trim();
    let i = msgs.length - 1;
    while (i >= 0 && !(msgs[i]!.role === "user" && msgs[i]!.ts >= disc.ts - 2_000 && textOf(msgs[i]!).includes(sent))) i--;
    if (i < 0) {
      // Not taken yet; dropped (unsent and removed, or gone with a handoff) when the session is idle without it.
      const waiting = (this.s.t.state.pending ?? []).some((p) => p.text.includes(sent));
      if (this.s.t.state.status === "idle" && !waiting) this.patch(planId, (p) => ({ ...p, discussing: undefined }));
      return;
    }
    const said: string[] = [];
    for (let j = i + 1; j < msgs.length && msgs[j]!.role !== "user"; j++) if (msgs[j]!.role === "assistant") said.push(textOf(msgs[j]!));
    const answer = said.filter(Boolean).join("\n\n");
    if (!answer && this.s.t.state.status !== "idle") return;
    const model = this.s.t.state.model;
    const reply = (text: string) => ({ author: "agent" as const, text, id: `r${Date.now().toString(36)}${(replyN++).toString(36)}`, ...(model ? { model } : {}) });
    this.patch(planId, (p) => ({
      ...p,
      discussing: undefined,
      draft: answer ? addDiscussion(p.draft ?? EMPTY_DRAFT, parseDiscussion(answer, disc.ids), reply) : p.draft,
    }));
  }

  /** Once per revision: did the new plan address each comment? Without a verdict the comments show plain. */
  private async check(planId: string) {
    const prev = this.all[planId]?.previous;
    const text = this.planText(planId);
    if (!prev || !text.trim()) return;
    const { system, prompt, ids } = checkPrompt(prev.text, text, prev.comments, prev.general);
    if (!ids.length) return;
    this.patch(planId, (p) => ({ ...p, check: { status: "checking" } }));
    let check: PlanReviewState["check"] = { status: "failed" };
    try {
      const verdicts = parseVerdicts(parseJsonReply(await this.run({ system, prompt, timeoutMs: 120_000 })), ids);
      if (Object.keys(verdicts).length) check = { status: "done", verdicts };
    } catch (e: any) {
      console.error(`plan check for ${this.s.id} failed: ${e?.message ?? e}`);
    }
    this.patch(planId, (p) => ({ ...p, check }));
  }
}
