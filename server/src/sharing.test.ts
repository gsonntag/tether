// Sharing runners with people the app is shared with (shared/access.ts): owners see and manage
// every runner; editors and viewers see only what an owner shared with them, at the granted level.

import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type BrowserToServer, type RunnerInfo } from "../../shared/protocol";
import type { RunnerGrant } from "../../shared/access";
import { Relay, type Socket } from "./relay";
import { Tickets } from "./tickets";

class FakeSocket implements Socket {
  sent: any[] = [];
  closed?: { code?: number; reason?: string };
  send(data: string) {
    this.sent.push(JSON.parse(data));
    return 1;
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  take(t?: string) {
    const out = t ? this.sent.filter((m) => m.t === t) : this.sent;
    this.sent = [];
    return out;
  }
}

const info = (id: string, shared?: RunnerGrant[]): Omit<RunnerInfo, "connectedAt"> => ({ id, name: id, hostname: "h", version: "0", protocol: PROTOCOL_VERSION, harnesses: [], ...(shared ? { shared } : {}) });

function world() {
  let now = 1_000_000;
  const relay = new Relay({ rpcTimeoutMs: 1000, now: () => now, tickets: new Tickets({ now: () => now }) });
  const r1 = new FakeSocket();
  relay.addRunner(r1, "runner");
  const hello = (shared?: RunnerGrant[]) => relay.onRunnerMessage(r1, { t: "hello", runner: info("box", shared) });
  hello([{ email: "ed@x.com", access: "drive" }, { email: "vi@x.com", access: "view" }, { email: "vi2@x.com", access: "drive" }]);
  const r2 = new FakeSocket();
  relay.addRunner(r2, "runner");
  relay.onRunnerMessage(r2, { t: "hello", runner: info("other") });
  const browser = (id: string, email: string, role: string) => {
    const s = new FakeSocket();
    relay.addBrowser(s, { name: id, email }, PROTOCOL_VERSION, id, role);
    return s;
  };
  const rpc = (b: FakeSocket, id: string, runnerId: string, op: string, args: unknown = {}) => relay.onBrowserMessage(b, { t: "rpc", id, runnerId, op, args } as BrowserToServer);
  const owner = browser("u-o", "o@x.com", "owner");
  const editor = browser("u-ed", "ED@x.com", "editor");
  const viewer = browser("u-vi", "vi@x.com", "viewer");
  // Granted drive, but only a viewer on the app: views.
  const viewer2 = browser("u-vi2", "vi2@x.com", "viewer");
  const stranger = browser("u-s", "s@x.com", "editor");
  return { relay, r1, r2, hello, rpc, owner, editor, viewer, viewer2, stranger, tick: (ms: number) => (now += ms) };
}

const runners = (s: FakeSocket) => s.take("runners").at(-1)?.runners as RunnerInfo[];

describe("sharing runners", () => {
  test("each person sees their runners, with their access; only owners see the share list", () => {
    const w = world();
    const o = runners(w.owner);
    expect(o.map((r) => r.id)).toEqual(["box", "other"]);
    expect(o[0]!.shared).toHaveLength(3);
    expect(o[0]!.access).toBeUndefined();
    expect(runners(w.editor)).toEqual([expect.objectContaining({ id: "box", access: "drive" })]);
    const v = w.relay.runnerList((w.relay as any).browsers.get(w.viewer));
    expect(v).toEqual([expect.objectContaining({ id: "box", access: "view" })]);
    expect(v[0]!.shared).toBeUndefined();
    expect(w.relay.runnerList((w.relay as any).browsers.get(w.viewer2))[0]!.access).toBe("view");
    expect(w.relay.runnerList((w.relay as any).browsers.get(w.stranger))).toEqual([]);
  });

  test("viewers read but can't send; editors drive but can't manage; strangers see it offline", () => {
    const w = world();
    for (const s of [w.r1, w.owner, w.editor, w.viewer, w.viewer2, w.stranger]) s.take();
    w.rpc(w.viewer, "1", "box", "listSessions");
    w.rpc(w.viewer, "2", "box", "send", { sessionId: "s", text: "hi" });
    w.rpc(w.viewer2, "3", "box", "openTerminal", { sessionId: "s" });
    expect(w.r1.take("rpc").map((m) => m.op)).toEqual(["listSessions"]);
    expect(w.viewer.take("result")).toEqual([expect.objectContaining({ id: "2", ok: false, error: expect.stringContaining("view") })]);
    expect(w.viewer2.take("result")[0].ok).toBe(false);

    w.rpc(w.editor, "4", "box", "send", { sessionId: "s", text: "hi" });
    w.rpc(w.editor, "5", "box", "setRunnerAccess", { people: [] });
    w.rpc(w.editor, "6", "box", "setCredential", { source: "anthropic", key: "k" });
    expect(w.r1.take("rpc").map((m) => m.op)).toEqual(["send"]);
    expect(w.editor.take("result").map((m) => m.id)).toEqual(["5", "6"]);

    w.rpc(w.stranger, "7", "box", "listSessions");
    w.rpc(w.editor, "8", "other", "listSessions");
    expect(w.stranger.take("result")[0].error).toBe("That runner is offline.");
    expect(w.editor.take("result")[0].error).toBe("That runner is offline.");

    w.rpc(w.owner, "9", "box", "setRunnerAccess", { people: [] });
    expect(w.r1.take("rpc").map((m) => m.op)).toEqual(["setRunnerAccess"]);
  });

  test("a runner saying hello again doesn't fail a viewer's reads in flight", () => {
    const w = world();
    w.r1.take();
    w.rpc(w.viewer, "1", "box", "listSessions");
    const [r] = w.r1.take("rpc");
    w.viewer.take();
    w.hello([{ email: "vi@x.com", access: "view" }]);
    expect(w.viewer.take("result")).toEqual([]);
    w.relay.onRunnerMessage(w.r1, { t: "result", id: r.id, ok: true, data: { sessions: [] } });
    expect(w.viewer.take("result")).toEqual([expect.objectContaining({ id: "1", ok: true })]);
  });

  test("a viewer's presence doesn't count as someone looking", () => {
    const w = world();
    w.r1.take();
    w.relay.onBrowserMessage(w.viewer, { t: "presence", deviceId: "d-v", runnerId: "box", sessionId: "s" });
    expect(w.r1.take("viewers")).toEqual([]);
    w.relay.onBrowserMessage(w.editor, { t: "presence", deviceId: "d-e", runnerId: "box", sessionId: "s" });
    expect(w.r1.take("viewers").at(-1).sessions).toEqual({ s: ["d-e"] });
  });

  test("removing someone from the list drops their subscriptions and terminals at once", () => {
    const w = world();
    w.rpc(w.editor, "1", "box", "subscribe", { sessionId: "s" });
    w.rpc(w.editor, "2", "box", "openTerminal", { sessionId: "s" });
    const [sub, open] = w.r1.take("rpc");
    w.relay.onRunnerMessage(w.r1, { t: "result", id: sub.id, ok: true, data: {} });
    w.relay.onRunnerMessage(w.r1, { t: "result", id: open.id, ok: true, data: {} });
    w.editor.take();
    w.r1.take();
    // Down to view: the terminal goes, the subscription stays.
    w.hello([{ email: "ed@x.com", access: "view" }]);
    expect(w.editor.take("termEnd")).toHaveLength(1);
    expect(w.r1.take("detach")).toHaveLength(1);
    w.relay.onRunnerMessage(w.r1, { t: "event", sessionId: "s", seq: 1, event: { type: "x" } as any });
    expect(w.editor.take("event")).toHaveLength(1);
    // Off the list: no more events, and the runner hears nobody watches.
    w.hello([]);
    expect(runners(w.editor)?.map((r) => r.id)).toEqual([]);
    expect(w.r1.take("unwatched")).toEqual([expect.objectContaining({ sessionIds: ["s"] })]);
    w.relay.onRunnerMessage(w.r1, { t: "event", sessionId: "s", seq: 2, event: { type: "x" } as any });
    expect(w.editor.take("event")).toEqual([]);
  });

  test("a subscribe in flight when access goes never delivers its snapshot", () => {
    const w = world();
    w.r1.take();
    w.rpc(w.editor, "1", "box", "subscribe", { sessionId: "s" });
    const [sub] = w.r1.take("rpc");
    w.editor.take();
    w.hello([]);
    expect(w.editor.take("result")).toEqual([expect.objectContaining({ id: "1", ok: false })]);
    expect(w.r1.take("unwatched")).toEqual([expect.objectContaining({ sessionIds: ["s"] })]);
    w.relay.onRunnerMessage(w.r1, { t: "result", id: sub.id, ok: true, data: { secret: 1 } });
    expect(w.editor.take()).toEqual([]);
  });

  test("viewers can't read the folder or make links; editors can't reconfigure the Home agent", () => {
    const w = world();
    w.r1.take();
    for (const op of ["readFile", "listDir", "gitDiff", "linkFor"]) w.rpc(w.viewer, op, "box", op, { sessionId: "s", path: ".env" });
    for (const op of ["homeAgentSet", "homeAgentReplyByText", "homeAgentWatch", "homeAgentCheckIn"]) w.rpc(w.editor, op, "box", op, {});
    expect(w.r1.take("rpc")).toEqual([]);
    expect(w.viewer.take("result").every((m) => !m.ok)).toBe(true);
    expect(w.editor.take("result").every((m) => !m.ok)).toBe(true);
  });

  test("a role change on Foliation applies at the next renew", () => {
    const w = world();
    w.editor.take();
    w.relay.onBrowserMessage(w.editor, { t: "renew", ticket: w.relay.tickets.issue("u-ed", "viewer") });
    expect(runners(w.editor)).toEqual([expect.objectContaining({ id: "box", access: "view" })]);
    w.rpc(w.editor, "1", "box", "send", { sessionId: "s", text: "hi" });
    expect(w.editor.take("result")[0].ok).toBe(false);
  });
});
