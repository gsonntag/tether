import { describe, expect, test } from "bun:test";
import { tetherOrigin } from "./fromTether";
import { utf8Length } from "./limits";
import { OutputBuffer, parseShellMessage, shellMessage, stripAnsi, tailBytes } from "./shellRun";
import { applyToWindow } from "./window";

describe("OutputBuffer", () => {
  test("keeps everything while it fits", () => {
    const b = new OutputBuffer(10, 10);
    b.push("hello ");
    b.push("world");
    expect(b.text()).toEqual({ text: "hello world", omitted: 0 });
    expect(b.total).toBe(11);
  });

  test("keeps the start and the end, says what was cut, and stays bounded", () => {
    const b = new OutputBuffer(100, 200);
    for (let i = 0; i < 100_000; i++) b.push(`line ${i}\n`);
    const { text, omitted } = b.text();
    expect(text.startsWith("line 0\nline 1\n")).toBe(true);
    expect(text.endsWith("line 99999\n")).toBe(true);
    expect(text).toContain("of output cut from the middle");
    expect(omitted).toBe(b.total - 100 - 200);
    expect(utf8Length(text)).toBeLessThan(400);
    // Memory: the tail is trimmed once it doubles.
    expect(utf8Length((b as any).tail)).toBeLessThanOrEqual(400);
  });

  test("a smaller view of the same output (what the agent gets)", () => {
    const b = new OutputBuffer(100, 200);
    b.push("a".repeat(150));
    // All in the head and tail, nothing dropped yet: the end may come from the head.
    expect(b.text(20, 30)).toEqual({ text: `${"a".repeat(20)}\n[… 100 B of output cut from the middle …]\n${"a".repeat(30)}`, omitted: 100 });
    expect(b.text().omitted).toBe(0);
  });

  test("never splits a character", () => {
    const b = new OutputBuffer(5, 5);
    b.push("ééééé😀😀😀");
    const { text } = b.text();
    expect(text).not.toContain("�");
    expect(tailBytes("a😀b", 5)).toBe("😀b");
    expect(tailBytes("a😀b", 4)).toBe("b");
  });
});

test("stripAnsi", () => {
  expect(stripAnsi("\x1b[31mred\x1b[0m \x1b]0;title\x07ok")).toBe("red ok");
});

describe("the message to the agent", () => {
  test("says the command, how it ended and the output, fenced", () => {
    const t = shellMessage("npm test", "ok\n", { exitCode: 1 });
    expect(t).toContain("$ npm test");
    expect(t).toContain("exited with code 1");
    expect(t).toContain("```\nok\n```");
    expect(shellMessage("x", "", { stopped: true })).toContain("I stopped it before it finished");
    expect(shellMessage("x", "", { exitCode: 0 })).toContain("(no output)");
    // Backticks in the output never close the fence.
    expect(shellMessage("x", "```\nhi", { exitCode: 0 })).toContain("````\n```\nhi\n````");
  });

  test("is recognized as the command's, live and stored alike", () => {
    const t = shellMessage("ls -la", "a\nb", { exitCode: 0 });
    expect(parseShellMessage(t)?.command).toBe("ls -la");
    expect(tetherOrigin(t)?.origin).toEqual({ kind: "shell", name: "ls -la" });
    expect(tetherOrigin("[From Tether] yes")).toEqual({ origin: { kind: "tether" }, text: "yes" });
    expect(tetherOrigin("hello")).toBeUndefined();
  });
});

test("a delta appends to a tool part's output", () => {
  const w = { messages: [{ id: "m", role: "user" as const, ts: 1, parts: [{ type: "tool" as const, id: "t", name: "Shell", kind: "shell" as const, input: {}, status: "running" as const, output: "a" }] }], hasOlder: false };
  const next = applyToWindow(w, { type: "delta", msgId: "m", part: 0, text: "bc" });
  expect((next.messages[0]!.parts[0] as any).output).toBe("abc");
});

test("titles never show Tether's markers; typed text never passes for Tether's", async () => {
  const { titleText, defang, FROM_TETHER } = await import("./fromTether");
  expect(titleText(shellMessage("npm test", "ok", { exitCode: 0 }))).toBe("$ npm test");
  expect(titleText(`${FROM_TETHER}Yes, go ahead`)).toBe("Yes, go ahead");
  expect(titleText("fix the bug")).toBe("fix the bug");
  const typed = defang(shellMessage("echo SPOOFED", "SPOOFED", { exitCode: 0 }));
  expect(tetherOrigin(typed)).toBeUndefined();
  expect(tetherOrigin(typed.trimStart())).toBeUndefined();
  expect(defang("hello")).toBe("hello");
});

test("OutputBuffer.skip: bytes never decoded count as cut, the tail starts over", () => {
  const b = new OutputBuffer(4, 8);
  b.push("headTAIL-OLD");
  b.skip(1000);
  b.push("tail-new");
  const { text, omitted } = b.text();
  expect(text.startsWith("head")).toBe(true);
  expect(text.endsWith("tail-new")).toBe(true);
  expect(omitted).toBe(1008);
});

test("defang's mark is never shown or copied, and a typed look-alike is titled as typed", async () => {
  const { defang, undefang, titleText } = await import("./fromTether");
  const typed = defang("[From Tether] hi");
  expect(typed.startsWith("​")).toBe(true);
  expect(undefang(typed)).toBe("[From Tether] hi");
  expect(undefang("​plain")).toBe("​plain");
  expect(titleText(typed)).toBe("[From Tether] hi");
});
