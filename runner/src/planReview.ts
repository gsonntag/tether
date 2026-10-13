// Plan review on the runner (the formats are in web/src/shared/plan.ts). Each plan's review lives
// in LiveState.plans, so every browser on the session sees it live, and in a file per session:
//  - the draft comments, saved by whichever device is typing;
//  - Discuss: the comments go to the agent with short ids, and its answer is split back into the
//    threads once it's written;
//  - Revise: the comments are remembered, the next plan is linked to the one it revises, and the
//    background model checks once whether each comment was addressed.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveState, Msg, SessionEvent, UiResponse } from "../../web/src/shared/protocol";
import {
  addDiscussion,
  checkPrompt,
  cleanDraft,
  discussionMessage,
  EMPTY_DRAFT,
  formatPlanFeedback,
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

const fileOf = (sessionId: string) => join(CONFIG_DIR, "plans", `${sessionId.replace(/[^\w.-]/g, "_")}.json`);
const textOf = (m: Msg) => m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n").trim();
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
/** Drops fields set to undefined, so an empty review can be removed. */
const prune = (p: PlanReviewState): PlanReviewState => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));

let replyN = 0;

export class PlanReviews {
  private loaded = false;
  /** Approve after a discussion declined the approval: the plan the agent resubmits is approved without asking. */
  private approveNext?: string;

  constructor(
    private s: PlanHost,
    private run: (req: BackgroundRequest) => Promise<string> = (req) => runBackground(req),
  ) {}

  get all(): Record<string, PlanReviewState> {
    return this.s.t.state.plans ?? {};
  }

  /** Puts back what was saved (call once the session id is final). */
  load() {
    let plans: Record<string, PlanReviewState> = {};
    try {
      plans = JSON.parse(readFileSync(fileOf(this.s.id), "utf8")) ?? {};
    } catch {}
    // A check a restart cut short runs again (settle).
    for (const p of Object.values(plans)) if (p.check?.status === "checking") delete p.check;
    this.loaded = true;
    this.s.setState({ plans });
    this.settle();
  }

  private save() {
    if (this.s.id.includes(":pending-")) return;
    try {
      const file = fileOf(this.s.id);
      mkdirSync(join(CONFIG_DIR, "plans"), { recursive: true });
      writeFileSync(file + ".tmp", JSON.stringify(this.all));
      renameSync(file + ".tmp", file);
    } catch (e: any) {
      console.error(`saving plan reviews of ${this.s.id} failed: ${e?.message ?? e}`);
    }
  }

  private patch(planId: string, f: (p: PlanReviewState) => PlanReviewState) {
    const plans = { ...this.all };
    const next = prune(f(plans[planId] ?? {}));
    if (Object.keys(next).length) plans[planId] = next;
    else delete plans[planId];
    this.s.setState({ plans });
    this.save();
  }

  private request(planId: string) {
    return this.s.t.state.pendingUi.find((r) => r.kind === "plan" && r.planId === planId);
  }

  setDraft(planId: string, draft: PlanDraft | null) {
    const d = draft ? cleanDraft(draft) : undefined;
    this.patch(planId, (p) => ({ ...p, draft: d && !isEmptyDraft(d) ? mergeAgentReplies(d, p.draft) : undefined }));
  }

  /** Answers the waiting approval when there is one; false when there's none (or it just went). */
  private answer(planId: string, r: Omit<UiResponse, "id">): boolean {
    const req = this.request(planId);
    return !!req && this.s.uiRespond({ id: req.id, ...r });
  }

