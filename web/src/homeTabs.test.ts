import { expect, test } from "bun:test";
import { afterClose, loadTab, NEW, pickTab, saveTab, tabLabel, tabMark, tabsOf } from "./homeTabs";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

test("the tab this device shows is kept per runner", () => {
  const s = memory();
  expect(loadTab("r1", s)).toBeUndefined();
  saveTab("r1", "claude:a", s);
  saveTab("r2", NEW, s);
  expect(loadTab("r1", s)).toBe("claude:a");
  expect(loadTab("r2", s)).toBe(NEW);
});

test("the tabs: the runner's list, or a runner from before tabs' one chat", () => {
  expect(tabsOf({ sessionId: "b", chats: ["a", "b"] })).toEqual(["a", "b"]);
  expect(tabsOf({ sessionId: "b" })).toEqual(["b"]);
  expect(tabsOf({ chats: [] })).toEqual([]);
  expect(tabsOf(undefined)).toEqual([]);
});

test("the tab shown: the one picked while it's open, else the current one, else the newest, else a new one", () => {
  expect(pickTab(["a", "b", "c"], "a", "c")).toBe("a");
  expect(pickTab(["a", "b", "c"], NEW, "c")).toBe(NEW);
  // Closed on another device: the current one.
  expect(pickTab(["b", "c"], "a", "b")).toBe("b");
  expect(pickTab(["b", "c"], undefined, undefined)).toBe("c");
  expect(pickTab([], "a", undefined)).toBe(NEW);
});

test("closing a tab shows its right neighbour, else its left, else a new one", () => {
  expect(afterClose(["a", "b", "c"], "b")).toBe("c");
  expect(afterClose(["a", "b", "c"], "c")).toBe("b");
  expect(afterClose(["a"], "a")).toBe(NEW);
  expect(afterClose(["a", "b"], "x")).toBe("b");
});

test("a tab's name and marker", () => {
  expect(tabLabel("Fix the\n sidebar")).toBe("Fix the sidebar");
  expect(tabLabel("[From Tether] Report")).toBe("Report");
  expect(tabLabel("")).toBe("New chat");
  expect(tabLabel("Untitled")).toBe("New chat");
  expect(tabLabel("New session")).toBe("New chat");
  expect(tabLabel(undefined)).toBe("New chat");
  expect(tabMark({ status: "running" }, false)).toBe("running");
  expect(tabMark({ status: "running", requests: 1 }, true)).toBe("waiting");
  expect(tabMark({ status: "idle", unread: "finished" }, false)).toBe("unread");
  expect(tabMark({ status: "idle", unread: "failed" }, false)).toBe("failed");
  // The tab in view has nothing unread: it's being read.
  expect(tabMark({ status: "idle", unread: "finished" }, true)).toBeUndefined();
  expect(tabMark(undefined, false)).toBeUndefined();
});
