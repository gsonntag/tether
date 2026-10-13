import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addDiscussion,
  cleanDraft,
  discussionMessage,
  mergeAgentReplies,
  parseDiscussion,
  parseVerdicts,
  reviseMessage,
  type PlanComment,
  type PlanDraft,
} from "../../web/src/shared/plan";
import type { LiveState, Msg, SessionEvent, UiResponse } from "../../web/src/shared/protocol";
import { applyEvent, emptyState, type Transcript } from "../../web/src/shared/reducer";
import { CONFIG_DIR } from "./config";
import { PlanReviews, type PlanHost } from "./planReview";

const c = (id: string, offset: number, text: string, quote = `quote ${id}`): PlanComment => ({ id, quote, text, offset });

describe("discussion format", () => {
  test("comments get short ids in plan order; the reply is split back by id", () => {
    const d: PlanDraft = { comments: [c("b", 50, "Why B?"), c("a", 10, "Why A?")], general: "And overall?" };
    const { text, ids } = discussionMessage(d);
    expect(ids).toEqual(["a", "b"]);
    expect(text).toContain("### [C1]\n> quote a\nWhy A?");
    expect(text).toContain("### [C2]\n> quote b\nWhy B?");
    expect(text).toContain("### [general]\nAnd overall?");
    const reply = "Sure, here goes.\n\n### [C1]\nA is needed.\n\n**[C2]**\nB could go; the plan needs a change.\n\n### [general]\nLooks fine.";
    expect(parseDiscussion(reply, ids)).toEqual({ byId: { a: "A is needed.", b: "B could go; the plan needs a change." }, general: "Sure, here goes.\n\nLooks fine." });
  });

  test("an answer without sections is kept whole as a general reply; unknown ids go there too", () => {
    expect(parseDiscussion("I think the plan is fine.", ["a"])).toEqual({ byId: {}, general: "I think the plan is fine." });
    expect(parseDiscussion("### [C7]\nWhat?\n### [C1]\nYes.", ["a"])).toEqual({ byId: { a: "Yes." }, general: "What?" });
  });

  test("answers land in the threads; answers to deleted comments go to the general thread", () => {
    const d: PlanDraft = { comments: [c("a", 0, "Why?")], general: "" };
    const out = addDiscussion(d, { byId: { a: "Because.", gone: "Old answer." }, general: "" }, (text) => ({ author: "agent", text, id: text }));
    expect(out.comments[0]!.replies).toEqual([{ author: "agent", text: "Because.", id: "Because." }]);
    expect(out.thread).toEqual([{ author: "agent", text: "Old answer.", id: "Old answer." }]);
  });

  test("revise asks for a revised plan; nothing to say is empty", () => {
    expect(reviseMessage({ comments: [c("a", 0, "Use bun")], general: "" })).toBe(
      "Please revise the plan to address my comments, then present the revised plan for review.\n\n> quote a\nUse bun",
    );
    expect(reviseMessage({ comments: [], general: " " })).toBe("");
  });
});

describe("drafts", () => {
  test("old drafts (string replies) are cleaned up; junk isn't a draft", () => {
    expect(cleanDraft({ comments: [{ id: "a", quote: "q", text: "t", offset: 3, anchor: "q", replies: ["more"] }], general: "g" })).toEqual({
      comments: [{ id: "a", quote: "q", text: "t", offset: 3, anchor: "q", replies: [{ author: "user", text: "more" }] }],
      general: "g",
    });
    expect(cleanDraft({ nope: 1 })).toBeUndefined();
  });

  test("saving an older copy keeps agent replies that arrived meanwhile, in place", () => {
    const agent = { author: "agent" as const, text: "Because.", id: "r1" };
    const current: PlanDraft = { comments: [{ ...c("a", 0, "Why?"), replies: [{ author: "user", text: "Hm" }, agent] }], general: "", thread: [{ author: "agent", text: "Hi", id: "r2" }] };
    const typing: PlanDraft = { comments: [{ ...c("a", 0, "Why? (edited)"), replies: [{ author: "user", text: "Hm" }] }], general: "x" };
    const merged = mergeAgentReplies(typing, current);
    expect(merged.comments[0]!.text).toBe("Why? (edited)");
    expect(merged.comments[0]!.replies).toEqual([{ author: "user", text: "Hm" }, agent]);
    expect(merged.thread).toEqual([{ author: "agent", text: "Hi", id: "r2" }]);
    // a comment deleted on this device stays deleted
    expect(mergeAgentReplies({ comments: [], general: "" }, current).comments).toEqual([]);
  });

  test("verdicts map back to comment ids; unknown statuses are dropped", () => {
    const json = { verdicts: [{ id: "C1", status: "addressed", reason: "Done." }, { id: "[C2]", status: "Partly", reason: "Half" }, { id: "C3", status: "maybe" }] };
    expect(parseVerdicts(json, ["a", "b", "c"])).toEqual({ a: { status: "addressed", reason: "Done." }, b: { status: "partly", reason: "Half" } });
  });
});

