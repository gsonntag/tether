import { expect, test } from "bun:test";
import { checked } from "./parts";

test("parts with the wrong types are made safe or dropped, good ones pass as they are", () => {
  const ok = { type: "text" as const, text: "hi" };
  expect(checked(ok)).toBe(ok);
  expect(checked({ type: "text", text: 42 } as any)).toEqual({ type: "text", text: "42" });
  expect(checked({ type: "thinking", text: null } as any)).toEqual({ type: "thinking", text: "" });
  expect(checked({ type: "tool", id: "t", name: "Bash", kind: "shell", input: {}, status: "done", output: { a: 1 } } as any)).toMatchObject({ output: '{"a":1}' });
  expect(checked({ type: "tool", id: 3 } as any)).toBeNull();
  expect(checked({ type: "video" } as any)).toBeNull();
  expect(checked(null as any)).toBeNull();
});
