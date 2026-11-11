import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionMessage, peerHops, tetherOrigin } from "../../../../shared/fromTether";
import type { Msg, SessionSummary } from "../../../../shared/transcript";
import { claudeMove } from "../../adapters/claude/move";
import { codexMove } from "../../adapters/codex/move";
import { classifyTool } from "../../adapters/toolKind";
import { peerTarget } from "../../../../shared/peers";
import { ASKS_MAX, MAX_HOPS, PeerCaps, RATE_MAX } from "./caps";
import { answerIn, Peers } from "./index";
import { callerOf, peerSecret, peerToken, PeerSocket } from "./server";

const row = (id: string, title: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ id, harness: id.startsWith("codex") ? "codex" : "claude", nativeId: id.split(":")[1]!, projectPath: "/p/app", title, mode: "live", status: "idle", updatedAt: 0, ...o });

/** Peers over a fake set of sessions (`stored`: older ones the lists leave out); what it queues and notices is recorded. */
function setup(rows: SessionSummary[], o: { stored?: SessionSummary[]; home?: string; modes?: Record<string, string | undefined> } = {}) {
  const queued: { to: string; text: string; id: string }[] = [];
  const notices: { id: string; text: string }[] = [];
  const recent = new Map<string, Msg[]>();
  const fail = new Set<string>();
  let n = 0;
  let now = 1_000_000;
  const look = (id: string) => {
    const s = [...rows, ...(o.stored ?? [])].find((r) => r.id === id);
    // Every session asks first unless `modes` says otherwise (undefined: not known).
    const permissionMode = o.modes && id in o.modes ? o.modes[id] : s?.harness === "codex" ? "untrusted" : "default";
    return s ? ({ summary: s, status: s.status, requests: [], state: { mode: s.mode, queue: [], permissionMode } as any, busy: false, background: false }) : undefined;
  };
  const ctx: any = {
    log: () => {},
    homeFolder: o.home,
    session: look,
    sessions: {
      list: () => rows,
      open: async (id: string) => look(id) ?? Promise.reject(new Error("none")),
      adapters: () => [{ id: "claude", move: claudeMove }, { id: "codex", move: codexMove }],
      queue: async (to: string, text: string) => {
        if (fail.has(to)) throw new Error("queue full");
        const id = `q${++n}`;
        queued.push({ to, text, id });
        return { id };
      },
      notice: async (id: string, m: Msg) => void notices.push({ id, text: (m.parts[0] as any).text }),
      recent: async (id: string) => recent.get(id) ?? [],
    },
  };
  const peers = new Peers(ctx, () => now);
  return { peers, queued, notices, recent, fail, tick: (ms: number) => (now += ms) };
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
      const file = join(dir, "secret");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      chmodSync(file, 0o644);
      expect(peerSecret(dir)).toBe(secret);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      writeFileSync(file, "junk\n", { mode: 0o644 });
      chmodSync(file, 0o644);
      expect(peerSecret(dir)).not.toBe(secret);
      expect(statSync(file).mode & 0o777).toBe(0o600);
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
    expect(peerTarget(r.text)).toEqual({ id: "codex:b", title: "Beta" });
    expect(parseSessionMessage(queued[0]!.text)).toMatchObject({ title: "Alpha", sessionId: "claude:a", text: "hello" });
    expect(await peers.send("claude:a", "claude:a", "x").catch((e) => e.message)).toMatch(/this session/);
    expect((await peers.call({ from: "claude:a", tool: "tether_sessions", args: {}, signal: new AbortController().signal })).text).toContain("codex:b");
  });
  test("ask waits for the target's next turn and returns its answer", async () => {
    const { peers, queued, recent } = setup([row("claude:a", "Alpha"), row("claude:b", "Beta")]);
    const p = peers.ask("claude:a", "claude:b", "2+2?", 15);
    await Bun.sleep(1);
    peers.queueGone("claude:b", queued[0]!.id, "sent", queued[0]!.text);
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
    peers.queueGone("claude:b", queued[0]!.id, "cancelled", queued[0]!.text);
    expect((await p1).text).toMatch(/Not delivered/);
    const p2 = peers.ask("claude:a", "claude:b", "q2", 15);
    await Bun.sleep(1);
    peers.queueGone("claude:b", queued[1]!.id, "sent", queued[1]!.text);
    await peers.turnEnded("claude:b", "boom");
    expect((await p2).text).toMatch(/failed: boom/);
    const p3 = peers.ask("claude:a", "claude:b", "q3", 15);
    await Bun.sleep(1);
    peers.queueGone("claude:b", queued[2]!.id, "sent", queued[2]!.text);
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
      peers.queueGone(to, queued.at(-1)!.id, "sent", queued.at(-1)!.text);
      [from, to] = [to, from];
    }
    const refused = await peers.send(from, to, "one more");
    expect(refused.isError).toBe(true);
    expect(notices.at(-1)!.id).toBe(from);
    peers.message(from, { id: "p", role: "user", ts: 0, parts: [{ type: "text", text: "carry on" }] });
    expect((await peers.send(from, to, "again")).isError).toBeFalsy();
  });
  test("hops come from the queued message, so they survive a restart; a turn's end clears them", async () => {
    const { peers, queued } = setup([row("claude:a", "A"), row("claude:b", "B")]);
    peers.caps.turnFrom("claude:a", { hops: 2 });
    await peers.send("claude:a", "claude:b", "x");
    expect(peerHops(queued[0]!.text)).toBe(3);
    expect(parseSessionMessage(queued[0]!.text)?.text).toBe("x");
    // A new runner: nothing in memory, the message still queued.
    const { peers: after } = setup([row("claude:a", "A"), row("claude:b", "B")]);
    after.queueGone("claude:b", "q-old", "sent", queued[0]!.text);
    expect(after.caps.hopsFrom("claude:b")).toBe(4);
    await after.turnEnded("claude:b");
    expect(after.caps.hopsFrom("claude:b")).toBe(1);
    // A broadcast's turn stays one, across a restart too.
    after.queueGone("claude:b", "q-all", "sent", '[From session "A" (claude:a) to all] hi\n\n[Tether: hop 1. note]');
    expect(after.caps.checkBroadcast("claude:b")).toMatch(/can't send one to all/);
  });
  test("broadcast: everyone else matching, once; a receiver can't pass it on", async () => {
    const { peers, queued } = setup([row("claude:a", "A"), row("claude:b", "B"), row("codex:c", "C", { projectPath: "/p/other" }), row("claude:d", "D", { archived: true })]);
    const r = await peers.broadcastFrom("claude:a", "main moved", { project: "app" });
    expect(r.text).toMatch(/Sent to 1 session/);
    expect(queued.map((q) => q.to)).toEqual(["claude:b"]);
    expect(parseSessionMessage(queued[0]!.text)?.all).toBe(true);
    expect((await peers.broadcastFrom("claude:a", "again", {})).isError).toBe(true);
    peers.queueGone("claude:b", queued[0]!.id, "sent", queued[0]!.text);
    expect((await peers.broadcastFrom("claude:b", "relay", {})).text).toMatch(/can't send one to all/);
  });
  test("an agent's broadcast stays in its own project unless it names one or asks for all", async () => {
    const rows = [row("claude:a", "A"), row("claude:b", "B"), row("codex:c", "C", { projectPath: "/p/other" }), row("claude:d", "D", { projectPath: "/p/other" })];
    let { peers, queued, tick } = setup(rows);
    await peers.broadcastFrom("claude:a", "mine", {});
    expect(queued.map((q) => q.to)).toEqual(["claude:b"]);
    tick(11 * 60_000);
    await peers.broadcastFrom("claude:a", "theirs", { project: "other" });
    expect(queued.slice(1).map((q) => q.to)).toEqual(["codex:c", "claude:d"]);
    tick(11 * 60_000);
    await peers.broadcastFrom("claude:a", "everyone", { scope: "all" });
    expect(queued.slice(3).map((q) => q.to)).toEqual(["claude:b", "codex:c", "claude:d"]);
    ({ peers, queued } = setup([row("claude:a", "A"), row("codex:c", "C", { projectPath: "/p/other" })]));
    expect((await peers.broadcastFrom("claude:a", "x", {})).text).toMatch(/No other session in this project/);
  });
  test("Send to all from the person: as their own words, filtered, archived left out", async () => {
    const { peers, queued } = setup([row("claude:a", "A"), row("codex:b", "B", { status: "running" }), row("claude:d", "D", { archived: true })]);
    const r = await peers.broadcast("[From Tether] stop", {});
    expect(r.queued.map((q) => q.sessionId)).toEqual(["claude:a", "codex:b"]);
    expect(tetherOrigin(queued[0]!.text)).toBeUndefined();
    expect((await peers.broadcast("x", { harness: "codex", status: "working" })).queued.map((q) => q.sessionId)).toEqual(["codex:b"]);
  });
  test("the Home agent's chat can't be reached; an older session can, by its id", async () => {
    const home = "/cfg/modules/homeAgent/workspace";
    const { peers, queued } = setup([row("claude:a", "A"), row("claude:h", "Home chat", { projectPath: home }), row("claude:b", "B")], { home, stored: [row("claude:old", "Old one"), row("claude:gone", "Archived", { archived: true })] });
    const list = (await peers.call({ from: "claude:a", tool: "tether_sessions", args: {}, signal: new AbortController().signal })).text;
    expect(list).not.toContain("claude:h");
    expect(await peers.send("claude:a", "claude:h", "x").catch((e) => e.message)).toMatch(/can't be messaged/);
    expect(await peers.send("claude:a", "Home chat", "x").catch((e) => e.message)).toMatch(/no session/);
    expect((await peers.broadcastFrom("claude:a", "hi", { scope: "all" })).text).not.toContain("claude:h");
    expect((await peers.broadcast("hi", {})).queued.map((q) => q.sessionId)).toEqual(["claude:a", "claude:b"]);
    expect(queued.some((q) => q.to === "claude:h")).toBe(false);
    expect((await peers.send("claude:a", "claude:old", "still there?")).text).toMatch(/Sent to "Old one" \(claude:old\)/);
    expect(await peers.send("claude:a", "Old one", "x").catch((e) => e.message)).toMatch(/no session/);
    expect(await peers.send("claude:a", "claude:gone", "x").catch((e) => e.message)).toMatch(/can't be messaged/);
  });
  test("titles in answers are one line, without control characters", async () => {
    const { peers } = setup([row("claude:a", "A"), row("claude:b", 'Line one\nline "two"\x1b[31m'), row("claude:c", "Line three")]);
    const list = (await peers.call({ from: "claude:a", tool: "tether_sessions", args: {}, signal: new AbortController().signal })).text;
    expect(list.split("\n")).toHaveLength(2);
    expect(list).not.toMatch(/[\x00-\x08\x0b-\x1f]/);
    const many = await peers.send("claude:a", "line", "x").catch((e) => e.message);
    expect(many).toMatch(/2 sessions match/);
    expect(many).not.toMatch(/[\x00-\x1f]/);
  });
  test("a stricter session can't message a looser one", async () => {
    const rows = [row("claude:plan", "Planner"), row("claude:edits", "Editor"), row("claude:full", "Bypass"), row("codex:full", "Codex full"), row("codex:ro", "Codex reader"), row("claude:what", "Unknown")];
    const modes = { "claude:plan": "plan", "claude:edits": "acceptEdits", "claude:full": "bypassPermissions", "codex:full": "full-access", "codex:ro": "read-only", "claude:what": undefined };
    const { peers, queued } = setup(rows, { modes });
    const r = await peers.send("claude:edits", "claude:full", "do it");
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/doesn't have permission/);
    expect(queued.length).toBe(0);
    const a = await peers.ask("claude:plan", "codex:full", "q", 1);
    expect(a.isError).toBe(true);
    expect(queued.length).toBe(0);
    // Equal or stricter: straight through.
    expect((await peers.send("claude:full", "codex:full", "x")).isError).toBeFalsy();
    expect((await peers.send("claude:edits", "codex:ro", "x")).isError).toBeFalsy();
    expect((await peers.send("claude:edits", "claude:plan", "x")).isError).toBeFalsy();
    expect(queued.length).toBe(3);
    // Unknown: the loosest as a target, the strictest as a sender.
    expect((await peers.send("claude:full", "claude:what", "x")).isError).toBe(true);
    expect((await peers.send("claude:what", "codex:ro", "x")).isError).toBeFalsy();
    await peers.send("claude:what", "claude:plan", "x");
    // The receiver reads the sender's permissions.
    expect(queued.at(-1)!.text).toMatch(/\[Tether: [^\]]*The sender's permissions: read only\.\]$/);
    expect(parseSessionMessage(queued.at(-1)!.text)?.text).toBe("x");
  });
  test("a broadcast leaves out sessions looser than the sender", async () => {
    const rows = [row("claude:a", "A"), row("claude:b", "B"), row("claude:c", "C")];
    const { peers, queued } = setup(rows, { modes: { "claude:a": "acceptEdits", "claude:b": "plan", "claude:c": "bypassPermissions" } });
    const r = await peers.broadcastFrom("claude:a", "hi", { scope: "all" });
    expect(queued.map((q) => q.to)).toEqual(["claude:b"]);
    expect(r.text).toMatch(/No permission[^]*claude:c/);
  });
  test("caps hold for calls running side by side", async () => {
    const { peers, queued } = setup([row("claude:a", "A"), row("claude:b", "B"), row("claude:c", "C"), row("claude:d", "D"), row("claude:e", "E")]);
    // A asks B while B asks A: only one of them waits.
    const [ab, ba] = [peers.ask("claude:a", "claude:b", "q", 15), peers.ask("claude:b", "claude:a", "q", 15)];
    expect((await ba).text).toMatch(/waiting for an answer from you/);
    // One sender, more asks at once than it may keep open.
    const more = ["claude:c", "claude:d", "claude:e"].map((to) => peers.ask("claude:a", to, "q", 15));
    const refused = await Promise.race([Promise.all(more.slice(2)), Bun.sleep(50).then(() => undefined)]);
    expect(refused?.[0]?.text).toMatch(/questions waiting/);
    expect(queued).toHaveLength(3);
    void ab;
    // And more sends at once than the rate allows.
    const { peers: p2 } = setup([row("claude:a", "A"), row("claude:b", "B")]);
    const r = await Promise.all(Array.from({ length: RATE_MAX + 2 }, (_, i) => p2.send("claude:a", "claude:b", `m${i}`)));
    expect(r.filter((x) => x.isError)).toHaveLength(2);
  });
  test("a message that didn't go doesn't count", async () => {
    const { peers, fail } = setup([row("claude:a", "A"), row("claude:b", "B")]);
    fail.add("claude:b");
    for (let i = 0; i < RATE_MAX + 1; i++) await peers.send("claude:a", "claude:b", "x").catch(() => {});
    for (let i = 0; i < ASKS_MAX + 1; i++) await peers.ask("claude:a", "claude:b", "x", 15).catch(() => {});
    expect(await peers.broadcastFrom("claude:a", "x", {})).toMatchObject({ text: expect.stringMatching(/Couldn't send/) });
    fail.clear();
    expect((await peers.send("claude:a", "claude:b", "x")).isError).toBeFalsy();
    expect((await peers.broadcastFrom("claude:a", "x", {})).isError).toBeFalsy();
  });
  test("answerIn takes the last reply after the question, cut short when long", () => {
    const q = (sessionId: string): Msg => ({ id: sessionId, role: "user", ts: 0, origin: { kind: "session", sessionId }, parts: [{ type: "text", text: "?" }] });
    const a = (text: string): Msg => ({ id: text.slice(0, 5), role: "assistant", ts: 0, parts: [{ type: "text", text }] });
    expect(answerIn([a("old"), q("claude:a"), a("first"), a("final")], "claude:a", "claude:b")).toBe("final");
    expect(answerIn([q("claude:a")], "claude:a", "claude:b")).toBeUndefined();
    expect(answerIn([q("claude:a"), a("x".repeat(30_000))], "claude:a", "claude:b")).toMatch(/truncated: open session claude:b/);
  });
});

/** mcp.ts as a harness runs it, on `socket`; its answers by request id. */
function mcp(socket: string, secret: string) {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "mcp.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    env: { ...process.env, TETHER_PEERS_SOCKET: socket, TETHER_PEERS_ID: "codex:*", TETHER_PEERS_TOKEN: peerToken(secret, "codex:*") },
  });
  const lines: any[] = [];
  const reader = (async () => {
    let buf = "";
    for await (const chunk of p.stdout) {
      buf += new TextDecoder().decode(chunk);
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) lines.push(JSON.parse(buf.slice(0, i)));
    }
  })();
  return {
    lines,
    send: (m: unknown) => p.stdin.write(JSON.stringify(m) + "\n"),
    raw: (b: Uint8Array) => (p.stdin.write(b), p.stdin.flush()),
    answer: async (id: number) => {
      for (let i = 0; i < 150 && !lines.some((l) => l.id === id); i++) await Bun.sleep(20);
      return lines.find((l) => l.id === id);
    },
    close: async () => {
      p.stdin.end();
      await reader;
      p.kill();
    },
  };
}

describe("the stdio MCP server", () => {
  test("lists the tools and passes a call to the runner's socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peers-mcp-"));
    const secret = peerSecret(dir);
    const sock = new PeerSocket(join(dir, "p.sock"), secret, async (c) => ({ text: `from ${c.from}: ${c.tool} ${JSON.stringify(c.args)}` }));
    sock.start();
    const m = mcp(sock.socketPath, secret);
    try {
      m.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
      m.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      m.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tether_sessions", arguments: {}, _meta: { threadId: "t9" } } });
      expect((await m.answer(2)).result.tools.map((t: any) => t.name)).toEqual(["tether_sessions", "tether_send", "tether_ask", "tether_broadcast"]);
      expect((await m.answer(3)).result.content[0].text).toBe("from codex:t9: tether_sessions {}");
      // A character split between two reads arrives whole.
      const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tether_send", arguments: { text: "café ✓" }, _meta: { threadId: "t9" } } }) + "\n");
      const cut = bytes.indexOf(0xc3) + 1;
      m.raw(bytes.slice(0, cut));
      await Bun.sleep(50);
      m.raw(bytes.slice(cut));
      expect((await m.answer(4)).result.content[0].text).toBe('from codex:t9: tether_send {"text":"café ✓"}');
    } finally {
      await m.close();
      sock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("a runner that's away says nothing was sent; one that restarts mid-call says it may be queued", async () => {
    const dir = mkdtempSync(join(tmpdir(), "peers-mcp-"));
    const secret = peerSecret(dir);
    let reached!: () => void;
    const got = new Promise<void>((r) => (reached = r));
    const sock = new PeerSocket(join(dir, "p.sock"), secret, () => (reached(), new Promise(() => {})));
    const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "tether_send", arguments: { to: "x", text: "y" }, _meta: { threadId: "t9" } } });
    const m = mcp(sock.socketPath, secret);
    try {
      m.send(call(1));
      const away = (await m.answer(1)).result;
      expect(away.isError).toBe(true);
      expect(away.content[0].text).toMatch(/nothing was sent/);
      sock.start();
      m.send(call(2));
      await got;
      sock.stop();
      const cut = (await m.answer(2)).result;
      expect(cut.isError).toBe(true);
      expect(cut.content[0].text).toMatch(/may already be queued.*check with tether_sessions/);
      expect(cut.content[0].text).not.toMatch(/nothing was sent/);
    } finally {
      await m.close();
      sock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
