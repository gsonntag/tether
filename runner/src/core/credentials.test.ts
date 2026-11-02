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
  test("an existing shared TUI can still be observed after its key changes, without allowing a new send", async () => {
    const { live, adapter, credentials, core, prefs } = setup();
    adapter.capabilities = { ...adapter.capabilities, persistent: true, terminal: "shared" };
    credentials.set("anthropic", `fake-tui-${crypto.randomUUID()}`);
    prefs.set("claude:one", { source: "anthropic" });
    await live.send("claude:one", "first");
    const s = await core.open("claude:one"), old = adapter.drivers.at(-1)!;
    s.setState({ terminal: { kind: "shared" } });
    credentials.set("anthropic", `fake-tui-${crypto.randomUUID()}`);
    expect(await live.resumeLive(s)).toBe(old);
    expect(old.closed).toBe(false);
    await expect(live.send(s.id, "new key")).rejects.toThrow("Credentials changed");
    s.setState({ terminal: undefined });
    await live.send(s.id, "after closing the TUI");
    expect(old.closed).toBe(true);
    expect(adapter.drivers.at(-1)!.opts.credential?.source).toBe("anthropic");
  });
  test("setting a key changes no session: a subscription session keeps its process and carries no key", async () => {
    const { live, adapter, credentials, prefs, core } = setup();
    await live.send("claude:one", "subscription");
    const first = adapter.drivers[0]!;
    expect(first.opts.credential?.source).toBe("subscription");
    expect(prefs.get("claude:one").source).toBe("subscription");
    credentials.set("anthropic", `fake-plan-${crypto.randomUUID()}`);
    await live.send("claude:one", "still subscription");
    expect(first.closed).toBe(false);
    expect(adapter.drivers).toHaveLength(1);
    await live.release(await core.open("claude:one"));
    await live.send("claude:one", "resumed");
    expect(adapter.drivers.at(-1)!.opts.credential).toMatchObject({ source: "subscription" });
    expect(adapter.drivers.at(-1)!.opts.credential?.key).toBeUndefined();
  });
  test("a replaced key carries on; an unset key stops with the source named, and nothing is sent", async () => {
    const { live, adapter, credentials, core, prefs, file, frames, dir } = setup();
    const key = `fake-lifecycle-${crypto.randomUUID()}`;
    credentials.set("anthropic", key);
    const { sessionId } = await live.newSession({ harness: "claude", projectPath: dir, source: "anthropic" });
    const first = adapter.drivers.at(-1)!;
    expect(first.opts.credential?.key).toBe(key);
    await live.send(sessionId, "key");
    const replaced = `fake-replaced-${crypto.randomUUID()}`;
    credentials.set("anthropic", replaced);
    await live.send(sessionId, "new key");
    expect(first.closed).toBe(true);
    const second = adapter.drivers.at(-1)!;
    expect(second.opts.credential?.key).toBe(replaced);
    credentials.unset("anthropic");
    const sent = second.sent.length, count = adapter.drivers.length;
    await expect(live.send(sessionId, "nothing")).rejects.toThrow("uses Anthropic API key, which isn't set");
    expect(second.closed).toBe(true);
    expect(second.sent).toHaveLength(sent);
    expect(adapter.drivers).toHaveLength(count);
    const s = await core.open(sessionId);
    expect(JSON.stringify(s.transcript?.messages)).toContain("uses Anthropic API key, which isn't set");
    expect(prefs.get(sessionId).source).toBe("anthropic");
    expect(live.sourceOf(s)).toBe("anthropic");
    prefs.flush();
    expect(readFileSync(file, "utf8")).not.toContain(replaced);
    expect(readFileSync(file, "utf8")).not.toContain(key);
    expect(JSON.stringify((await core.open("claude:one")).snapshot(50))).not.toContain(key);
    expect(JSON.stringify(frames)).not.toContain(key);
  });
  test("Azure: a session keeps its deployment; a rates change restarts it with them; a removed one stops it in the chat, nothing sent", async () => {
    const { live, adapter, credentials, core, prefs, dir } = setup();
    adapter.billing = { ...adapter.billing!, keys: ["azure"] };
    credentials.set("azure", `fake-azure-${crypto.randomUUID()}`);
    credentials.setAzure({ endpoint: "my-res", deployments: [{ name: "d-one" }, { name: "d-two", model: "gpt-6-luna" }] });
    const { sessionId } = await live.newSession({ harness: "claude", projectPath: dir, source: "azure", model: "d-two" });
    expect(prefs.get(sessionId).deployment).toBe("d-two");
    await live.send(sessionId, "first");
    const first = adapter.drivers.at(-1)!;
    expect(first.opts.credential).toMatchObject({ source: "azure", deployment: "d-two" });
    // Another deployment's change leaves this process be.
    credentials.setAzure({ endpoint: "my-res", deployments: [{ name: "d-one", rates: { input: 1, output: 1, cached: 1 } }, { name: "d-two", model: "gpt-6-luna" }] });
    await live.send(sessionId, "same process");
    expect(first.closed).toBe(false);
    const rates = { input: 2, output: 8, cached: 0.5 };
    credentials.setAzure({ endpoint: "my-res", deployments: [{ name: "d-one" }, { name: "d-two", rates }] });
    await live.send(sessionId, "new rates");
    expect(first.closed).toBe(true);
    const second = adapter.drivers.at(-1)!;
    expect(second.opts.credential).toMatchObject({ deployment: "d-two", rates });
    credentials.setAzure({ endpoint: "my-res", deployments: [{ name: "d-one" }] });
    const sent = second.sent.length, count = adapter.drivers.length;
    await expect(live.send(sessionId, "nothing")).rejects.toThrow("Azure deployment d-two was removed");
    expect(second.sent).toHaveLength(sent);
    expect(adapter.drivers).toHaveLength(count);
    const s = await core.open(sessionId);
    expect(JSON.stringify(s.transcript?.messages)).toContain("Azure deployment d-two was removed");
    expect(prefs.get(sessionId).deployment).toBe("d-two");
    // No deployment at all.
    credentials.setAzure({ endpoint: "my-res", deployments: [] });
    await expect(live.send(sessionId, "nothing")).rejects.toThrow("Azure deployment d-two was removed");
    expect((await live.sources("claude")).options.map((o) => o.source)).not.toContain("azure");
  });
  test("Azure: a session from before deployment lists runs on the one deployment it had, which is then kept", async () => {
    const { live, adapter, credentials, prefs } = setup();
    adapter.billing = { ...adapter.billing!, keys: ["azure"] };
    credentials.set("azure", `fake-azure-${crypto.randomUUID()}`, "https://old-res.openai.azure.com/openai/v1", "legacy");
    prefs.set("claude:one", { source: "azure" });
    await live.send("claude:one", "go on");
    expect(adapter.drivers.at(-1)!.opts.credential).toMatchObject({ deployment: "legacy", endpoint: "https://old-res.openai.azure.com/openai/v1" });
    expect(prefs.get("claude:one").deployment).toBe("legacy");
    // Added later, ahead of it: the session stays where it was.
    credentials.setAzure({ endpoint: "old-res", deployments: [{ name: "newer" }, { name: "legacy" }] });
    await live.send("claude:one", "still");
    expect(adapter.drivers.at(-1)!.opts.credential?.deployment).toBe("legacy");
  });
  test("a running turn and its label finish on the old key before a queued send starts on the new one", async () => {
    const { live, adapter, credentials, core, prefs } = setup();
    adapter.script = () => [];
    credentials.set("anthropic", `fake-running-${crypto.randomUUID()}`);
    prefs.set("claude:one", { source: "anthropic" });
    await live.send("claude:one", "running");
    const d = adapter.drivers[0]!, s = await core.open("claude:one");
    d.sink.state({ billing: { kind: "apiKey", label: "Anthropic API key" } });
    const replaced = `fake-replaced-${crypto.randomUUID()}`;
    credentials.set("anthropic", replaced);
    await expect(live.send(s.id, "too soon")).rejects.toThrow("still working");
    expect(d.closed).toBe(false);
    d.sink.state({ status: "idle" });
    await live.send(s.id, "next");
    expect(d.closed).toBe(true);
    expect(adapter.drivers.at(-1)!.opts.credential?.key).toBe(replaced);
    expect(s.state.billing?.label).toBe("Anthropic API key");
  });
  test("startup errors redact a reflected key; no fallback process is attempted", async () => {
    const { live, adapter, credentials, core, prefs } = setup();
    const key = `fake-error-${crypto.randomUUID()}`;
    credentials.set("anthropic", key);
    prefs.set("claude:one", { source: "anthropic" });
    adapter.startError = `401 rejected ${key}`;
    await expect(live.send("claude:one", "fail")).rejects.toThrow("401");
    const s = await core.open("claude:one");
    expect(s.state.error).not.toContain(key);
    expect(JSON.stringify(s.snapshot(50))).not.toContain(key);
    expect(adapter.drivers).toHaveLength(0);
    expect(credentials.snapshot("anthropic")?.source).toBe("anthropic");
  });
  test("a session with no record is on the subscription; a recorded one stays on what its harness says", async () => {
    const { live, adapter, core, credentials, prefs } = setup();
    credentials.set("anthropic", `fake-record-${crypto.randomUUID()}`);
    adapter.addStored("two", []);
    adapter.billing.recorded = (nativeId) => (nativeId === "two" ? "anthropic" : undefined);
    expect(live.sourceOf(await core.open("claude:one"))).toBe("subscription");
    expect(live.sourceOf(await core.open("claude:two"))).toBe("anthropic");
    expect(prefs.get("claude:two").source).toBe("anthropic");
    adapter.billing.recorded = undefined;
    expect(live.sourceOf(await core.open("claude:two"))).toBe("anthropic");
  });
  test("sources are what exists; the default is the subscription whatever was last picked, never a key unasked", async () => {
    const { live, adapter, credentials, prefs, file, dir: folder } = setup();
    expect(await live.sources("claude")).toEqual({ options: [{ source: "subscription", billing: { kind: "plan", label: "Claude plan" } }], default: "subscription" });
    credentials.set("anthropic", `fake-choice-${crypto.randomUUID()}`);
    expect((await live.sources("claude")).options.map((o) => o.source)).toEqual(["subscription", "anthropic"]);
    expect((await live.sources("claude")).default).toBe("subscription");
    // Nothing asked: the subscription, and that isn't a choice.
    await live.newSession({ harness: "claude", projectPath: folder });
    expect(adapter.drivers.at(-1)!.opts.credential?.source).toBe("subscription");
    await live.newSession({ harness: "claude", projectPath: folder, source: "anthropic" });
    expect(adapter.drivers.at(-1)!.opts.credential?.source).toBe("anthropic");
    expect((await live.sources("claude")).default).toBe("subscription");
    prefs.flush();
    await live.newSession({ harness: "claude", projectPath: folder });
    expect(adapter.drivers.at(-1)!.opts.credential?.source).toBe("subscription");
    credentials.unset("anthropic");
    expect((await live.sources("claude")).default).toBe("subscription");
    await expect(live.newSession({ harness: "claude", projectPath: folder, source: "anthropic" })).rejects.toThrow("isn't set");
    await expect(live.newSession({ harness: "claude", projectPath: folder, source: "openai" })).rejects.toThrow("can't use that source");
    adapter.loggedIn = false;
    expect(await live.sources("claude")).toEqual({ options: [] });
    credentials.set("anthropic", `fake-choice-${crypto.randomUUID()}`);
    expect((await live.sources("claude")).options.map((o) => o.source)).toEqual(["anthropic"]);
  });
  describe("a source change a thread can't make itself (capabilities.sourceCarry)", () => {
    const carrying = () => {
      const t = setup();
      t.adapter.capabilities = { ...t.adapter.capabilities, sourceSwitch: true, sourceCarry: true };
      t.credentials.set("anthropic", `fake-carry-${crypto.randomUUID()}`);
      let n = 0;
      // What the move module does: a stored thread, unlisted, confirmed before anyone sees it.
      t.live.carrier = async (from, source) => {
        const nativeId = `carried-${++n}`;
        t.adapter.addStored(nativeId, []);
        const id = `claude:${nativeId}`;
        t.prefs.set(id, { carrying: true, projectPath: t.dir, source });
        const c = await t.core.open(id);
        await t.live.resumeLive(c);
        return id;
      };
      return t;
    };
    const fails = (sink: any) => {
      sink.event({ type: "msg", msg: { id: "e1", role: "notice", level: "error", ts: 2, parts: [{ type: "text", text: "Key rejected." }] } });
      sink.state({ status: "idle" });
    };
    const answers = (sink: any) => {
      sink.event({ type: "msg", msg: { id: `a-${Math.random()}`, role: "assistant", ts: 2, parts: [{ type: "text", text: "Yes." }] } });
      sink.state({ status: "idle" });
    };
    const rows = (t: ReturnType<typeof setup>) => t.core.book.all().sessions.map((r) => r.id);

    test("the chip waits for the next message, then one conversation goes on, under one row", async () => {
      const t = carrying();
      t.adapter.script = () => [answers];
      await t.live.send("claude:one", "plan");
      const s = await t.core.open("claude:one"), first = t.adapter.drivers.at(-1)!;
      t.prefs.set(s.id, { title: "Mine" });
      await t.live.setSource(s.id, "anthropic");
      expect(s.state.nextBilling?.label).toBe("Anthropic API key");
      expect(t.prefs.get(s.id).source).toBe("subscription");
      expect(first.closed).toBe(false);

      await t.live.send(s.id, "on the key");
      const on = t.adapter.drivers.at(-1)!;
      expect(on.nativeId).toBe("carried-1");
      expect(on.sent).toEqual(["on the key"]);
      expect(on.opts.credential?.source).toBe("anthropic");
      expect(first.sent).toEqual(["plan"]);
      expect(first.closed).toBe(true);
      expect(s.state).toMatchObject({ continuedIn: "claude:carried-1", carried: true });
      expect(s.state.nextBilling).toBeUndefined();
      expect(rows(t)).toContain("claude:carried-1");
      expect(rows(t)).not.toContain(s.id);
      expect((await t.core.open("claude:carried-1")).summary.title).toBe("Mine");

      // An old tab's message follows too.
      await t.live.send(s.id, "from an old tab");
      expect(on.sent).toEqual(["on the key", "from an old tab"]);
    });

    test("after a restart the old thread stays out of the lists and its id still leads on", async () => {
      const t = carrying();
      t.adapter.script = () => [answers];
      await t.live.send("claude:one", "plan");
      await t.live.setSource("claude:one", "anthropic");
      await t.live.send("claude:one", "on the key");
      t.prefs.flush();
      const prefs = new Prefs(t.file, 0);
      const core = new SessionCore({ adapters: [t.adapter], bus: new EventBus<CoreEvents>(), send: () => true, prefs, epoch: "later", log: () => {} });
      cleanups.push(() => core.stop());
      await core.discover();
      expect(core.book.all().sessions.map((r) => r.id)).not.toContain("claude:one");
      expect((await core.listSessions({ projectPath: t.adapter.stored.get("one")?.summary?.projectPath, limit: 50 })).sessions.map((r) => r.id)).not.toContain("claude:one");
      expect((await core.open("claude:one")).state).toMatchObject({ continuedIn: "claude:carried-1", carried: true });
    });

    test("a refused key leaves everything where it was, the change still waiting: no fallback", async () => {
      const t = carrying();
      t.adapter.script = (text: string) => (text === "plan" ? [answers] : [fails]);
      await t.live.send("claude:one", "plan");
      const s = await t.core.open("claude:one"), first = t.adapter.drivers.at(-1)!;
      await t.live.setSource(s.id, "anthropic");
      await expect(t.live.send(s.id, "on the key")).rejects.toThrow("Key rejected.");
      expect(first.sent).toEqual(["plan"]);
      expect(first.closed).toBe(false);
      expect(t.adapter.drivers.at(-1)!.closed).toBe(true);
      expect(t.prefs.get(s.id)).toMatchObject({ source: "subscription", nextSource: "anthropic" });
      expect(s.state.sourceSwitchFailed).toBe(true);
      expect(t.prefs.get(s.id).sourceSwitchFailed).toBe(true);
      expect(s.state.continuedIn).toBeUndefined();
      expect(s.transcript!.messages.at(-1)).toMatchObject({ role: "notice", level: "error" });
      expect(rows(t)).not.toContain("claude:carried-1");
      expect(t.core.sessions.has("claude:carried-1")).toBe(false);

      // Picking the source it's on calls it off.
      await t.live.setSource(s.id, "subscription");
      expect(s.state.nextBilling).toBeUndefined();
      expect(s.state.sourceSwitchFailed).toBeUndefined();
      expect(t.prefs.get(s.id).sourceSwitchFailed).toBeUndefined();
      t.adapter.script = () => [answers];
      await t.live.send(s.id, "back on the plan");
      expect(first.sent).toEqual(["plan", "back on the plan"]);
    });

    test("there and back: each change one more thread, and still one row", async () => {
      const t = carrying();
      t.adapter.script = () => [answers];
      await t.live.send("claude:one", "plan");
      await t.live.setSource("claude:one", "anthropic");
      await t.live.send("claude:one", "key");
      await t.live.setSource("claude:carried-1", "subscription");
      await t.live.send("claude:carried-1", "plan again");
      expect(t.adapter.drivers.at(-1)!.opts.credential?.source ?? "subscription").toBe("subscription");
      const mine = rows(t).filter((id) => /one|carried/.test(id));
      expect(mine).toEqual(["claude:carried-2"]);
    });

    test("refused during a turn or with a terminal open, like any source change", async () => {
      const t = carrying();
      t.adapter.script = () => [];
      await t.live.send("claude:one", "plan");
      const s = await t.core.open("claude:one");
      await expect(t.live.setSource(s.id, "anthropic")).rejects.toThrow("Wait for the turn");
      t.adapter.drivers.at(-1)!.sink.state({ status: "idle" });
      s.setState({ terminal: { kind: "handoff" } });
      await expect(t.live.setSource(s.id, "anthropic")).rejects.toThrow("Close the terminal first");
    });
  });
  test("Source applies on the next process start, with the label honest until it's confirmed", async () => {
    const { live, adapter, credentials, core, prefs } = setup();
    adapter.capabilities = { ...adapter.capabilities, sourceSwitch: true };
    credentials.set("anthropic", `fake-switch-${crypto.randomUUID()}`);
    await live.send("claude:one", "plan");
    const s = await core.open("claude:one"), first = adapter.drivers.at(-1)!;
    first.sink.state({ billing: { kind: "plan", label: "Claude plan" } });
    await live.setSource(s.id, "anthropic");
    expect(first.closed).toBe(false);
    expect(s.state.billing?.label).toBe("Claude plan");
    expect(s.state.nextBilling?.label).toBe("Anthropic API key");
    expect(prefs.get(s.id).nextBilling?.label).toBe("Anthropic API key");
    await live.send(s.id, "key");
    expect(first.closed).toBe(true);
    expect(adapter.drivers.at(-1)!.opts.credential?.source).toBe("anthropic");
    expect(s.state.nextBilling).toBeUndefined();
    expect(prefs.get(s.id).nextBilling).toBeUndefined();
  });
  test("a failed source start stays pending until a retry succeeds", async () => {
    const { live, adapter, credentials, core, prefs, file } = setup();
    adapter.capabilities = { ...adapter.capabilities, sourceSwitch: true };
    credentials.set("anthropic", `fake-switch-failure-${crypto.randomUUID()}`);
    await live.send("claude:one", "plan");
    const s = await core.open("claude:one");
    const plan = { kind: "plan", label: "Claude plan" } as const;
    const key = { kind: "apiKey", label: "Anthropic API key" } as const;
    s.setState({ billing: plan });
    await live.setSource(s.id, "anthropic");

    adapter.startError = "Key process failed to start.";
    await expect(live.send(s.id, "try the key")).rejects.toThrow("failed to start");
    expect(s.state).toMatchObject({ billing: plan, nextBilling: key, sourceSwitchFailed: true });
    expect(prefs.get(s.id).sourceSwitchFailed).toBe(true);
    prefs.flush();
    expect(new Prefs(file, 0).get(s.id).sourceSwitchFailed).toBe(true);
    adapter.stored.get("one")!.summary.billing = plan;
    const restored = new SessionCore({ adapters: [adapter], bus: new EventBus<CoreEvents>(), send: () => true, prefs: new Prefs(file, 0), epoch: "restored", log: () => {} });
    cleanups.push(() => restored.stop());
    expect((await restored.open(s.id)).state).toMatchObject({ billing: plan, nextBilling: key, sourceSwitchFailed: true });

    adapter.startError = undefined;
    await live.send(s.id, "retry the key");
    expect(s.state.sourceSwitchFailed).toBeUndefined();
    expect(s.state.nextBilling).toBeUndefined();
    expect(prefs.get(s.id).sourceSwitchFailed).toBeUndefined();
    expect(adapter.drivers.at(-1)!.opts.credential?.source).toBe("anthropic");
  });
  test("an idle source change is allowed while its queue is paused", async () => {
    const { live, adapter, credentials, core } = setup();
    adapter.capabilities = { ...adapter.capabilities, sourceSwitch: true };
    credentials.set("anthropic", `fake-paused-queue-${crypto.randomUUID()}`);
    adapter.addStored("two", []);
    const s = await core.open("claude:two");
    s.setState({ queue: [{ id: "q1", text: "queued", queuedAt: 1 }], queueHeld: true, queueHeldBy: "failed" });

    await live.setSource(s.id, "anthropic");

    expect(s.state.queueHeld).toBe(true);
    expect(s.state.nextBilling?.label).toBe("Anthropic API key");
  });
  test("Source is refused with a terminal open, during a turn, off the capability, or for a key that isn't set", async () => {
    const { live, adapter, credentials, core } = setup();
    await expect(live.setSource("claude:one", "subscription")).rejects.toThrow("Use Move");
    adapter.capabilities = { ...adapter.capabilities, sourceSwitch: true };
    adapter.addStored("three", []);
    await expect(live.setSource("claude:three", "anthropic")).rejects.toThrow("isn't available");
    credentials.set("anthropic", `fake-refused-${crypto.randomUUID()}`);
    adapter.addStored("two", []);
    const s = await core.open("claude:two");
    s.setState({ terminal: { kind: "handoff" } });
    await expect(live.setSource(s.id, "anthropic")).rejects.toThrow("Close the terminal first");
    s.setState({ terminal: undefined, status: "running" });
    await expect(live.setSource(s.id, "anthropic")).rejects.toThrow("Wait for the turn");
    s.setState({ status: "idle", requests: [{} as never] });
    await expect(live.setSource(s.id, "anthropic")).rejects.toThrow("Wait for the turn");
    s.setState({ requests: [], backgroundSubagents: 1 });
    await expect(live.setSource(s.id, "anthropic")).rejects.toThrow("Wait for background work");
    s.setState({ backgroundSubagents: undefined, queue: [{ id: "q1", text: "queued", queuedAt: 1 }] });
    await expect(live.setSource(s.id, "anthropic")).rejects.toThrow("Wait for queued messages");
    s.setState({ queue: [], restartWait: true });
    await expect(live.setSource(s.id, "anthropic")).rejects.toThrow("Wait for the session to reconnect");
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
