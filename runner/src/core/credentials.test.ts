import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerToServer } from "../../../shared/protocol";
import { saveConfig } from "../config";
import { CredentialStore } from "../credentials";
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
afterEach(() => cleanups.splice(0).forEach((f) => f()));
function setup() {
  const base = "/tmp/claude-1001/keys/unit"; mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "core-")), file = join(dir, "runner.json");
  saveConfig({ runnerId: "keys-test" }, file);
  const adapter = new FakeAdapter(), credentials = new CredentialStore(join(dir, "credentials.json"));
  adapter.addStored("one", []);
  const frames: RunnerToServer[] = [], prefs = new Prefs(file, 0);
  const core = new SessionCore({ adapters: [adapter], bus: new EventBus<CoreEvents>(), send: (m) => (frames.push(m), true), prefs, epoch: "keys", log: () => {} });
  const live = new LiveControl(core, new RequestBroker(), { credentials, idleMs: 60_000 });
  const ops = new OpRegistry(); registerSessionOps(ops, core, live);
  cleanups.push(() => core.stop());
  return { dir, file, adapter, core, live, credentials, prefs, frames, ops };
}
describe("credential process boundaries", () => {
  test("an idle live process restarts on set and unset; keys never enter prefs, state or events", async () => {
    const { live, adapter, credentials, core, prefs, file, frames } = setup();
    await live.send("claude:one", "subscription");
    const first = adapter.drivers[0]!;
    expect(first.opts.credential?.source).toBe("subscription");
    const key = `fake-lifecycle-${crypto.randomUUID()}`;
    credentials.set("anthropic", key);
    await live.send("claude:one", "key");
    expect(first.closed).toBe(true);
    expect(adapter.drivers.at(-1)!.opts.credential?.source).toBe("anthropic");
    const keyed = adapter.drivers.at(-1)!;
    credentials.unset("anthropic");
    await live.send("claude:one", "subscription again");
    expect(keyed.closed).toBe(true);
    expect(adapter.drivers.at(-1)!.opts.credential).toMatchObject({ source: "subscription" });
    expect(adapter.drivers.at(-1)!.opts.credential?.key).toBeUndefined();
    prefs.flush();
    expect(readFileSync(file, "utf8")).not.toContain(key);
    expect(JSON.stringify((await core.open("claude:one")).snapshot(50))).not.toContain(key);
    expect(JSON.stringify(frames)).not.toContain(key);
  });
  test("a running turn and its label finish unchanged before a queued send starts a new process", async () => {
    const { live, adapter, credentials, core } = setup();
    adapter.script = () => [];
    await live.send("claude:one", "running");
    const d = adapter.drivers[0]!, s = await core.open("claude:one");
    d.sink.state({ billing: { kind: "plan", label: "Claude plan" } });
    credentials.set("anthropic", `fake-running-${crypto.randomUUID()}`);
    await expect(live.send(s.id, "too soon")).rejects.toThrow("still working");
    expect(d.closed).toBe(false);
    expect(s.state.billing?.kind).toBe("plan");
    d.sink.state({ status: "idle" });
    await live.send(s.id, "next");
    expect(d.closed).toBe(true);
    expect(adapter.drivers.at(-1)!.opts.credential?.source).toBe("anthropic");
    // A preference alone never changes the label: only a harness report does.
    expect(s.state.billing?.kind).toBe("plan");
    adapter.drivers.at(-1)!.sink.state({ billing: { kind: "apiKey", label: "Anthropic API key" } });
    expect(s.summary.billing?.label).toBe("Anthropic API key");
  });
  test("startup errors redact a reflected key; no fallback process is attempted", async () => {
    const { live, adapter, credentials, core } = setup();
    const key = `fake-error-${crypto.randomUUID()}`;
    credentials.set("anthropic", key);
    adapter.startError = `401 rejected ${key}`;
    await expect(live.send("claude:one", "fail")).rejects.toThrow("401");
    const s = await core.open("claude:one");
    expect(s.state.error).not.toContain(key);
    expect(JSON.stringify(s.snapshot(50))).not.toContain(key);
    expect(adapter.drivers).toHaveLength(0);
    expect(credentials.snapshot("claude").source).toBe("anthropic");
  });
  test("rename persists and survives discovery and reopening", async () => {
    const { ops, core, adapter, prefs, file } = setup();
    expect(await ops.handle("renameSession", { sessionId: "claude:one", title: "  My session  " })).toMatchObject({ ok: true });
    const s = await core.open("claude:one");
    expect(s.summary.title).toBe("My session");
    await core.discover();
    expect(s.summary.title).toBe("My session");
    expect((await core.listSessions({})).sessions[0]?.title).toBe("My session");
    prefs.flush(); expect(new Prefs(file).get(s.id).title).toBe("My session");
    expect((await ops.handle("renameSession", { sessionId: s.id, title: " " })).ok).toBe(false);
    expect(adapter.drivers).toHaveLength(0);
  });
});
