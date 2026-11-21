import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../config";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FakeAdapter } from "./fakeAdapter";
import { LiveControl } from "./live";
import { OpRegistry } from "./ops";
import { Prefs } from "./prefs";
import { registerSessionOps } from "./sessionOps";
import { SessionCore } from "./sessions";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tether-cantext-")), file = join(dir, "runner.json");
  saveConfig({ runnerId: "cantext-test" }, file);
  const adapter = new FakeAdapter();
  adapter.addStored("one", []);
  adapter.addStored("kid", [], { parentSessionId: "claude:one" });
  const prefs = new Prefs(file, 60_000);
  const bus = new EventBus<CoreEvents>();
  const core = new SessionCore({ adapters: [adapter], bus, send: () => true, prefs, epoch: "cantext", log: () => {} });
  const live = new LiveControl(core, new RequestBroker(), { idleMs: 60_000 });
  const ops = new OpRegistry();
  registerSessionOps(ops, core, live);
  const events: CoreEvents["canTextChanged"][] = [];
  bus.on("canTextChanged", (e) => void events.push(e));
  cleanups.push(() => core.stop(), () => rmSync(dir, { recursive: true, force: true }));
  return { file, dir, core, prefs, ops, live, events };
}

const saved = (file: string, id: string) => JSON.parse(readFileSync(file, "utf8")).sessions?.[id];

describe("setCanText (\"Session can text me\")", () => {
  test("off by default; ticked, it's saved at once, in the session's state, and texting hears of it", async () => {
    const { ops, core, prefs, file, events } = setup();
    expect((await core.open("claude:one")).state.canText).toBeUndefined();
    expect(await ops.handle("setCanText", { sessionId: "claude:one", canText: true })).toMatchObject({ ok: true });
    expect(saved(file, "claude:one").canText).toBe(true);
    expect((await core.open("claude:one")).state.canText).toBe(true);
    expect(prefs.texters()).toEqual(["claude:one"]);
    expect(await ops.handle("setCanText", { sessionId: "claude:one", canText: false })).toMatchObject({ ok: true });
    expect(saved(file, "claude:one").canText).toBeUndefined();
    expect((await core.open("claude:one")).state.canText).toBeUndefined();
    expect(prefs.texters()).toEqual([]);
    expect(events).toEqual([{ sessionId: "claude:one", canText: true }, { sessionId: "claude:one", canText: false }]);
  });

  test("refuses a non-boolean and a subagent (it texts as its main session)", async () => {
    const { ops, prefs, events } = setup();
    for (const canText of ["true", 1, undefined]) expect(await ops.handle("setCanText", { sessionId: "claude:one", canText })).toMatchObject({ ok: false });
    expect(await ops.handle("setCanText", { sessionId: "claude:kid", canText: true })).toMatchObject({ ok: false });
    expect(prefs.get("claude:kid").canText).toBeUndefined();
    expect(events).toEqual([]);
  });

  test("read back after a restart, carried to a successor, and kept however old", async () => {
    const { ops, core, live, file } = setup();
    await ops.handle("setCanText", { sessionId: "claude:one", canText: true });
    expect(live.keptPrefs(await core.open("claude:one"))).toEqual({ canText: true });
    // An entry untouched for a year stays while its box is ticked; one without it goes.
    const year = Date.now() - 365 * 24 * 60 * 60 * 1000;
    saveConfig({ runnerId: "cantext-test", sessions: { "claude:one": { canText: true, at: year }, "claude:gone": { title: "x", at: year } } }, file);
    const again = new Prefs(file, 60_000);
    again.set("claude:other", { title: "y" });
    again.flush();
    expect(saved(file, "claude:one")).toMatchObject({ canText: true });
    expect(saved(file, "claude:gone")).toBeUndefined();
    expect(again.texters()).toEqual(["claude:one"]);
  });
});
