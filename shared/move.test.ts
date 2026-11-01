import { describe, expect, test } from "bun:test";
import { archiveMarkdown, budgetFor, contextOpening, digest, estimateTokens, INLINE_IMAGES_MAX, LEVELS, mapMode, planImport, renderTool, TOOL_TEXT_MAX, type PortableSession } from "./move";
import type { Msg, ToolPart } from "./transcript";

const user = (id: string, text: string, ts = 1): Msg => ({ id, role: "user", ts, parts: [{ type: "text", text }] });
const reply = (id: string, text: string, ts = 2): Msg => ({ id, role: "assistant", ts, parts: [{ type: "text", text }] });
const tool: ToolPart = { type: "tool", id: "call_abc123", name: "bash", kind: "shell", input: { command: "ls" }, command: "ls", status: "done", output: "notes.txt" };
const session = (messages: Msg[]): PortableSession => ({ version: 1, from: { sessionId: "codex:1", harness: "codex", harnessLabel: "Codex", title: "T", projectPath: "/p" }, messages, subagents: [] });
const facts = { file: "/a/history.md", imagesDir: "/a/images" };

describe("tool calls", () => {
  test("travel as text, with no call id for the target to honor", () => {
    const text = renderTool(tool);
    expect(text).toContain("**Tool: bash**");
    expect(text).toContain("notes.txt");
    expect(text).not.toContain("call_abc123");
  });
  test("output with fences stays fenced", () => {
    expect(renderTool({ ...tool, output: "```\nx\n```" })).toContain("````\n```\nx\n```\n````");
  });
  test("in context a long output is cut and says where the rest is; the archive has it whole", () => {
    const long = "y".repeat(TOOL_TEXT_MAX + 500);
    const s = session([user("u", "go"), { id: "a", role: "assistant", ts: 2, parts: [{ ...tool, output: long }] }]);
    const plan = planImport(s, 100_000, facts);
    expect(plan.items.some((i) => i.text.includes("500 more characters in /a/history.md"))).toBe(true);
    expect(archiveMarkdown(s)).toContain(long);
  });
});

describe("a history bigger than the window", () => {
  const msgs = Array.from({ length: 400 }, (_, i) => [user(`u${i}`, `question ${i} ${"q".repeat(4000)}`), reply(`a${i}`, `answer ${i} ${"a".repeat(4000)}`)]).flat();
  const s = session(msgs);
  test("keeps the newest in order, says so, and stays under budget", () => {
    const plan = planImport(s, 20_000, facts);
    expect(plan.tokens).toBeLessThanOrEqual(20_000);
    expect(plan.kept).toBeGreaterThan(0);
    expect(plan.kept).toBeLessThan(plan.total);
    expect(plan.items.at(-1)!.text).toContain("answer 399");
    const n = plan.items.slice(1).map((i) => Number(/ (\d+) /.exec(i.text)![1]));
    expect(n).toEqual([...n].sort((a, b) => a - b));
    const opening = plan.items[0]!.text;
    expect(opening).toContain(`The newest ${plan.kept} of ${plan.total} messages`);
    expect(opening).toContain("/a/history.md");
    expect(opening).toContain("question 0");
  });
  test("the archive has every message", () => {
    const md = archiveMarkdown(s);
    for (const i of [0, 200, 399]) expect(md).toContain(`question ${i} `);
  });
  test("a small one goes whole, with no talk of what's left out", () => {
    const plan = planImport(session([user("u", "hi"), reply("a", "hello")]), 20_000, facts);
    expect(plan.kept).toBe(2);
    expect(plan.items[0]!.text).not.toContain("newest");
  });
});

test("a conversation ends with the agent, so no target waits on a turn nobody is running", () => {
  const plan = planImport(session([user("u", "cut off")]), 20_000, facts);
  expect(plan.items.at(-1)!.role).toBe("assistant");
});

test("images: the newest go as images up to a limit, the rest stay files; none on assistant turns", () => {
  const img = { type: "image" as const, mimeType: "image/png", data: "AAAA" };
  const msgs: Msg[] = Array.from({ length: INLINE_IMAGES_MAX + 3 }, (_, i) => ({ id: `u${i}`, role: "user" as const, ts: i, parts: [img] }));
  msgs.push({ id: "a", role: "assistant", ts: 99, parts: [img, { type: "text", text: "see" }] });
  const plan = planImport(session(msgs), 200_000, facts);
  expect(plan.items.flatMap((i) => i.images ?? []).length).toBe(INLINE_IMAGES_MAX);
  expect(plan.items.at(-1)!.images).toBeUndefined();
  expect(plan.items.at(-1)!.text).toContain("[image:");
  expect(plan.items.slice(1, 4).every((i) => i.text.includes("[image:"))).toBe(true);
});

test("compaction summaries and subagents are carried", () => {
  const notice: Msg = { id: "c", role: "notice", ts: 3, parts: [{ type: "text", text: "Context compacted." }], compactSummary: "They chose Postgres." };
  const s = { ...session([user("u", "hi"), notice, reply("a", "ok")]), subagents: [{ id: "x", title: "Count lines", parentToolId: "t", messages: [reply("sa", "412 lines")], subagents: [] }] };
  expect(archiveMarkdown(s)).toContain("They chose Postgres.");
  expect(archiveMarkdown(s)).toContain("412 lines");
  expect(planImport(s, 20_000, facts).items.some((i) => i.text.includes("They chose Postgres."))).toBe(true);
  expect(digest(s.messages, s.subagents)).toContain("Count lines");
});

test("the file route's opening has the summary, the last reply, and asks for nothing to run", () => {
  const t = contextOpening(session([user("u", "fix the bug"), reply("a", "It's fixed")]), facts);
  for (const w of ["/a/history.md", "fix the bug", "It's fixed", "Don't run anything"]) expect(t).toContain(w);
  expect(t.startsWith("[From Tether] ")).toBe(true);
});

test("background work is stated to the agent", () => {
  expect(planImport(session([user("u", "x"), reply("a", "y")]), 20_000, { ...facts, background: true }).items[0]!.text).toContain("Background work keeps running");
});

describe("budget", () => {
  test("half the window, capped; a guess when it isn't known", () => {
    expect(budgetFor(200_000)).toBe(100_000);
    expect(budgetFor(1_000_000)).toBe(200_000);
    expect(budgetFor(undefined)).toBe(80_000);
  });
  test("an image counts for more than its text", () => {
    expect(estimateTokens(4, 1)).toBeGreaterThan(1000);
  });
});

describe("modes", () => {
  const modes = [
    { mode: "r", level: LEVELS.readOnly },
    { mode: "a", level: LEVELS.ask },
    { mode: "f", level: LEVELS.full },
  ];
  test("the nearest at or under; unknown the safest", () => {
    expect(mapMode(LEVELS.full, modes)).toBe("f");
    expect(mapMode(LEVELS.judged, modes)).toBe("a");
    expect(mapMode(LEVELS.ask, modes)).toBe("a");
    expect(mapMode(undefined, modes)).toBe("r");
  });
});
