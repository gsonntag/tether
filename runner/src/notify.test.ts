import { beforeEach, describe, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import type { MemoryConflict } from "../../web/src/shared/protocol";
import type { PushSub } from "./notify";

// (the preloaded src/testenv.ts already points it at the shared scratch dir)
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-notify-"));
const { config } = await import("./config");
const { ConflictNotifier, conflictNotice, migrateSubs, notify, notifyConflicts, recent, subscribe, subscription, vapidPublicKey } = await import("./notify");
const { LiveSession } = await import("./session");

const sent: { endpoint: string; payload: any; options: any }[] = [];
let failWith: number | undefined;
(webpush as any).sendNotification = async (sub: any, payload: string, options: any) => {
  if (failWith) throw Object.assign(new Error("gone"), { statusCode: failWith });
  sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
};

const keys = { p256dh: "x", auth: "y" };
beforeEach(() => {
  sent.length = 0;
  failWith = undefined;
  config().push = { ...config().push!, subs: [], recent: [] };
});

const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
function fake() {
  class Fake extends LiveSession {
    async start() {}
    protected async send(text: string) {
      this.addUserMessage(text);
      this.setState({ status: "running" });
    }
    async reply(text: string) {
      this.emit({ type: "msg", msg: { id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text }], ts: Date.now() } });
      this.setState({ status: "idle" });
    }
    async abort() {
      this.setState({ status: "idle" });
    }
    async applyModel() {}
    async setThinking() {}
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn() {}
    protected shutdown() {}
  }
  const s = new Fake("codex", { nativeId: crypto.randomUUID(), projectPath: "/home/u/proj", title: "Fix login" }, sink);
  s.t.state.status = "idle";
  return s;
}

