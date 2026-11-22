import { describe, expect, test } from "bun:test";
import type { RunnerInfo } from "../../shared/protocol";
import { ago, asksWorktree, canPin, loadKnown, offersCanText, mergeRunners, reconnected, saveKnown, textingDown, type KnownRunner } from "./runners";

const info = (id: string, connectedAt = 1): RunnerInfo => ({ id, name: id, hostname: id, version: "0", protocol: 1, harnesses: [], connectedAt });

test("runners you own that drop off the server's list stay, as disconnected", () => {
  const first = mergeRunners([], [info("b"), info("a")], 100);
  expect(first.map((r) => [r.id, r.online, r.lastSeen])).toEqual([["a", true, 100], ["b", true, 100]]);
  const second = mergeRunners(first, [info("b")], 200);
  expect(second.map((r) => [r.id, r.online, r.lastSeen])).toEqual([["b", true, 200], ["a", false, 100]]);
});

test("a runner shared with you that leaves the list is gone: unshared or offline, nothing of it stays", () => {
  const shared = (id: string): RunnerInfo => ({ ...info(id), access: "drive" });
  const first = mergeRunners([], [shared("theirs"), info("mine")], 100);
  expect(first.map((r) => r.id).sort()).toEqual(["mine", "theirs"]);
  const second = mergeRunners(first, [], 200);
  expect(second.map((r) => [r.id, r.online])).toEqual([["mine", false]]);
});

test("remembered runners are kept per person, and only the ones they own", () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    // An old list, kept by no one in particular: it goes.
    store.set("tether.runners", JSON.stringify([{ ...info("old"), online: false, lastSeen: 1 }]));
    expect(loadKnown("a@x.com")).toEqual([]);
    expect(store.has("tether.runners")).toBe(false);
    saveKnown(mergeRunners([], [info("mine"), { ...info("theirs"), access: "view" }], 5), "a@x.com");
    expect(loadKnown("a@x.com").map((r) => [r.id, r.online])).toEqual([["mine", false]]);
    // Someone else signed in on this browser sees none of it.
    expect(loadKnown("b@x.com")).toEqual([]);
    expect(loadKnown(undefined)).toEqual([]);
  } finally {
    delete (globalThis as any).localStorage;
  }
});

test("a runner that reconnected, or came online, needs fresh subscriptions", () => {
  const before: KnownRunner[] = mergeRunners([], [info("a", 1), info("b", 1)], 0);
  const after = mergeRunners(before, [info("a", 1), info("b", 2), info("c", 3)], 0);
  expect(reconnected(before, after).sort()).toEqual(["b", "c"]);
  const offline = mergeRunners(after, [], 0);
  expect(reconnected(after, offline)).toEqual([]);
  expect(reconnected(offline, mergeRunners(offline, [info("a", 1)], 0))).toEqual(["a"]);
});

test("relative times", () => {
  const now = 10_000_000;
  expect(ago(now - 5_000, now)).toBe("just now");
  expect(ago(now - 5 * 60_000, now)).toBe("5 min ago");
  expect(ago(now - 3 * 3600_000, now)).toBe("3 h ago");
  expect(ago(now - 72 * 3600_000, now)).toBe("3 days ago");
});

test("pin buttons only for a runner that says it takes pinSession", () => {
  const r = (id: string, extra: object = {}) => ({ id, name: id, hostname: "h", version: "1", protocol: 2, harnesses: [], ...extra });
  const list = [r("new", { pinning: true }), r("old")];
  expect(canPin(list, "new")).toBe(true);
  expect(canPin(list, "old")).toBe(false);
  expect(canPin(list, "gone")).toBe(false);
});

test("archiving asks about the worktree only on a runner that takes the answer, for one Tether made, when archiving", () => {
  const r = (id: string, extra: object = {}) => ({ id, name: id, hostname: "h", version: "1", protocol: 2, harnesses: [], ...extra });
  const list = [r("new", { archiveWorktree: true }), r("old")];
  const s = { worktreeOf: "/r/app" };
  expect(asksWorktree(list, "new", s)).toBe(true);
  expect(asksWorktree(list, "old", s)).toBe(false);
  expect(asksWorktree(list, "new", {})).toBe(false);
  expect(asksWorktree(list, "new", { ...s, worktreeHandMade: true })).toBe(false);
  expect(asksWorktree(list, "new", { ...s, archived: true })).toBe(false);
});

test("the \"Session can text me\" box: a runner that takes it, its owner, a main session", () => {
  const r = (extra: object = {}) => ({ id: "a", name: "a", hostname: "h", version: "1", protocol: 2, harnesses: [], canText: true, ...extra });
  const s: { parentSessionId?: string; sideOf?: string; projectPath: string } = { projectPath: "/p" };
  expect(offersCanText(r(), s)).toBe(true);
  expect(offersCanText(r({ canText: undefined }), s)).toBe(false);
  expect(offersCanText(undefined, s)).toBe(false);
  expect(offersCanText(r({ access: "drive" }), s)).toBe(false);
  expect(offersCanText(r(), { ...s, parentSessionId: "claude:main" })).toBe(false);
  expect(offersCanText(r(), { ...s, sideOf: "claude:main" })).toBe(false);
  // An older runner's Home agent chat: no box.
  expect(offersCanText(r({ homeFolder: "/home/agent" }), { ...s, projectPath: "/home/agent" })).toBe(false);
});

describe("texting down", () => {
  const r = (id: string, o: Partial<KnownRunner> = {}): KnownRunner => ({ id, name: id, hostname: "h", version: "1", protocol: 2, harnesses: [], online: true, lastSeen: 1, ...o });
  test("no hub: nothing to say; a hub that can text: nothing either", () => {
    expect(textingDown([r("a"), r("b")])).toBeUndefined();
    expect(textingDown([r("a"), r("dev", { textingHub: { up: true, images: false } })])).toBeUndefined();
  });
  test("the hub offline, or online but not connected, says so", () => {
    expect(textingDown([r("a"), r("dev", { online: false, textingHub: { up: true, images: false } })])).toBe("Texting is unavailable: dev is offline.");
    expect(textingDown([r("dev", { textingHub: { up: false, images: false } })])).toBe("Texting is unavailable: dev can't reach its messaging app.");
  });
  test("someone else's hub shared with you doesn't count", () => {
    expect(textingDown([r("theirs", { online: false, access: "drive", textingHub: { up: true, images: false } })])).toBeUndefined();
  });
});
