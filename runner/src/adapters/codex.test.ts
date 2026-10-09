import { describe, expect, test } from "bun:test";
import { diffPairs, unwrapShell } from "./codex";

describe("unwrapShell", () => {
  test("bash -lc", () => expect(unwrapShell("/bin/bash -lc 'cat hello.txt'")).toBe("cat hello.txt"));
  test("escaped quote", () => expect(unwrapShell(`bash -lc 'echo '\\''hi'\\'' > a'`)).toBe("echo 'hi' > a"));
  test("double quotes", () => expect(unwrapShell(`zsh -c "echo \\"x\\""`)).toBe(`echo "x"`));
  test("plain", () => expect(unwrapShell("ls -la")).toBe("ls -la"));
  test("not a lone wrapper", () => expect(unwrapShell("bash -lc 'a' && rm -rf /")).toBe("bash -lc 'a' && rm -rf /"));
});

describe("diffPairs", () => {
  test("hunks", () =>
    expect(diffPairs("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n@@ -9 +9 @@\n-z\n+y", "update")).toEqual([
      { oldText: "keep\nold", newText: "keep\nnew" },
      { oldText: "z", newText: "y" },
    ]));
  test("added file content", () => expect(diffPairs("hi\n", "add")).toEqual([{ oldText: "", newText: "hi\n" }]));
});
