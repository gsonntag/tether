import { describe, expect, test } from "bun:test";
import type { SlashCommand } from "./shared/protocol";
import { fuzzyScore } from "./shared/skill";
import { slashGroups, slashQuery } from "./slash";

const items: SlashCommand[] = [
  { name: "compact", description: "Clear history but keep a summary" },
  { name: "review", description: "Review a pull request" },
  { name: "grill-me", description: "Relentless design interviews", kind: "skill", sources: ["claude"] },
  { name: "code-review", description: "Find bugs in the diff", kind: "skill", sources: ["repo"], native: false },
  { name: "vercel:deploy", description: "Deploy to Vercel", kind: "command" },
];

describe("slash menu", () => {
  test("opens on a leading slash, closes at the first space", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/gri")).toBe("gri");
    expect(slashQuery("/grill-me about x")).toBeNull();
    expect(slashQuery("hi /x")).toBeNull();
  });

  test("groups skills before commands; empty query lists everything in order", () => {
    const g = slashGroups(items, "");
    expect(g.skills.map((s) => s.name)).toEqual(["grill-me", "code-review"]);
    expect(g.commands.map((s) => s.name)).toEqual(["compact", "review", "vercel:deploy"]);
    expect(g.flat.length).toBe(5);
  });

  test("fuzzy: prefix beats word start beats substring beats subsequence", () => {
    expect(slashGroups(items, "rev").flat.map((s) => s.name)).toEqual(["code-review", "review"]);
    expect(slashGroups(items, "gm").skills.map((s) => s.name)).toEqual(["grill-me"]);
    expect(slashGroups(items, "deploy").commands.map((s) => s.name)).toEqual(["vercel:deploy"]);
    expect(slashGroups(items, "zzz").flat).toEqual([]);
    const s = (q: string, n: string) => fuzzyScore(q, n)!;
    expect(s("re", "review")).toBeGreaterThan(s("re", "code-review"));
    expect(s("rev", "code-review")).toBeGreaterThan(s("rev", "prereview"));
    expect(s("cr", "code-review")).toBeGreaterThan(0);
    // scattered letters don't match
    expect(fuzzyScore("pir", "posthog:instrument-error-tracking")).toBeUndefined();
    // description matches rank last
    expect(fuzzyScore("interviews", "grill-me", "Relentless design interviews")).toBe(100);
  });
});
