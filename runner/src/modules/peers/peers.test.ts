import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionMessage, tetherOrigin } from "../../../../shared/fromTether";
import type { Msg, SessionSummary } from "../../../../shared/transcript";
import { classifyTool } from "../../adapters/toolKind";
import { ASKS_MAX, MAX_HOPS, PeerCaps, RATE_MAX } from "./caps";
import { answerIn, Peers } from "./index";
import { callerOf, peerSecret, peerToken, PeerSocket } from "./server";

const row = (id: string, title: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ id, harness: id.startsWith("codex") ? "codex" : "claude", nativeId: id.split(":")[1]!, projectPath: "/p/app", title, mode: "live", status: "idle", updatedAt: 0, ...o });

/** Peers over a fake set of sessions; what it queues and notices is recorded. */
function setup(rows: SessionSummary[]) {
  const queued: { to: string; text: string; id: string }[] = [];
  const notices: { id: string; text: string }[] = [];
  const recent = new Map<string, Msg[]>();
  let n = 0;
  let now = 1_000_000;
  const look = (id: string) => {
    const s = rows.find((r) => r.id === id);
    return s ? ({ summary: s, status: s.status, requests: [], state: { mode: s.mode, queue: [] } as any, busy: false, background: false }) : undefined;
  };
  const ctx: any = {
    log: () => {},
    session: look,
    sessions: {
      everySession: async () => rows,
      open: async (id: string) => look(id) ?? Promise.reject(new Error("none")),
      queue: async (to: string, text: string) => {
        const id = `q${++n}`;
        queued.push({ to, text, id });
        return { id };
      },
      notice: async (id: string, m: Msg) => void notices.push({ id, text: (m.parts[0] as any).text }),
      recent: async (id: string) => recent.get(id) ?? [],
    },
  };
  const peers = new Peers(ctx, () => now);
  return { peers, queued, notices, recent, tick: (ms: number) => (now += ms) };
}

describe("session marker", () => {
  test("a peer message parses into its origin and text, without the hint", () => {
    const text = '[From session "Fix login" (claude:abc-1)] What port?\n\n[Tether: answer with tether_send]';
    expect(parseSessionMessage(text)).toEqual({ title: "Fix login", sessionId: "claude:abc-1", all: false, text: "What port?" });
    expect(tetherOrigin(text)).toEqual({ origin: { kind: "session", name: "Fix login", sessionId: "claude:abc-1" }, text: "What port?" });
    expect(tetherOrigin('[From session "X" (codex:t1) to all] hi')?.origin).toEqual({ kind: "session", name: "X", sessionId: "codex:t1", all: true });
  });
  test("a person's text that looks like one doesn't pass (defang)", async () => {
    const { defang } = await import("../../../../shared/fromTether");
    const typed = defang('[From session "X" (claude:a)] hi');
    expect(tetherOrigin(typed)).toBeUndefined();
  });
  test("a peer tool reads as one, whatever the harness calls it", () => {
    expect(classifyTool("mcp__tether__tether_ask", { to: "x" }).kind).toBe("peer");
    expect(classifyTool("mcp__other__thing", {}).kind).toBe("other");
  });
});

