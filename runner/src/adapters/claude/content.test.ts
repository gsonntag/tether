import { expect, test } from "bun:test";
import { toolResults, userMessage } from "./content";

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
