import { describe, expect, test } from "bun:test";
import { approveMessage, approveNotes, cleanDraft, formatPlanFeedback, IMPLEMENT_PROMPT, inPlanOrder, isEmptyDraft, locateAnchor, planKey, quote, reviseMessage, type PlanComment } from "./plan";

const c = (id: string, quote: string, text: string, offset: number, anchor?: string): PlanComment => ({ id, quote, text, offset, ...(anchor !== undefined ? { anchor } : {}) });

describe("plan feedback", () => {
  test("a quote is a blockquote, line by line, blank lines kept as >", () => {
    expect(quote("  one\n\ntwo  \n")).toBe("> one\n>\n> two");
  });

  test("one block per comment, in plan order, then the general comment", () => {
    const text = formatPlanFeedback([c("b", "Step 2: tests", "Use bun test.", 40), c("a", "Step 1: schema", "Add an index.", 3)], "Looks good otherwise.");
    expect(text).toBe("> Step 1: schema\n\nAdd an index.\n\n> Step 2: tests\n\nUse bun test.\n\nLooks good otherwise.");
  });

  test("comments at the same place keep the order they were written in", () => {
    expect(inPlanOrder([c("x", "q", "1", 5), c("y", "q", "2", 5), c("z", "q", "0", 1)]).map((x) => x.id)).toEqual(["z", "x", "y"]);
  });

  test("empty comments are left out, and a comment with no quote is just its text", () => {
    expect(formatPlanFeedback([c("a", "q", "   ", 0), c("b", "", "Plain.", 1)])).toBe("Plain.");
    expect(formatPlanFeedback([], "  ")).toBe("");
  });

  test("revise asks for a revised plan; nothing to say, nothing to send", () => {
    expect(reviseMessage({ comments: [c("a", "Use Redis", "Why not SQLite?", 0)], general: "" })).toBe(
      "Please revise the plan to address my comments, then present the revised plan for review.\n\n> Use Redis\n\nWhy not SQLite?",
    );
    expect(reviseMessage({ comments: [], general: "" })).toBe("");
  });

  test("approve: notes are the feedback; the follow-up message says to go ahead", () => {
    expect(approveNotes({ comments: [c("a", "x", "y", 0)], general: "z" })).toBe("> x\n\ny\n\nz");
    expect(approveMessage("")).toBe(IMPLEMENT_PROMPT);
    expect(approveMessage("> x\n\ny")).toBe(`${IMPLEMENT_PROMPT}\n\nNotes on the plan:\n\n> x\n\ny`);
  });

  test("an empty draft", () => {
    expect(isEmptyDraft(undefined)).toBe(true);
    expect(isEmptyDraft({ comments: [c("a", "q", " ", 0)], general: "" })).toBe(true);
    expect(isEmptyDraft({ comments: [], general: "x" })).toBe(false);
  });

  test("cleanDraft keeps what's a draft and drops the rest", () => {
    expect(cleanDraft(null)).toBeUndefined();
    expect(cleanDraft({ comments: "no" })).toBeUndefined();
    expect(cleanDraft({ comments: [{ id: "a", text: "t", quote: "q", offset: "7", anchor: "q " }, { id: 3 }], general: 5 })).toEqual({ comments: [{ id: "a", text: "t", quote: "q", offset: 7, anchor: "q " }], general: "" });
  });
});

describe("anchors", () => {
  const text = "Plan\nStep one: add a table.\nStep two: add a table.";

  test("found at its offset when the text there is unchanged", () => {
    expect(locateAnchor(text, { offset: 28, anchor: "Step two" })).toBe(28);
  });

  test("followed when the plan moved under it", () => {
    expect(locateAnchor("Intro\n" + text, { offset: 5, anchor: "Step one" })).toBe(11);
  });

  test("an anchor matching twice stays at its own offset", () => {
    expect(locateAnchor(text, { offset: 38, anchor: "add a table" })).toBe(38);
    expect(locateAnchor(text, { offset: 0, anchor: "add a table" })).toBe(15);
  });

  test("gone, or never anchored: -1", () => {
    expect(locateAnchor(text, { offset: 0, anchor: "Step three" })).toBe(-1);
    expect(locateAnchor(text, { offset: 0 })).toBe(-1);
  });

  test("plan keys differ by text and stay the same for the same text", () => {
    expect(planKey("a plan")).toBe(planKey("a plan"));
    expect(planKey("a plan")).not.toBe(planKey("a plan."));
  });
});
