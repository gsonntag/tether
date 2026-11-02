import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerToServer } from "../../../shared/protocol";
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
import { SummaryBook } from "./summaries";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tether-archive-")), file = join(dir, "runner.json");
  saveConfig({ runnerId: "archive-test" }, file);
  const adapter = new FakeAdapter();
  adapter.addStored("one", []);
  adapter.addStored("two", [], { title: "Other" });
  const frames: RunnerToServer[] = [];
  // A long delay: only an explicit flush writes the file.
  const prefs = new Prefs(file, 60_000);
  const core = new SessionCore({ adapters: [adapter], bus: new EventBus<CoreEvents>(), send: (m) => (frames.push(m), true), prefs, epoch: "archive", log: () => {} });
  new ReadState(core);
  const live = new LiveControl(core, new RequestBroker(), { idleMs: 60_000 });
  const ops = new OpRegistry();
  registerSessionOps(ops, core, live);
  cleanups.push(() => core.stop(), () => rmSync(dir, { recursive: true, force: true }));
  return { file, adapter, core, prefs, ops };
}

const saved = (file: string, id: string) => JSON.parse(readFileSync(file, "utf8")).sessions?.[id];

describe("setSessionArchived", () => {
  test("rejects a non-boolean and changes nothing", async () => {
    const { ops, prefs } = setup();
    for (const archived of ["true", 1, undefined, null])
      expect(await ops.handle("setSessionArchived", { sessionId: "claude:one", archived })).toMatchObject({ ok: false });
    expect(prefs.get("claude:one").archived).toBeUndefined();
  });

  test("on a stored session: persists and flushes, a repeat changes nothing, unarchive clears it", async () => {
    const { ops, core, adapter, prefs, file } = setup();
    await core.discover();
    expect(core.book.get("claude:one")).toBeDefined();
    expect(await ops.handle("setSessionArchived", { sessionId: "claude:one", archived: true })).toMatchObject({ ok: true });
    // written at once, not after the prefs delay
    expect(saved(file, "claude:one")).toMatchObject({ archived: true });
    expect(new Prefs(file).get("claude:one").archived).toBe(true);
    const s = await core.open("claude:one");
    expect(s.summary.archived).toBe(true);
    expect(core.book.get("claude:one")).toBeUndefined();
    expect(adapter.drivers).toHaveLength(0);

    const at = prefs.get("claude:one").at;
    const before = readFileSync(file, "utf8");
    await new Promise((r) => setTimeout(r, 5));
    expect(await ops.handle("setSessionArchived", { sessionId: "claude:one", archived: true })).toMatchObject({ ok: true });
    expect(prefs.get("claude:one").at).toBe(at);
    expect(readFileSync(file, "utf8")).toBe(before);

    expect(await ops.handle("setSessionArchived", { sessionId: "claude:one", archived: false })).toMatchObject({ ok: true });
    expect(saved(file, "claude:one").archived).toBeUndefined();
    expect(s.summary.archived).toBeUndefined();
    expect(core.book.get("claude:one")?.archived).toBeUndefined();
    expect(core.book.get("claude:one")).toBeDefined();
  });

  test("listSessions hides archived rows without a query and includes them with one", async () => {
    const { ops, core } = setup();
    await ops.handle("setSessionArchived", { sessionId: "claude:one", archived: true });
    expect((await core.listSessions({ projectPath: "/p" })).sessions.map((s) => s.id)).toEqual(["claude:two"]);
    expect((await core.listSessions({})).sessions.map((s) => s.id)).toEqual(["claude:two"]);
    const found = (await core.listSessions({ query: "session one" })).sessions;
    expect(found.map((s) => [s.id, s.archived])).toEqual([["claude:one", true]]);
    expect((await core.listSessions({ projectPath: "/p", query: "one" })).sessions.map((s) => s.id)).toEqual(["claude:one"]);
  });
});

describe("archived on rows", () => {
  test("touch keeps archived from prefs and clears it on unarchive", async () => {
    const { core, prefs } = setup();
    const s = await core.open("claude:one");
    prefs.set(s.id, { archived: true });
    core.touch(s, { title: "x" });
    expect(s.summary.archived).toBe(true);
    core.touch(s, { archived: undefined });
    expect(s.summary.archived).toBe(true);
    prefs.set(s.id, { archived: undefined });
    core.touch(s, { archived: true });
    expect(s.summary.archived).toBeUndefined();
  });

  test("decorate takes archived from prefs either way", () => {
    const { core, prefs } = setup();
    const row: SessionSummary = { id: "claude:one", harness: "claude", nativeId: "one", projectPath: "/p", title: "t", mode: "stored", status: "idle", updatedAt: 1 };
    expect(core.book.decorate({ ...row, archived: true }).archived).toBeUndefined();
    prefs.set(row.id, { archived: true });
    expect(core.book.decorate(row).archived).toBe(true);
  });

  test("overlay (search rows) keeps archived and clears a stale one", async () => {
    const { core, prefs, adapter } = setup();
    adapter.addStored("three", [], { title: "Stale", archived: true });
    expect((await core.listSessions({ query: "stale" })).sessions[0]?.archived).toBeUndefined();
    prefs.set("claude:three", { archived: true });
    expect((await core.listSessions({ query: "stale" })).sessions[0]?.archived).toBe(true);
  });
});

test("Prefs.flush keeps an archived entry past 90 days", () => {
  const file = join(mkdtempSync(join(tmpdir(), "tether-archive-prefs-")), "runner.json");
  cleanups.push(() => rmSync(join(file, ".."), { recursive: true, force: true }));
  const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
  saveConfig({ runnerId: "box", sessions: { "claude:old": { at: old, title: "Old" }, "claude:kept": { at: old, archived: true } } }, file);
  const p = new Prefs(file, 60_000);
  p.set("claude:new", { title: "New" });
  p.flush();
  const sessions = JSON.parse(readFileSync(file, "utf8")).sessions;
  expect(Object.keys(sessions).sort()).toEqual(["claude:kept", "claude:new"]);
  expect(sessions["claude:kept"]).toMatchObject({ archived: true });
});

test("SummaryBook.refresh drops archived rows but keeps live and open ones", () => {
  const now = Date.now();
  const row = (id: string, over: Partial<SessionSummary> = {}): SessionSummary => ({ id, harness: "claude", nativeId: id, projectPath: "/p", title: id, mode: "stored", status: "idle", updatedAt: now, ...over });
  const book = new SummaryBook("e", () => {}, () => now);
  book.upsert([row("live", { mode: "live", archived: true }), row("open"), row("gone")]);
  book.refresh([row("live", { archived: true }), row("open", { archived: true }), row("gone", { archived: true }), row("plain"), row("new", { archived: true })], (id) => id === "live", (id) => id === "open");
  expect(book.list().map((s) => s.id).sort()).toEqual(["live", "open", "plain"]);
  expect(book.get("live")?.mode).toBe("live");
});
