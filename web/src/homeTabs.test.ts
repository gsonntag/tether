import { expect, test } from "bun:test";
import { afterClose, canDelete, homeTag, loadTab, mergeHomeChat, NEW, nextHomeTag, pickTab, saveTab, tabLabel, tabMark, tabsOf } from "./homeTabs";

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

test("home names match the texts: h for the Texts tab, h1, h2, … for the others; h can't be deleted", () => {
  const labels = { t: 0, a: 1, c: 3 };
  expect(["t", "a", "c", "x"].map((id) => homeTag(labels, id))).toEqual(["h", "h1", "h3", undefined]);
  expect(homeTag(undefined, "a")).toBeUndefined();
  expect(canDelete(labels, "t")).toBe(false);
  expect(canDelete(labels, "a")).toBe(true);
  // A runner from before homes: every tab closes as before.
  expect(canDelete(undefined, "t")).toBe(true);
  expect(nextHomeTag(labels)).toBe("h2");
  expect(nextHomeTag({ t: 0 })).toBe("h1");
  expect(nextHomeTag(undefined)).toBe("h1");
});

test("tab updates: a newer rev replaces; the same rev fills in tabs and labels; labels of tabs still open are kept", () => {
  expect(mergeHomeChat(undefined, { rev: 1, chats: ["a"], labels: { a: 1 } })).toEqual({ rev: 1, chats: ["a"], labels: { a: 1 } });
  const cur = { rev: 2, sessionId: "b", chats: ["a", "b"] };
  expect(mergeHomeChat(cur, { rev: 1, chats: ["a"] })).toBeUndefined();
  expect(mergeHomeChat(cur, { rev: 2, chats: ["a"] })).toBeUndefined();
  // The broadcast with labels after this device's own tab change (same rev).
  expect(mergeHomeChat(cur, { rev: 2, sessionId: "b", chats: ["a", "b"], labels: { a: 1, b: 2 } })).toEqual({ rev: 2, sessionId: "b", chats: ["a", "b"], labels: { a: 1, b: 2 } });
  // A newer change made here (no labels yet): the open tabs keep theirs.
  expect(mergeHomeChat({ ...cur, labels: { a: 1, b: 2 } }, { rev: 3, sessionId: "a", chats: ["a"] })).toEqual({ rev: 3, sessionId: "a", chats: ["a"], labels: { a: 1 } });
});