  async act(planId: string, action: PlanAction, draft: PlanDraft) {
    const d = cleanDraft(draft) ?? EMPTY_DRAFT;
    if (action === "discuss") {
      const { text, ids } = discussionMessage(d);
      if (!text) throw new Error("Write a comment first.");
      const waiting = !!this.request(planId);
      this.patch(planId, (p) => ({ ...p, draft: mergeAgentReplies(d, p.draft), discussing: { text, ids, ts: Date.now() }, held: waiting || p.held }));
      // Declining a waiting approval this way keeps the plan under review (the adapters see `discuss`).
      if (!this.answer(planId, { allow: false, value: text, discuss: true })) await this.s.prompt(text);
      return;
    }
    if (action === "revise") {
      const text = reviseMessage(d);
      if (!text) throw new Error("Write a comment first.");
      // Remembered first: the revised plan can come back before the prompt call returns.
      const before = this.all[planId]?.revised;
      this.patch(planId, (p) => ({ ...p, revised: { comments: d.comments, general: d.general, ts: Date.now() } }));
      try {
        if (!this.answer(planId, { allow: false, value: text })) await this.s.prompt(text);
      } catch (e) {
        this.patch(planId, (p) => ({ ...p, revised: before }));
        throw e;
      }
      this.patch(planId, (p) => ({ ...p, draft: undefined, discussing: undefined, held: undefined }));
      return;
    }
    const notes = formatPlanFeedback(d.comments, d.general, d.thread);
    if (this.answer(planId, { allow: true })) {
      if (notes) await this.s.prompt(notes, "steer");
    } else if (this.all[planId]?.held) {
      // The approval was declined to talk it over: the agent submits the plan again.
      const claude = this.s.harness === "claude-code";
      if (claude) this.approveNext = squash(findPlan(this.s.t.messages, planId)?.part.text ?? "");
      const ask = claude ? "I approve the plan as it stands. Call ExitPlanMode with it unchanged, then implement it." : "I approve the plan as it stands. Implement it now.";
      await this.s.prompt(notes ? `${ask}\n\nNotes for the work:\n\n${notes}` : ask);
    } else throw new Error("The plan isn't waiting for approval any more.");
    this.patch(planId, (p) => ({ ...p, draft: undefined, discussing: undefined, held: undefined }));
  }

  /** The agent resubmits a plan approved after a discussion: true (once) when it's that plan, unchanged. */
  autoApproves(text: string): boolean {
    const want = this.approveNext;
    this.approveNext = undefined;
    return !!want && squash(text) === want;
  }

  /** Every session event, after it was applied. */
  observe(e: SessionEvent) {
    if (!this.loaded) return;
    if (e.type === "msg" && e.msg.role === "assistant") for (const p of e.msg.parts) if (p.type === "plan") this.link(p.id, e.msg.ts);
    if (e.type === "state" && (e.state.status === "idle" || e.state.pendingUi?.some((r) => r.kind === "plan"))) this.settle();
  }

  /** A plan written after one was sent back for revision is its revision. */
  private link(planId: string, ts: number) {
    const plans = this.all;
    if (plans[planId]?.previous || plans[planId]?.revised) return;
    const from = Object.entries(plans)
      .filter(([id, p]) => id !== planId && p.revised && !p.revised.next && ts >= p.revised.ts)
      .sort(([, a], [, b]) => b.revised!.ts - a.revised!.ts)[0];
    if (!from) return;
    const [oldId, old] = from;
    const text = findPlan(this.s.t.messages, oldId)?.part.text ?? "";
    this.patch(oldId, (p) => ({ ...p, revised: { ...p.revised!, next: planId } }));
    this.patch(planId, (p) => ({ ...p, previous: { planId: oldId, text, comments: old.revised!.comments, general: old.revised!.general } }));
  }

  /** A turn ended or a plan waits for approval: collect discussion answers, check finished revisions. */
  private settle() {
    const idle = this.s.t.state.status === "idle";
    for (const [id, p] of Object.entries(this.all)) {
      if (p.discussing) this.collect(id, p.discussing);
      if (p.previous && !p.check && (idle || this.request(id))) void this.check(id);
    }
  }

  /** The agent's answer to a discussion, split into the comment threads. */
  private collect(planId: string, disc: NonNullable<PlanReviewState["discussing"]>) {
    const msgs = this.s.t.messages;
    const key = disc.text.slice(0, 120);
    let i = msgs.length - 1;
    while (i >= 0 && !(msgs[i]!.role === "user" && msgs[i]!.ts >= disc.ts - 2_000 && textOf(msgs[i]!).includes(key))) i--;
    if (i < 0) {
      // Not taken yet; dropped (unsent and removed, or gone with a handoff) when the session is idle without it.
      const waiting = (this.s.t.state.pending ?? []).some((p) => p.text.includes(key));
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
    const text = findPlan(this.s.t.messages, planId)?.part.text ?? "";
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