/** A session stand-in: the transcript, prompts sent, approvals answered. */
function host(id: string, harness = "claude-code") {
  const t: Transcript = { messages: [], state: { ...emptyState(), status: "idle" } };
  const sent: string[] = [];
  const responses: UiResponse[] = [];
  let reviews!: PlanReviews;
  const emit = (e: SessionEvent) => {
    applyEvent(t, e);
    reviews.observe(e);
  };
  const h: PlanHost = {
    id,
    harness,
    t,
    setState: (state: Partial<LiveState>) => emit({ type: "state", state }),
    prompt: async (text) => void sent.push(text),
    uiRespond: (r) => {
      responses.push(r);
      t.state.pendingUi = t.state.pendingUi.filter((u) => u.id !== r.id);
      return true;
    },
  };
  let check = async (_: any) => JSON.stringify({ verdicts: [{ id: "C1", status: "addressed", reason: "Uses bun now." }] });
  reviews = new PlanReviews(h, (req) => check(req));
  const plan = (msgId: string, planId: string, text: string, ts = Date.now()) =>
    emit({ type: "msg", msg: { id: msgId, role: "assistant", parts: [{ type: "plan", id: planId, text }], ts } });
  const say = (role: Msg["role"], text: string) => emit({ type: "msg", msg: { id: `m${t.messages.length}`, role, parts: [{ type: "text", text }], ts: Date.now() } });
  return { t, sent, responses, reviews, emit, plan, say, setCheck: (f: typeof check) => (check = f) };
}

describe("plan reviews on the runner", () => {
  test("drafts are kept per plan, saved to disk, and come back on load", () => {
    const h = host("claude-code:s1");
    h.reviews.load();
    expect(h.t.state.plans).toEqual({});
    h.reviews.setDraft("p1", { comments: [c("a", 0, "Hm")], general: "" });
    expect(h.t.state.plans?.p1?.draft?.comments[0]?.text).toBe("Hm");
    const again = host("claude-code:s1");
    again.reviews.load();
    expect(again.t.state.plans?.p1?.draft?.comments[0]?.text).toBe("Hm");
    h.reviews.setDraft("p1", null);
    expect(h.t.state.plans).toEqual({});
    expect(JSON.parse(readFileSync(join(CONFIG_DIR, "plans", "claude-code_s1.json"), "utf8"))).toEqual({});
  });

  test("discuss on a waiting plan declines it without a verdict, then splits the answer into the threads", async () => {
    const h = host("claude-code:s2");
    h.reviews.load();
    h.plan("a1", "p1", "1. Do it");
    h.emit({ type: "state", state: { status: "running", pendingUi: [{ id: "req1", kind: "plan", title: "Plan", planId: "p1" }] } });
    await h.reviews.act("p1", "discuss", { comments: [c("a", 0, "Why?")], general: "" });
    expect(h.responses).toEqual([{ id: "req1", allow: false, value: expect.stringContaining("### [C1]"), discuss: true }]);
    expect(h.t.state.plans?.p1).toMatchObject({ held: true, discussing: { ids: ["a"] } });
    // the adapter adds the request as a user message; the agent answers; the turn ends
    h.say("user", h.responses[0]!.value!);
    h.say("assistant", "### [C1]\nBecause it's needed.");
    h.emit({ type: "state", state: { status: "idle", pendingUi: [] } });
    const review = h.t.state.plans!.p1!;
    expect(review.discussing).toBeUndefined();
    expect(review.draft?.comments[0]?.replies).toEqual([{ author: "agent", text: "Because it's needed.", id: expect.any(String) }]);
    // Approve now: the agent resubmits the same plan, which is approved without asking
    await h.reviews.act("p1", "approve", review.draft!);
    expect(h.sent.at(-1)).toContain("Call ExitPlanMode with it unchanged");
    expect(h.reviews.autoApproves("1.  Do it")).toBe(true);
    expect(h.reviews.autoApproves("1. Do it")).toBe(false); // once
    expect(h.t.state.plans?.p1).toBeUndefined();
  });

  test("revise remembers the comments; the next plan is linked and checked once", async () => {
    const h = host("claude-code:s3");
    h.reviews.load();
    h.plan("a1", "p1", "1. Use npm", Date.now() - 1000);
    let calls = 0;
    h.setCheck(async (req) => {
      calls++;
      expect(req.prompt).toContain("<old_plan>\n1. Use npm");
      expect(req.prompt).toContain("<new_plan>\n1. Use bun");
      return 'Sure: {"verdicts":[{"id":"C1","status":"addressed","reason":"Uses bun now."}]}';
    });
    await h.reviews.act("p1", "revise", { comments: [c("a", 0, "Use bun")], general: "" });
    expect(h.sent[0]).toContain("Please revise the plan");
    expect(h.t.state.plans?.p1).toMatchObject({ revised: { comments: [{ id: "a" }] } });
    expect(h.t.state.plans?.p1?.draft).toBeUndefined();
    h.plan("a2", "p2", "1. Use bun");
    expect(h.t.state.plans?.p2?.previous).toMatchObject({ planId: "p1", text: "1. Use npm" });
    expect(h.t.state.plans?.p1?.revised?.next).toBe("p2");
    h.emit({ type: "state", state: { status: "running", pendingUi: [{ id: "req2", kind: "plan", title: "Plan", planId: "p2" }] } });
    expect(h.t.state.plans?.p2?.check).toEqual({ status: "checking" });
    await Bun.sleep(0);
    expect(h.t.state.plans?.p2?.check).toEqual({ status: "done", verdicts: { a: { status: "addressed", reason: "Uses bun now." } } });
    h.emit({ type: "state", state: { status: "idle", pendingUi: [] } });
    expect(calls).toBe(1);
  });

  test("a failing check leaves the comments without a status", async () => {
    const h = host("codex:s4", "codex");
    h.reviews.load();
    h.plan("a1", "p1", "old", Date.now() - 1000);
    h.setCheck(async () => {
      throw new Error("no model");
    });
    await h.reviews.act("p1", "revise", { comments: [c("a", 0, "Change it")], general: "" });
    h.plan("a2", "p2", "new");
    h.emit({ type: "state", state: { status: "idle" } });
    await Bun.sleep(0);
    expect(h.t.state.plans?.p2?.check).toEqual({ status: "failed" });
    expect(existsSync(join(CONFIG_DIR, "plans", "codex_s4.json"))).toBe(true);
  });
});