describe("notify", () => {
  test("pushes only the kinds a device asked for, and keeps them for the bell", () => {
    subscribe({ endpoint: "https://push.example/a", keys, kinds: ["question", "blocked"] });
    subscribe({ endpoint: "https://push.example/b", keys, kinds: ["finished"] });
    notify({ kind: "finished", title: "Finished · x", body: "done", sessionId: "s1", projectPath: "/p" });
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example/b"]);
    expect(sent[0]!.payload).toMatchObject({ kind: "finished", sessionId: "s1", project: "p", runnerId: config().runnerId });
    expect(recent()[0]!.title).toBe("Finished · x");
  });

  test("the same blocked notice is throttled; a different one isn't", () => {
    subscribe({ endpoint: "https://push.example/a", keys, kinds: ["blocked"] });
    const n = { kind: "blocked" as const, body: "", sessionId: "s2", projectPath: "/p" };
    notify({ ...n, title: "Guard blocked a call · x" });
    notify({ ...n, title: "Guard blocked a call · x" });
    notify({ ...n, title: "Failed · x" });
    expect(sent.length).toBe(2);
  });

  test("a subscription the push service says is gone is dropped", async () => {
    subscribe({ endpoint: "https://push.example/gone", keys, kinds: ["question"] });
    failWith = 410;
    notify({ kind: "question", title: "q", body: "", sessionId: "s3", projectPath: "/p" });
    await Bun.sleep(10);
    expect(subscription("https://push.example/gone")).toBeUndefined();
  });

  test("the payload a device receives decrypts with its keys", async () => {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = randomBytes(16);
    const sub = { endpoint: "https://push.example/real", keys: { p256dh: ecdh.getPublicKey("base64url"), auth: auth.toString("base64url") } };
    const vapid = config().push!.vapid!;
    const req = webpush.generateRequestDetails(sub, JSON.stringify({ title: "hi" }), {
      vapidDetails: { subject: "mailto:tether@localhost", publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    });
    expect(req.headers.Authorization).toContain(`k=${vapidPublicKey()}`);
    const ece = (await import("http_ece")).default;
    const plain = ece.decrypt(req.body, { version: "aes128gcm", privateKey: ecdh, authSecret: auth.toString("base64url") });
    expect(JSON.parse(plain.toString())).toEqual({ title: "hi" });
  });
});

describe("session triggers", () => {
  test("finished, with the end of the reply", async () => {
    subscribe({ endpoint: "https://push.example/a", keys, kinds: ["question", "finished", "blocked"] });
    const s = fake();
    await s.prompt("go");
    await (s as any).reply("All tests pass now.");
    expect(sent.at(-1)!.payload).toMatchObject({ kind: "finished", title: "Finished · Fix login", body: "proj: All tests pass now." });
    s.close();
  });

  test("Stop isn't 'finished'; a failure is 'blocked' and replaces it", async () => {
    subscribe({ endpoint: "https://push.example/a", keys, kinds: ["question", "finished", "blocked"] });
    const s = fake();
    await s.prompt("go");
    await s.stop();
    expect(sent.length).toBe(0);
    await s.prompt("again");
    s.notice("codex exited (code 1)", "error");
    await (s as any).reply("");
    expect(sent.map((x) => x.payload.kind)).toEqual(["blocked"]);
    s.close();
  });

  test("a question", async () => {
    subscribe({ endpoint: "https://push.example/a", keys, kinds: ["question"] });
    const s = fake();
    s.askUi({ id: "q1", kind: "permission", title: "Allow Bash?", tool: { name: "Bash", input: { command: "npm publish" } } });
    expect(sent.at(-1)!.payload).toMatchObject({ kind: "question", title: "Approval needed · Fix login", body: "proj: Allow Bash: npm publish?" });
    s.close();
  });
});

describe("memory conflicts", () => {
  const conflict = (id: string, name: string, over: Partial<MemoryConflict> = {}): MemoryConflict => ({
    id,
    memoryId: `global/${name}`,
    name,
    scope: "global",
    oldBody: "Prefer bun.",
    newBody: "Prefer npm for every script.\n\nMore detail.",
    newClaim: "The user prefers npm over bun.",
    source: "mcp:claude",
    ts: Date.now(),
    status: "open",
    ...over,
  });

  test("devices subscribed before the kind existed get it switched on, once", () => {
    const subs: PushSub[] = [
      { endpoint: "a", keys, kinds: ["question", "finished"], addedAt: 1 },
      { endpoint: "b", keys, kinds: ["blocked"], addedAt: 1 },
    ];
    expect(migrateSubs(subs)).toBe(true);
    expect(subs[0]!.kinds).toEqual(["question", "finished", "memory"]);
    expect(subs[1]!.kinds).toEqual(["blocked", "memory"]);
    expect(subs[0]!.offered).toEqual(["question", "finished", "blocked", "memory"]);
    // Turned off afterwards: stays off.
    subs[0]!.kinds = ["question"];
    expect(migrateSubs(subs)).toBe(false);
    expect(subs[0]!.kinds).toEqual(["question"]);
  });

  test("a new subscription records what it was offered, so it isn't migrated", () => {
    subscribe({ endpoint: "https://push.example/new", keys, kinds: ["question"] });
    const s = subscription("https://push.example/new")!;
    expect(s.offered).toContain("memory");
    expect(migrateSubs([s])).toBe(false);
    expect(s.kinds).toEqual(["question"]);
  });

  test("one conflict: its name, and the new claim kept short", () => {
    const n = conflictNotice([conflict("c1", "tooling", { newClaim: "x".repeat(300) })]);
    expect(n.title).toBe("Memory conflict · tooling");
    expect(n.body.startsWith("Kept the newest: xxx")).toBe(true);
    expect(n.body.endsWith("x… Tap to review.")).toBe(true);
    expect(n.body.length).toBeLessThan(140);
    expect(n.conflictId).toBe("c1");
    // No claim: the first line of the new text, without its trailing period.
    expect(conflictNotice([conflict("c1", "tooling", { newClaim: undefined })]).body).toBe("Kept the newest: Prefer npm for every script. Tap to review.");
  });

  test("several conflicts: one count, the newest linked", () => {
    const n = conflictNotice([conflict("c1", "a", { ts: 1 }), conflict("c2", "b", { ts: 3 }), conflict("c3", "c", { ts: 2 })]);
    expect(n.title).toBe("3 memory conflicts");
    expect(n.body).toBe("Kept the newest each time: b, c, a. Tap to review.");
    expect(n.conflictId).toBe("c2");
  });

  test("batching: a pass is one notification; passes within the window wait and go out together", async () => {
    let t = 1_000_000;
    const out: string[][] = [];
    const open = new Set(["c1", "c2", "c3", "c4", "c5"]);
    const b = new ConflictNotifier({ windowMs: 40, now: () => t, isOpen: (id) => open.has(id), send: (l) => out.push(l.map((c) => c.id)) });
    b.add([conflict("c1", "a"), conflict("c2", "b")]);
    expect(out).toEqual([["c1", "c2"]]);
    t += 10;
    b.add([conflict("c3", "c")]);
    b.add([conflict("c4", "d"), conflict("c5", "e")]);
    open.delete("c4"); // resolved before the window ended: left out
    expect(out.length).toBe(1);
    t += 40;
    await Bun.sleep(60);
    expect(out).toEqual([
      ["c1", "c2"],
      ["c3", "c5"],
    ]);
    // Nothing open in a batch: nothing sent.
    t += 100;
    b.add([conflict("c6", "f", { status: "kept-new" })]);
    expect(out.length).toBe(2);
  });

  test("pushed as kind memory to devices that want it, and kept for the bell", () => {
    subscribe({ endpoint: "https://push.example/m", keys, kinds: ["memory"] });
    subscribe({ endpoint: "https://push.example/q", keys, kinds: ["question"] });
    const n = notifyConflicts([conflict("c9", "tooling")])!;
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example/m"]);
    expect(sent[0]!.payload).toMatchObject({ kind: "memory", title: "Memory conflict · tooling", conflictId: "c9", sessionId: "" });
    expect(sent[0]!.options.urgency).toBe("normal");
    expect(recent()[0]!.id).toBe(n.id);
  });
});
