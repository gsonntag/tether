import { expect, test } from "bun:test";
import { injected, toolResults, userMessage } from "./content";

test("Tether's own message reads as Tether's, not as something you typed", () => {
  const m = userMessage("[From Tether] The user approved your request to use Write on /p/a. Go ahead.", "u1", 1, { origin: { kind: "human" } } as any);
  expect(m).toEqual({ id: "u1", role: "user", ts: 1, origin: { kind: "tether" }, parts: [{ type: "text", text: "The user approved your request to use Write on /p/a. Go ahead." }] });
  expect(userMessage("hello", "u2", 1)?.origin).toBeUndefined();
});

test("a permission prompt cut off by its process closing shows no abort error", () => {
  const [r] = toolResults([{ type: "tool_result", tool_use_id: "t", is_error: true, content: "Tool permission request failed: AbortError: Tool permission request was aborted" }]);
  expect(r).toEqual({ toolId: "t", status: "error", output: "" });
  const [k] = toolResults([{ type: "tool_result", tool_use_id: "t", is_error: true, content: "The user denied this." }]);
  expect(k!.output).toBe("The user denied this.");
});

test("a command's output reads as the command's, only on a turn that came in as typed", async () => {
  const { shellMessage } = await import("../../../../shared/shellRun");
  const { titleOf } = await import("./discovery");
  const t = shellMessage("npm test", "ok", { exitCode: 0 });
  expect(injected(t, {}, "u1", 1)?.origin).toEqual({ kind: "shell", name: "npm test" });
  expect(injected(t, { origin: { kind: "human" } } as any, "u1", 1)?.origin?.kind).toBe("shell");
  // From another session: that session's, whatever it starts with.
  expect(injected(t, { origin: { kind: "peer", from: "other" } } as any, "u1", 1)?.origin?.kind).toBe("peer");
  // Titled by the command, never by the marker.
  expect(titleOf({ firstPrompt: t, summary: "" })).toBe("$ npm test");
});
