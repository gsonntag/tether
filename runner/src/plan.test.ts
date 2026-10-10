import { describe, expect, test } from "bun:test";
import { checklistMarkdown, formatPlanFeedback, quote } from "../../web/src/shared/plan";
import { applyEvent, emptyState, findPlan, type Transcript } from "../../web/src/shared/reducer";

describe("plan feedback", () => {
  test("quote + reply pairs in plan order, then the general comment", () => {
    const text = formatPlanFeedback(
      [
        { id: "b", quote: "Add a test in math.test.js", text: "Use bun:test instead.", offset: 80 },
        { id: "a", quote: "Add subtract to math.js", text: "Call it minus.", offset: 10 },
      ],
      "Otherwise looks good.",
    );
    expect(text).toBe("> Add subtract to math.js\nCall it minus.\n\n> Add a test in math.test.js\nUse bun:test instead.\n\nOtherwise looks good.");
  });

  test("multi-line quotes quote every line; blank lines stay inside the quote", () => {
    expect(quote("## Steps\n\n1. one\n2. two  ")).toBe("> ## Steps\n>\n> 1. one\n> 2. two");
  });

  test("comments without text are left out; nothing to send is empty", () => {
    expect(formatPlanFeedback([{ id: "a", quote: "x", text: "  ", offset: 0 }])).toBe("");
    expect(formatPlanFeedback([], "  ")).toBe("");
    expect(formatPlanFeedback([], "Just this")).toBe("Just this");
  });

  test("a checklist becomes a markdown task list", () => {
    expect(
      checklistMarkdown([
        { content: "Read the code", status: "completed" },
        { content: "Write the\nfix", status: "in_progress" },
        { content: "Run tests", status: "pending" },
      ]),
    ).toBe("- [x] Read the code\n- [ ] Write the fix _(in progress)_\n- [ ] Run tests");
  });
});

describe("plan parts in the reducer", () => {
  test("text deltas stream into a plan part, and findPlan finds it", () => {
    const t: Transcript = { messages: [], state: emptyState() };
    applyEvent(t, { type: "msg", msg: { id: "a1", role: "assistant", parts: [{ type: "plan", id: "p1", text: "" }], ts: 0 } });
    applyEvent(t, { type: "delta", msgId: "a1", part: 0, kind: "text", text: "# Plan\n" });
    applyEvent(t, { type: "delta", msgId: "a1", part: 0, kind: "text", text: "1. Do it" });
    const hit = findPlan(t.messages, "p1");
    expect(hit?.part.text).toBe("# Plan\n1. Do it");
    expect(hit?.msg.id).toBe("a1");
    expect(findPlan(t.messages, "nope")).toBeUndefined();
  });
});
