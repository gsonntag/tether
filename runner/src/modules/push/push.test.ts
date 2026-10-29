import { afterEach, describe, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import type { PushPayload } from "../../../../shared/protocol";
import type { Request } from "../../../../shared/transcript";
import { Notifier, requestBody } from ".";
import { PushSender, pushSubject, type Sender } from "./sender";
import { SubscriptionStore, type PushSub } from "./store";

const servers: { stop(): void }[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.stop()));

class FakeSender implements Sender {
  sent: [string, PushPayload][] = [];
  gone = new Set<string>();
  ready() {
    return true;
  }
  async send(sub: PushSub, p: PushPayload) {
    this.sent.push([sub.deviceId, p]);
    return this.gone.has(sub.endpoint);
  }
}

const sub = (deviceId: string): Omit<PushSub, "addedAt"> => ({ deviceId, endpoint: `https://push.example/${deviceId}`, keys: { p256dh: "k", auth: "a" } });

function setup(viewers: Record<string, string[]> = {}) {
  const store = new SubscriptionStore();
  store.add(sub("phone"));
  store.add(sub("laptop"));
  const sender = new FakeSender();
  const sessions: Record<string, any> = {
    "claude:s1": { summary: { id: "claude:s1", title: "Fix the build" }, status: "idle", requests: ["r1"], lastText: "All tests pass now." },
    "claude:s1/k": { summary: { id: "claude:s1/k", title: "Count lines", parentSessionId: "claude:s1" }, status: "running", requests: ["r2"] },
  };
  const n = new Notifier({ runnerId: "box", log: () => {}, session: (id) => sessions[id], viewersOf: (id) => viewers[id] ?? [] }, store, sender);
  return { n, store, sender, sessions };
}

describe("what gets sent, to whom", () => {
  test("a request goes to every device but one looking at the session", async () => {
    const { n, sender } = setup({ "claude:s1": ["laptop"] });
    await n.request({ id: "r1", sessionId: "claude:s1", kind: "approval", tool: "Bash", input: { command: "rm -rf build" }, openedAt: 1 });
    expect(sender.sent.map(([d]) => d)).toEqual(["phone"]);
    expect(sender.sent[0]![1]).toMatchObject({ kind: "request", runnerId: "box", sessionId: "claude:s1", title: "Fix the build", body: "Claude wants to run rm -rf build", tag: "req-r1" });
  });

  test("a subagent's request: titled with its main session, skipped for a device on either", async () => {
    const { n, sender } = setup({ "claude:s1": ["phone"] });
    await n.request({ id: "r2", sessionId: "claude:s1/k", kind: "question", question: "Which one?", openedAt: 1 });
    expect(sender.sent.map(([d]) => d)).toEqual(["laptop"]);
    expect(sender.sent[0]![1]).toMatchObject({ title: "Fix the build · Count lines", body: "Claude asks: Which one?" });
  });

  test("a request already closed sends nothing", async () => {
    const { n, sender } = setup();
    await n.request({ id: "gone", sessionId: "claude:s1", kind: "approval", openedAt: 1 });
    expect(sender.sent).toEqual([]);
  });

  test("finished and failed; nothing for a session that went on working", async () => {
    const { n, sender, sessions } = setup();
    sessions["claude:s1"].requests = [];
    await n.turnEnded("claude:s1");
    expect(sender.sent[0]![1]).toMatchObject({ kind: "finished", body: "All tests pass now.", tag: "end-claude:s1" });
    await n.turnEnded("claude:s1", "Rate limited");
    expect(sender.sent[2]![1]).toMatchObject({ kind: "failed", body: "Claude's turn failed: Rate limited" });
    sender.sent = [];
    sessions["claude:s1"].status = "running";
    await n.turnEnded("claude:s1");
    await n.turnEnded("claude:s1/k");
    expect(sender.sent).toEqual([]);
  });

  test("a subscription the push service says is gone is dropped", async () => {
    const { n, sender, store } = setup();
    sender.gone.add("https://push.example/phone");
    await n.attention("claude:s1", "Claude needs your permission to use Bash");
    expect(store.list().map((s) => s.deviceId)).toEqual(["laptop"]);
  });

  test("one subscription per device", () => {
    const store = new SubscriptionStore(join(mkdtempSync(join(tmpdir(), "push-")), "push.json"));
    store.add(sub("phone"));
    store.add({ ...sub("phone"), endpoint: "https://push.example/new" });
    expect(store.list().map((s) => s.endpoint)).toEqual(["https://push.example/new"]);
  });

  test("request bodies", () => {
    const r = (x: Partial<Request>): Request => ({ id: "r", sessionId: "s", kind: "approval", openedAt: 1, ...x });
    expect(requestBody(r({ plan: "# Plan" }), "Claude")).toBe("Claude has a plan for you to approve.");
    expect(requestBody(r({ tool: "Edit", toolKind: "edit", input: { file_path: "/a/b/app.ts" } }), "Codex")).toBe("Codex wants to change app.ts");
  });
});

describe("the push itself", () => {
  test("a device's push service gets a VAPID-signed payload that decrypts with the device's keys", async () => {
    const got: { headers: Headers; body: Buffer }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        got.push({ headers: req.headers, body: Buffer.from(await req.arrayBuffer()) });
        return new Response(null, { status: 201 });
      },
    });
    servers.push(server);
    const device = createECDH("prime256v1");
    device.generateKeys();
    const auth = randomBytes(16);
    const keys = webpush.generateVAPIDKeys();
    const sender = new PushSender("https://tether--me.foliation.dev", () => {});
    expect(sender.ready()).toBe(false);
    sender.setKeys({ ...keys, subject: "" });
    const s: PushSub = { deviceId: "phone", endpoint: `http://127.0.0.1:${server.port}/push/abc`, keys: { p256dh: device.getPublicKey().toString("base64url"), auth: auth.toString("base64url") }, addedAt: 1 };
    const payload: PushPayload = { kind: "finished", title: "Fix the build", body: "Done.", runnerId: "box", sessionId: "claude:s1", tag: "end-claude:s1", ts: 5 };
    expect(await sender.send(s, payload)).toBe(false);
    expect(got).toHaveLength(1);
    expect(got[0]!.headers.get("authorization")).toContain(`k=${keys.publicKey}`);
    expect(got[0]!.headers.get("topic")).toBeTruthy();
    const ece = (await import("http_ece")).default;
    const plain = ece.decrypt(got[0]!.body, { version: "aes128gcm", privateKey: device, authSecret: auth.toString("base64url") });
    expect(JSON.parse(plain.toString())).toEqual(payload);
  });

  test("410 means gone", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("gone", { status: 410 }) });
    servers.push(server);
    const device = createECDH("prime256v1");
    device.generateKeys();
    const sender = new PushSender("", () => {});
    sender.setKeys({ ...webpush.generateVAPIDKeys(), subject: "mailto:a@b.c" });
    const s: PushSub = { deviceId: "d", endpoint: `http://127.0.0.1:${server.port}/x`, keys: { p256dh: device.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") }, addedAt: 1 };
    expect(await sender.send(s, { kind: "test", title: "t", body: "b", runnerId: "r", ts: 1 })).toBe(true);
  });

  test("the VAPID subject: the server's, else the app's https URL, else a mailto", () => {
    expect(pushSubject("mailto:me@x.y", "https://a.b")).toBe("mailto:me@x.y");
    expect(pushSubject("", "https://tether--me.foliation.dev/")).toBe("https://tether--me.foliation.dev");
    expect(pushSubject(undefined, "http://localhost:8794")).toBe("mailto:tether@example.com");
  });
});