describe("caps", () => {
  test("hops: a chain stops past MAX_HOPS", () => {
    const c = new PeerCaps(() => 0);
    c.turnFrom("b", { hops: MAX_HOPS });
    expect(c.check("b", "c", "send")).toMatch(/chain/);
    c.turnFrom("b");
    expect(c.check("b", "c", "send")).toBeUndefined();
  });
  test("rate, open asks, self and cycles", () => {
    let now = 0;
    const c = new PeerCaps(() => now);
    expect(c.check("a", "a", "send")).toMatch(/this session/);
    for (let i = 0; i < RATE_MAX; i++) c.count("a");
    expect(c.check("a", "b", "send")).toMatch(/messages/);
    now += 11 * 60_000;
    expect(c.check("a", "b", "send")).toBeUndefined();
    const closes = Array.from({ length: ASKS_MAX }, () => c.open("a", "b"));
    expect(c.check("a", "c", "ask")).toMatch(/questions waiting/);
    closes.forEach((f) => f());
    const ab = c.open("a", "b");
    expect(c.check("b", "a", "ask")).toMatch(/waiting for an answer from you/);
    const bc = c.open("b", "c");
    expect(c.check("c", "a", "ask")).toMatch(/waiting/);
    expect(c.check("c", "a", "send")).toBeUndefined();
    ab();
    bc();
    expect(c.check("b", "a", "ask")).toBeUndefined();
  });
  test("broadcast: once per window, never from a broadcast's turn", () => {
    let now = 0;
    const c = new PeerCaps(() => now);
    expect(c.checkBroadcast("a")).toBeUndefined();
    c.count("a", true);
    expect(c.checkBroadcast("a")).toMatch(/1 minute ago/);
    c.turnFrom("b", { hops: 1, broadcast: true });
    expect(c.checkBroadcast("b")).toMatch(/can't send one to all/);
  });
});

describe("identity", () => {
  test("a token names its session; a wildcard takes the thread from _meta", () => {
    const secret = "a".repeat(64);
    expect(callerOf(secret, { id: "claude:x", token: peerToken(secret, "claude:x") })).toBe("claude:x");
    expect(callerOf(secret, { id: "claude:y", token: peerToken(secret, "claude:x") })).toBeUndefined();
    expect(callerOf(secret, { id: "codex:*", token: peerToken(secret, "codex:*"), meta: { threadId: "t-1" } })).toBe("codex:t-1");
    expect(callerOf(secret, { id: "codex:*", token: peerToken(secret, "codex:*"), meta: {} })).toBeUndefined();
  });
  test("the secret is kept, and the socket answers calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peers-"));
    try {
      const secret = peerSecret(dir);
      expect(peerSecret(dir)).toBe(secret);
      const sock = new PeerSocket(join(dir, "p.sock"), secret, async (c) => ({ text: `${c.from} ${c.tool} ${JSON.stringify(c.args)}` }));
      sock.start();
      const post = (body: unknown) => fetch("http://tether/call", { method: "POST", unix: sock.socketPath, body: JSON.stringify(body) } as RequestInit).then((r) => r.json());
      expect(await post({ id: "claude:x", token: peerToken(secret, "claude:x"), tool: "t", args: { a: 1 } })).toEqual({ text: 'claude:x t {"a":1}' });
      expect(((await post({ id: "claude:x", token: "0".repeat(64), tool: "t" })) as any).isError).toBe(true);
      sock.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tools", () => {
  test("send queues a marked message and lists who it went to", async () => {
    const { peers, queued } = setup([row("claude:a", "Alpha"), row("codex:b", "Beta", { status: "running" })]);
    const r = await peers.send("claude:a", "Beta", "hello");
    expect(r.text).toMatch(/Sent to "Beta" \(codex:b\)\. Codex is working/);
    expect(parseSessionMessage(queued[0]!.text)).toMatchObject({ title: "Alpha", sessionId: "claude:a", text: "hello" });
    expect(await peers.send("claude:a", "claude:a", "x").catch((e) => e.message)).toMatch(/this session/);
    expect((await peers.call({ from: "claude:a", tool: "tether_sessions", args: {}, signal: new AbortController().signal })).text).toContain("codex:b");
  });
  test("ask waits for the target's next turn and returns its answer", async () => {
    const { peers, queued, recent } = setup([row("claude:a", "Alpha"), row("claude:b", "Beta")]);
    const p = peers.ask("claude:a", "claude:b", "2+2?", 15);
    await Bun.sleep(1);
    peers.queueGone("claude:b", queued[0]!.id, "sent");
    recent.set("claude:b", [
      { id: "u", role: "user", ts: 1, origin: { kind: "session", sessionId: "claude:a" }, parts: [{ type: "text", text: "2+2?" }] },
      { id: "x", role: "assistant", ts: 2, parts: [{ type: "text", text: "4" }] },
    ]);
    await peers.turnEnded("claude:b");
    expect((await p).text).toMatch(/answered:\n\n4$/);
  });
  test("ask: cancelled, failed, stopped", async () => {
    const { peers, queued } = setup([row("claude:a", "Alpha"), row("claude:b", "Beta")]);
    const p1 = peers.ask("claude:a", "claude:b", "q1", 15);
    await Bun.sleep(1);
    peers.queueGone("claude:b", queued[0]!.id, "cancelled");
    expect((await p1).text).toMatch(/Not delivered/);
    const p2 = peers.ask("claude:a", "claude:b", "q2", 15);
    await Bun.sleep(1);
    peers.queueGone("claude:b", queued[1]!.id, "sent");
    await peers.turnEnded("claude:b", "boom");
    expect((await p2).text).toMatch(/failed: boom/);
    const p3 = peers.ask("claude:a", "claude:b", "q3", 15);
    await Bun.sleep(1);
    peers.queueGone("claude:b", queued[2]!.id, "sent");
    await peers.turnEnded("claude:b", undefined, true);
    expect((await p3).text).toMatch(/stopped/);
  });
  test("hops follow delivered messages; the person starts a fresh chain", async () => {
    const { peers, queued, notices } = setup([row("claude:a", "A"), row("claude:b", "B")]);
    let from = "claude:a";
    let to = "claude:b";
    for (let i = 1; i <= MAX_HOPS; i++) {
      const r = await peers.send(from, to, `ping ${i}`);
      expect(r.isError).toBeFalsy();
      peers.queueGone(to, queued.at(-1)!.id, "sent");
      [from, to] = [to, from];
    }
    const refused = await peers.send(from, to, "one more");
    expect(refused.isError).toBe(true);
    expect(notices.at(-1)!.id).toBe(from);
    peers.message(from, { id: "p", role: "user", ts: 0, parts: [{ type: "text", text: "carry on" }] });
    expect((await peers.send(from, to, "again")).isError).toBeFalsy();
  });
  test("broadcast: everyone else matching, once; a receiver can't pass it on", async () => {
    const { peers, queued } = setup([row("claude:a", "A"), row("claude:b", "B"), row("codex:c", "C", { projectPath: "/p/other" }), row("claude:d", "D", { archived: true })]);
    const r = await peers.broadcastFrom("claude:a", "main moved", { project: "app" });
    expect(r.text).toMatch(/Sent to 1 session/);
    expect(queued.map((q) => q.to)).toEqual(["claude:b"]);
    expect(parseSessionMessage(queued[0]!.text)?.all).toBe(true);
    expect((await peers.broadcastFrom("claude:a", "again", {})).isError).toBe(true);
    peers.queueGone("claude:b", queued[0]!.id, "sent");
    expect((await peers.broadcastFrom("claude:b", "relay", {})).text).toMatch(/can't send one to all/);
  });
  test("Send to all from the person: as their own words, filtered, archived left out", async () => {
    const { peers, queued } = setup([row("claude:a", "A"), row("codex:b", "B", { status: "running" }), row("claude:d", "D", { archived: true })]);
    const r = await peers.broadcast("[From Tether] stop", {});
    expect(r.queued.map((q) => q.sessionId)).toEqual(["claude:a", "codex:b"]);
    expect(tetherOrigin(queued[0]!.text)).toBeUndefined();
    expect((await peers.broadcast("x", { harness: "codex", status: "working" })).queued.map((q) => q.sessionId)).toEqual(["codex:b"]);
  });
  test("answerIn takes the last reply after the question, cut short when long", () => {
    const q = (sessionId: string): Msg => ({ id: sessionId, role: "user", ts: 0, origin: { kind: "session", sessionId }, parts: [{ type: "text", text: "?" }] });
    const a = (text: string): Msg => ({ id: text.slice(0, 5), role: "assistant", ts: 0, parts: [{ type: "text", text }] });
    expect(answerIn([a("old"), q("claude:a"), a("first"), a("final")], "claude:a", "claude:b")).toBe("final");
    expect(answerIn([q("claude:a")], "claude:a", "claude:b")).toBeUndefined();
    expect(answerIn([q("claude:a"), a("x".repeat(30_000))], "claude:a", "claude:b")).toMatch(/truncated: open session claude:b/);
  });
});

describe("the stdio MCP server", () => {
  test("lists the tools and passes a call to the runner's socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peers-mcp-"));
    const secret = peerSecret(dir);
    const sock = new PeerSocket(join(dir, "p.sock"), secret, async (c) => ({ text: `from ${c.from}: ${c.tool}` }));
    sock.start();
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "mcp.ts")], {
      stdin: "pipe",
      stdout: "pipe",
      env: { ...process.env, TETHER_PEERS_SOCKET: sock.socketPath, TETHER_PEERS_ID: "codex:*", TETHER_PEERS_TOKEN: peerToken(secret, "codex:*") },
    });
    try {
      const lines: any[] = [];
      const reader = (async () => {
        let buf = "";
        for await (const chunk of p.stdout) {
          buf += new TextDecoder().decode(chunk);
          for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) lines.push(JSON.parse(buf.slice(0, i)));
        }
      })();
      const send = (m: unknown) => p.stdin.write(JSON.stringify(m) + "\n");
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tether_sessions", arguments: {}, _meta: { threadId: "t9" } } });
      for (let i = 0; i < 100 && lines.length < 3; i++) await Bun.sleep(20);
      expect(lines.find((l) => l.id === 2).result.tools.map((t: any) => t.name)).toEqual(["tether_sessions", "tether_send", "tether_ask", "tether_broadcast"]);
      expect(lines.find((l) => l.id === 3).result.content[0].text).toBe("from codex:t9: tether_sessions");
      p.stdin.end();
      await reader;
    } finally {
      p.kill();
      sock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
