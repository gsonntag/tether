import { afterEach, describe, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import type { PushPayload } from "../../../../shared/protocol";
import type { Request } from "../../../../shared/transcript";
import { failureKind, Notifier, requestBody } from ".";
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
    "claude:s1": { summary: { id: "claude:s1", title: "Fix the build" }, status: "idle", requests: ["r1"] },
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
    expect(sender.sent[0]![1]).toMatchObject({ kind: "request", runnerId: "box", sessionId: "claude:s1", title: "Fix the build", body: "Claude wants to run a command.", tag: "req-r1" });
    // Never the command itself.
    expect(JSON.stringify(sender.sent)).not.toContain("rm -rf");
  });

  test("a subagent's request: titled with its main session, skipped for a device on either", async () => {
    const { n, sender } = setup({ "claude:s1": ["phone"] });
    await n.request({ id: "r2", sessionId: "claude:s1/k", kind: "question", question: "Which one?", openedAt: 1 });
    expect(sender.sent.map(([d]) => d)).toEqual(["laptop"]);
    expect(sender.sent[0]![1]).toMatchObject({ title: "Fix the build · Count lines", body: "Claude has a question for you." });
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
    expect(sender.sent[0]![1]).toMatchObject({ kind: "finished", title: "Fix the build", body: "Finished.", tag: "end-claude:s1" });
    await n.turnEnded("claude:s1", "API Error: 429 {\"type\":\"rate_limit_error\",\"message\":\"secret details\"}");
    expect(sender.sent[2]![1]).toMatchObject({ kind: "failed", body: "Failed: rate limited." });
    expect(JSON.stringify(sender.sent)).not.toContain("secret details");
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
    expect(requestBody(r({ tool: "Edit", toolKind: "edit", input: { file_path: "/a/b/app.ts" } }), "Codex")).toBe("Codex wants to edit a file.");
    expect(requestBody(r({ tool: "apply_patch", toolKind: "edit", input: { files: ["/a", "/b", "/c"] } }), "Codex")).toBe("Codex wants to edit 3 files.");
    // The harness's own description of the step.
    expect(requestBody(r({ tool: "Bash", toolKind: "shell", input: { command: "rm -rf /tmp/x", description: "Remove the build cache" } }), "Claude")).toBe("Claude asks to: Remove the build cache");
    expect(requestBody(r({ tool: "shell", toolKind: "shell", reason: "Needs network access to install deps", input: { command: "npm i" } }), "Codex", "codex")).toBe("Codex asks to: Needs network access to install deps");
    // Claude's reason is its rule's wording, not a step.
    expect(requestBody(r({ tool: "Bash", toolKind: "shell", reason: "Path is outside allowed working directories", input: { command: "ls /x" } }), "Claude")).toBe("Claude wants to run a command.");
    // A description carrying the command, a secret or a path falls back.
    expect(requestBody(r({ tool: "Bash", toolKind: "shell", input: { command: "cat /etc/hostname > /dev/null && echo TOKEN=sk-live-123456", description: "cat /etc/hostname > /dev/null && echo TOKEN=sk-live-123456" } }), "Claude")).toBe("Claude wants to run a command.");
    expect(requestBody(r({ tool: "Bash", toolKind: "shell", input: { command: "echo hi", description: "Print the API key sk-live-123456" } }), "Claude")).toBe("Claude wants to run a command.");
    expect(requestBody(r({ tool: "Bash", toolKind: "shell", input: { command: "deploy --prod", description: "Deploy to production now" } }), "Claude")).toBe("Claude wants to run a command.");
    expect(requestBody(r({ tool: "Bash", toolKind: "shell", input: { command: "ls", description: "Read /home/me/.ssh config" } }), "Claude")).toBe("Claude wants to run a command.");
    expect(requestBody(r({ tool: "Bash", toolKind: "shell", input: { command: "ls", description: "x".repeat(61) } }), "Claude")).toBe("Claude wants to run a command.");
    // An MCP tool's description argument is never used.
    expect(requestBody(r({ tool: "mcp__slack__post", toolKind: "other", input: { description: "Post the deploy password hunter2" } }), "Claude")).toBe("Claude wants to use mcp__slack__post.");
    expect(requestBody(r({ kind: "question", question: "Which password?" }), "Claude")).toBe("Claude has a question for you.");
    expect(requestBody(r({ tool: "WebFetch", toolKind: "fetch", input: { url: "https://x" } }), "Claude")).toBe("Claude wants to fetch from the web.");
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

test("failures say what kind, never the raw error", () => {
  expect(failureKind("There's an issue with the selected model (claude-x). It may not exist")).toBe("model unavailable");
  expect(failureKind("Claude Code isn't signed in")).toBe("not signed in");
  expect(failureKind("API Error: 529 overloaded_error")).toBe("the service is overloaded");
  expect(failureKind("Claude Code stopped: killed")).toBe("the agent stopped unexpectedly");
  expect(failureKind("weird")).toBe("an error");
});

describe("push endpoints, pinned", () => {
  test("the address connected to is the one checked: a name that resolves to loopback gets nowhere", async () => {
    const { pinnedLookup } = await import("./endpoint");
    let resolves = 0;
    // The first answer is public (as the subscribe check saw), the next is loopback (rebinding).
    const rebinding = async () => (resolves++ === 0 ? [{ address: "142.250.1.1", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]);
    const look = pinnedLookup(false, rebinding);
    const first = await new Promise<any>((r) => look("push.example", {}, (e, a) => r(e ?? a)));
    expect(first).toBe("142.250.1.1");
    const second = await new Promise<any>((r) => look("push.example", {}, (e, a) => r(e ?? a)));
    expect(second.code).toBe("EPRIVATE");
  });

  test("a real request through the pinned lookup reaches only the checked address", async () => {
    const { postPush } = await import("./sender");
    let hits = 0;
    const srv = Bun.serve({ port: 0, fetch: () => (hits++, new Response(null, { status: 201 })) });
    servers.push(srv);
    // Not dev: a name resolving to 127.0.0.1 is refused before anything connects.
    await expect(postPush(`http://localhost:${srv.port}/x`, {}, "x", { dev: false })).rejects.toThrow("network");
    expect(hits).toBe(0);
    expect((await postPush(`http://localhost:${srv.port}/x`, {}, "x", { dev: true })).status).toBe(201);
  });
});

describe("push endpoints", () => {
  test("only https push services on the internet (a dev runner also takes http to this machine)", async () => {
    const { endpointProblem, privateAddress } = await import("./endpoint");
    const pub = async () => [{ address: "142.250.1.1", family: 4 }];
    const priv = async () => [{ address: "10.0.0.5", family: 4 }];
    expect(await endpointProblem("https://fcm.googleapis.com/fcm/send/x", false, pub)).toBeUndefined();
    expect(await endpointProblem("http://fcm.googleapis.com/x", false, pub)).toContain("https");
    expect(await endpointProblem("https://evil.example/x", false, priv)).toContain("network");
    expect(await endpointProblem("https://127.0.0.1/x", false, pub)).toContain("network");
    expect(await endpointProblem("https://[::1]/x", false, pub)).toContain("network");
    expect(await endpointProblem("https://169.254.169.254/x", false, pub)).toContain("network");
    expect(await endpointProblem("http://127.0.0.1:9/push", true, pub)).toBeUndefined();
    expect(await endpointProblem("http://127.0.0.1:9/push", false, pub)).toBeDefined();
    const v6 = ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "::7f00:1", "::ffff:127.0.0.1", "::127.0.0.1", "::1", "::", "64:ff9b::7f00:1", "64:ff9b::808:808", "2002:7f00:1::1", "2002:c0a8:101::", "fec0::1", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "2001::1", "2001:db8::1", "::ffff:0:7f00:1", "100::1"];
    for (const ip of ["10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.1", "169.254.169.254", "0.0.0.0", ...v6]) expect([ip, privateAddress(ip)]).toEqual([ip, true]);
    for (const ip of ["8.8.8.8", "2606:4700::1111", "2002:808:808::1", "2a00:1450:4001::200e"]) expect([ip, privateAddress(ip)]).toEqual([ip, false]);
    for (const host of ["[::ffff:7f00:1]", "[::ffff:a9fe:a9fe]", "[::7f00:1]", "[64:ff9b::7f00:1]", "[2002:7f00:1::1]", "[fec0::1]", "[::ffff:127.0.0.1]"]) expect(await endpointProblem(`https://${host}/x`, false, pub)).toContain("network");
  });

  test("a redirect isn't followed, and what the endpoint said isn't passed back", async () => {
    let hits = 0;
    const target = Bun.serve({ port: 0, fetch: () => (hits++, new Response("secret", { status: 200 })) });
    const server = Bun.serve({ port: 0, fetch: () => new Response("internal details", { status: 302, headers: { location: `http://127.0.0.1:${target.port}/` } }) });
    servers.push(server, target);
    const device = createECDH("prime256v1");
    device.generateKeys();
    const sender = new PushSender("", () => {});
    sender.setKeys({ ...webpush.generateVAPIDKeys(), subject: "mailto:a@b.c" });
    const s: PushSub = { deviceId: "d", endpoint: `http://127.0.0.1:${server.port}/x`, keys: { p256dh: device.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") }, addedAt: 1 };
    const err = await sender.send(s, { kind: "test", title: "t", body: "b", runnerId: "r", ts: 1 }, true).catch((e) => e.message);
    expect(err).toContain("HTTP 302");
    expect(err).not.toContain("internal details");
    expect(hits).toBe(0);
  });
});
