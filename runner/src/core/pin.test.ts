import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "../../../shared/transcript";
import { saveConfig } from "../config";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FakeAdapter } from "./fakeAdapter";
import { ReadState } from "./inbox";
import { LiveControl } from "./live";
import { OpRegistry } from "./ops";
import { Prefs } from "./prefs";
import { registerSessionOps } from "./sessionOps";
import { SessionCore } from "./sessions";
import { RECENT_MAX, RECENT_MS, SummaryBook } from "./summaries";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tether-pin-")), file = join(dir, "runner.json");
  saveConfig({ runnerId: "pin-test" }, file);
  const adapter = new FakeAdapter();
  adapter.addStored("one", []);
  adapter.addStored("two", []);
  adapter.addStored("old", [], { updatedAt: Date.now() - 10 * DAY });
  adapter.addStored("kid", [], { parentSessionId: "claude:one" });
  // A long delay: only an explicit flush writes the file.
  const prefs = new Prefs(file, 60_000);
  let clock = Date.now();
  const core = new SessionCore({ adapters: [adapter], bus: new EventBus<CoreEvents>(), send: () => true, prefs, epoch: "pin", log: () => {}, now: () => ++clock });
  new ReadState(core);
  const live = new LiveControl(core, new RequestBroker(), { idleMs: 60_000 });
  const ops = new OpRegistry();
  registerSessionOps(ops, core, live);
  cleanups.push(() => core.stop(), () => rmSync(dir, { recursive: true, force: true }));
  return { file, core, prefs, ops };
}

const saved = (file: string, id: string) => JSON.parse(readFileSync(file, "utf8")).sessions?.[id];
const pin = (ops: OpRegistry, sessionId: string, pinned: unknown) => ops.handle("pinSession", { sessionId, pinned });

describe("pinSession", () => {
  test("rejects a non-boolean and changes nothing", async () => {
    const { ops, prefs } = setup();
    for (const pinned of ["true", 1, undefined, null]) expect(await pin(ops, "claude:one", pinned)).toMatchObject({ ok: false });
    expect(prefs.get("claude:one").pinned).toBeUndefined();
  });

  test("persists and flushes, in pin order; a repeat changes nothing; unpin clears it", async () => {
    const { ops, core, prefs, file } = setup();
    await core.discover();
    expect(await pin(ops, "claude:two", true)).toMatchObject({ ok: true });
    expect(await pin(ops, "claude:one", true)).toMatchObject({ ok: true });
    // written at once, not after the prefs delay
    const two = saved(file, "claude:two").pinned, one = saved(file, "claude:one").pinned;
    expect(two).toBeGreaterThan(0);
    expect(one).toBeGreaterThan(two);
    expect(new Prefs(file).get("claude:one").pinned).toBe(one);
    expect(core.book.get("claude:one")?.pinned).toBe(one);
    expect((await core.open("claude:two")).summary.pinned).toBe(two);

    const before = readFileSync(file, "utf8");
    expect(await pin(ops, "claude:two", true)).toMatchObject({ ok: true });
    expect(prefs.get("claude:two").pinned).toBe(two);
    expect(readFileSync(file, "utf8")).toBe(before);

    expect(await pin(ops, "claude:two", false)).toMatchObject({ ok: true });
    expect(saved(file, "claude:two").pinned).toBeUndefined();
    expect((await core.open("claude:two")).summary.pinned).toBeUndefined();
    expect(core.book.get("claude:two")?.pinned).toBeUndefined();
    expect(core.book.get("claude:two")).toBeDefined();
  });

  test("a pinned session is listed however old, and leaves the list when unpinned", async () => {
    const { ops, core } = setup();
    await core.discover();
    expect(core.book.get("claude:old")).toBeUndefined();
    await pin(ops, "claude:old", true);
    expect(core.book.get("claude:old")?.pinned).toBeGreaterThan(0);
    await core.discover();
    expect(core.book.get("claude:old")).toBeDefined();
    await pin(ops, "claude:old", false);
    expect(core.book.get("claude:old")).toBeUndefined();
  });

  test("archiving unpins; an archived session or a subagent can't be pinned", async () => {
    const { ops, core, prefs } = setup();
    await pin(ops, "claude:one", true);
    await ops.handle("setSessionArchived", { sessionId: "claude:one", archived: true });
    expect(prefs.get("claude:one").pinned).toBeUndefined();
    expect((await core.open("claude:one")).summary.pinned).toBeUndefined();
    expect(await pin(ops, "claude:one", true)).toMatchObject({ ok: false });
    expect(prefs.get("claude:one").pinned).toBeUndefined();
    expect(await pin(ops, "claude:kid", true)).toMatchObject({ ok: false });
    expect(prefs.get("claude:kid").pinned).toBeUndefined();
    // unarchiving doesn't pin it again
    await ops.handle("setSessionArchived", { sessionId: "claude:one", archived: false });
    expect(prefs.get("claude:one").pinned).toBeUndefined();
  });

  test("search rows and decorated rows carry pinned from prefs, and drop a stale one", async () => {
    const { core, prefs } = setup();
    prefs.set("claude:one", { pinned: 5 });
    expect((await core.listSessions({ query: "session one" })).sessions[0]?.pinned).toBe(5);
    const row: SessionSummary = { id: "claude:two", harness: "claude", nativeId: "two", projectPath: "/p", title: "t", mode: "stored", status: "idle", updatedAt: 1, pinned: 9 };
    expect(core.book.decorate(row).pinned).toBeUndefined();
    expect(core.book.decorate({ ...row, id: "claude:one" }).pinned).toBe(5);
  });
});

test("Prefs.flush keeps a pinned entry past 90 days", () => {
  const file = join(mkdtempSync(join(tmpdir(), "tether-pin-prefs-")), "runner.json");
  cleanups.push(() => rmSync(join(file, ".."), { recursive: true, force: true }));
  const old = Date.now() - 200 * DAY;
  saveConfig({ runnerId: "box", sessions: { "claude:old": { at: old, title: "Old" }, "claude:kept": { at: old, pinned: old } } }, file);
  const p = new Prefs(file, 60_000);
  expect(p.pinned()).toEqual(["claude:kept"]);
  p.set("claude:new", { title: "New" });
  p.flush();
  const sessions = JSON.parse(readFileSync(file, "utf8")).sessions;
  expect(Object.keys(sessions).sort()).toEqual(["claude:kept", "claude:new"]);
  expect(sessions["claude:kept"]).toMatchObject({ pinned: old });
});

test("SummaryBook.refresh keeps pinned rows however old, outside the RECENT_MAX count", () => {
  const now = Date.now();
  const row = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({ id, harness: "claude", nativeId: id, projectPath: "/p", title: id, mode: "stored", status: "idle", updatedAt: now, ...over });
  const book = new SummaryBook("e", () => {}, () => now);
  const recent = Array.from({ length: RECENT_MAX }, (_, i) => row(`r${i}`, { updatedAt: now - i }));
  book.refresh([...recent, row("old", { updatedAt: now - 2 * RECENT_MS, pinned: 1 }), row("gone", { updatedAt: now - 2 * RECENT_MS }), row("newPin", { pinned: 2 })], () => false);
  const ids = new Set(book.list().map((s) => s.id));
  expect(ids.size).toBe(RECENT_MAX + 2);
  expect(ids.has("old")).toBe(true);
  expect(ids.has("newPin")).toBe(true);
  expect(ids.has("gone")).toBe(false);
});
