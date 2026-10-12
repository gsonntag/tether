import { describe, expect, test } from "bun:test";
import { commandRunsHow, fromLabel } from "./library";

describe("library labels", () => {
  const label = (s: string) => ({ claude: "Claude Code", codex: "Codex" })[s.slice(0, s.indexOf(":"))] ?? s;
  test("fromLabel", () => {
    expect(fromLabel(["you", "claude:~/.claude/commands/x.md"], label)).toBe("Added by you");
    expect(fromLabel(["claude:~/a.md", "codex:~/b.md", "claude:~/c.md"], label)).toBe("From Claude Code, Codex");
    expect(fromLabel([], label)).toBe("");
  });
  test("commandRunsHow", () => {
    expect(commandRunsHow(true)).toContain("runs it itself");
    expect(commandRunsHow(false)).toContain("fills in");
  });
});
