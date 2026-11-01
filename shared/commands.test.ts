import { describe, expect, test } from "bun:test";
import { menuMatches, menuPick, menuQuery, parseCommand, settingRoute, type HarnessCommand } from "./commands";

const list: HarnessCommand[] = [
  { name: "posthog:compact-thing", description: "" },
  { name: "compact", description: "", args: "<instructions>" },
  { name: "recompute", description: "" },
  { name: "usage", description: "", aliases: ["cost"] },
];

describe("reading the box", () => {
  test("a command: a name at the start, then anything", () => {
    expect(parseCommand("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseCommand("  /goal the tests pass\nand lint ")).toEqual({ name: "goal", args: "the tests pass\nand lint" });
    expect(parseCommand("/posthog:skill x")?.name).toBe("posthog:skill");
  });
  test("paths and prose aren't commands", () => {
    for (const t of ["/tmp/x", "/etc/hostname is a file", "/", "hello /compact", "//x"]) expect(parseCommand(t)).toBeUndefined();
  });
  test("the menu searches only while the box holds / and a name", () => {
    expect(menuQuery("/")).toBe("");
    expect(menuQuery("/go")).toBe("go");
    for (const t of ["/go ", "/tmp/x", "x/", "", "!/go"]) expect(menuQuery(t)).toBeUndefined();
  });
});

describe("the menu", () => {
  test("names starting with the search first, a plugin's after the session's own", () => {
    expect(menuMatches(list, "comp").map((c) => c.name)).toEqual(["compact", "recompute", "posthog:compact-thing"]);
    expect(menuMatches(list, "").at(-1)?.name).toBe("posthog:compact-thing");
  });
  test("the whole name comes first", () => {
    expect(menuMatches([{ name: "review-it", description: "" }, { name: "review", description: "" }], "review")[0]?.name).toBe("review");
  });
  test("an alias finds its command", () => {
    expect(menuMatches(list, "cos").map((c) => c.name)).toEqual(["usage"]);
  });
  test("Enter sends what takes nothing or is typed in full; a command that takes arguments waits", () => {
    const compact = list[1]!;
    expect(menuPick(compact, "/com", "Enter")).toBe("fill");
    expect(menuPick(compact, "/compact", "Enter")).toBe("send");
    expect(menuPick(list[2]!, "/re", "Enter")).toBe("send");
    expect(menuPick(list[2]!, "/re", "Tab")).toBe("fill");
    expect(menuPick(list[2]!, "/re", "tap")).toBe("fill");
  });
  test("/model and /effort are the header's; a bare /rename isn't", () => {
    expect(settingRoute("model", "haiku")).toEqual({ setting: "model", value: "haiku" });
    expect(settingRoute("effort", "")).toEqual({ setting: "effort" });
    expect(settingRoute("rename", "")).toBeUndefined();
  });
});
