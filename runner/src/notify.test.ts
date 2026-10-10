import { beforeEach, describe, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";

// (the preloaded src/testenv.ts already points it at the shared scratch dir)
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-notify-"));
const { config } = await import("./config");
const { notify, recent, subscribe, subscription, vapidPublicKey } = await import("./notify");
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
