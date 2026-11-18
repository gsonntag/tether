// A module holding a session (a checkpoint restore, live.ts `hold`): what's sent meanwhile waits in
// the queue and goes once it's released; a working session can't be held.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../config";
import { RequestBroker } from "./broker";
import { EventBus } from "./bus";
import type { CoreEvents } from "./events";
import { FakeAdapter } from "./fakeAdapter";
import { LiveControl } from "./live";
import { Prefs } from "./prefs";
import { SessionCore } from "./sessions";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

function setup() {
  const adapter = new FakeAdapter();
  const bus = new EventBus<CoreEvents>();
  const f = join(mkdtempSync(join(tmpdir(), "tether-hold-")), "runner.json");
  saveConfig({ runnerId: "test" }, f);
  const prefs = new Prefs(f);
  const core = new SessionCore({ adapters: [adapter], bus, send: () => true, epoch: crypto.randomUUID(), prefs, evictMs: 20, log: () => {} });
  const live = new LiveControl(core, new RequestBroker([], {}), { idleMs: 60_000 });
  cleanups.push(() => core.stop());
  return { adapter, core, live };
}

test("sends wait in the queue while a session is held, and go on release", async () => {
  const { adapter, core, live } = setup();
  adapter.addStored("s1", []);
  const s = await core.open("claude:s1");
  const release = live.hold("claude:s1", "Restoring files…");
  expect(() => live.hold("claude:s1", "again")).toThrow("Restoring files…");
  await live.send("claude:s1", "hello");
  expect(s.state.status).toBe("idle");
  expect(s.state.queue.map((q) => q.text)).toEqual(["hello"]);
  expect(adapter.drivers.flatMap((d) => d.sent)).toEqual([]);
  await Bun.sleep(120);
  expect(s.state.queue.length).toBe(1);
  release();
  for (let i = 0; i < 50 && !adapter.drivers.flatMap((d) => d.sent).length; i++) await Bun.sleep(20);
  expect(adapter.drivers.flatMap((d) => d.sent)).toEqual(["hello"]);
});

test("a working session can't be held", async () => {
  const { adapter, core, live } = setup();
  adapter.addStored("s1", []);
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  adapter.script = () => [async () => gate];
  await core.open("claude:s1");
  const sending = live.send("claude:s1", "work");
  await Bun.sleep(20);
  expect(() => live.hold("claude:s1", "Restoring files…")).toThrow(/working/);
  go();
  await sending;
});
