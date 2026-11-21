// The texting hub end to end: a hub runner and a spoke runner, each with its Texter, joined by a
// fake app that passes their frames on as the relay does (JSON both ways).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "../../../../shared/attachments";
import { HUB_CHUNK, parseHubFrame, type HubFrame, type TextingHubInfo } from "../../../../shared/textingHub";
import { parseRunnerMessage } from "../../../../shared/wire";
import type { Request, RequestAnswer } from "../../../../shared/transcript";
import { HubPort } from "../../core/hubPort";
import { parseRemote, remoteKey, Texter } from ".";
import type { ChannelLink, Connector, Inbound, Outbound } from "./connector";
import { HubWire } from "./hubWire";
import { TextingStore } from "./store";
import { TEXTS } from "./texts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** A connector the test holds (as connector.test.ts's). */
function fake(id: string, images = false) {
  const state = { sent: [] as Outbound[], hear: (_m: Inbound) => {}, reacted: [] as string[] };
  let n = 0;
  const c: Connector = {
    id,
    label: id,
    mark: `[From ${id}] `,
    images,
    about: "",
    notReady: "",
    enabled: () => true,
    configured: () => true,
    async open(onInbound) {
      state.hear = onInbound;
      const closed = new Promise<void>(() => {});
      return { send: async (o: Outbound) => (state.sent.push(o), `${id}-${++n}`), closed, stop: async () => {} } satisfies ChannelLink;
    },
    forms: () => [],
    update: () => {},
  };
  return { c, state };
}

/** Two runners' ports, joined as the relay joins them: frames as JSON, only between a runner and its hub. */
function app() {
  const ports = new Map<string, HubPort>();
  const delivered: { from: string; to: string; m: HubFrame }[] = [];
  const port = (id: string) => {
    const p: HubPort = new HubPort(
      (frame) => {
        // As the server parses it, and as the runner's connection does.
        const m = parseRunnerMessage(JSON.stringify(frame));
        if (m?.t !== "texting") return false;
        const to = ports.get(m.to);
        const back = parseHubFrame(JSON.parse(JSON.stringify(m.m)))!;
        if (!to) {
          if (back.k === "req") queueMicrotask(() => p.gotFrame(m.to, { k: "res", rid: back.rid, ok: false, error: "That computer is offline." }));
          return true;
        }
        delivered.push({ from: id, to: m.to, m: back });
        queueMicrotask(() => to.gotFrame(id, back));
        return true;
      },
      () => 0,
      () => {},
    );
    ports.set(id, p);
    return p;
  };
  return { port, ports, delivered };
}

type Look = { summary: { id: string; projectPath: string; parentSessionId?: string; title?: string }; status: string; requests: string[]; state: any; busy?: boolean };

function runner(id: string, port: HubPort, o: { connectors?: Connector[]; hub?: boolean; attachmentsDir?: string } = {}) {
  const told: [string, string, Attachment[]?][] = [];
  const answered: [string, string, RequestAnswer][] = [];
  const sessions: Record<string, Look> = {};
  const store = new TextingStore(undefined, {});
  store.hub = !!o.hub;
  const t = new Texter(
    {
      log: () => {},
      runnerId: id,
      appUrl: "https://tether.example/",
      hub: port,
      ...(o.attachmentsDir ? { attachmentsDir: o.attachmentsDir } : {}),
      session: (sid) => sessions[sid] as any,
      // runner.json's ticked sessions, as the box left them
      texters: () => Object.values(sessions).filter((x) => x.state.canText && !x.summary.parentSessionId).map((x) => ({ id: x.summary.id, title: x.summary.title ?? "" })),
      viewersOf: () => [],
      sessions: { tell: async (sid, text, files) => void told.push(files?.length ? [sid, text, files] : [sid, text]), answer: async (sid, rid, a) => void answered.push([sid, rid, a]) },
    },
    store,
    undefined,
    Date.now,
    { list: o.connectors ?? [] },
  );
  const add = (sid: string, s: Partial<Look> = {}) => (sessions[sid] = { summary: { id: sid, projectPath: "/p" }, status: "idle", requests: [], state: { requests: [], canText: true }, ...s });
  return { t, told, answered, sessions, add, store };
}

/** A hub ("dev", iMessage and Discord) and a spoke ("aws", no connectors of its own), the spoke told the hub is dev. */
async function pair(o: { attachmentsDir?: string } = {}) {
  const net = app();
  const im = fake("imessage");
  const dc = fake("discord", true);
  const hub = runner("dev", net.port("dev"), { connectors: [im.c, dc.c], hub: true });
  const spoke = runner("aws", net.port("aws"), o);
  await hub.t.start();
  await spoke.t.start();
  const info: TextingHubInfo = { id: "dev", name: "dev", up: true, images: true };
  net.ports.get("aws")!.gotHub(info);
  hub.add("claude:here");
  spoke.add("claude:there");
  return { net, im: im.state, dc: dc.state, hub, spoke, info };
}

const words = (o: Outbound | undefined) => o?.text.split("\n")[0];

describe("the hub's wire", () => {
  test("a call is answered; a file goes in pieces and comes out whole; a refused one says why", async () => {
    const net = app();
    const a = new HubWire(net.port("a"));
    const b = new HubWire(net.port("b"));
    a.start();
    b.start();
    b.handle(async (from, op, args, files) => ({ from, op, args, sizes: files.map((f) => [f.name, f.data.byteLength, f.data[f.data.byteLength - 1]]) }));
    const big = new Uint8Array(HUB_CHUNK * 2 + 10).map((_, i) => i % 251);
    const r = (await a.call("b", "hi", { x: 1 }, { files: [{ name: "f.bin", mimeType: "application/octet-stream", data: big }] })) as any;
    expect(r).toEqual({ from: "a", op: "hi", args: { x: 1 }, sizes: [["f.bin", big.byteLength, big[big.byteLength - 1]]] });
    // Three pieces, then the call.
    expect(net.delivered.filter((d) => d.m.k === "chunk").length).toBe(3);
    b.handle(async () => {
      throw new Error("nope");
    });
    await expect(a.call("b", "hi", {})).rejects.toThrow("nope");
    // Nobody there: offline, at once.
    await expect(a.call("c", "hi", {})).rejects.toThrow("offline");
  });

  test("no answer in time: it may or may not have happened (timedOut)", async () => {
    const net = app();
    const a = new HubWire(net.port("a"));
    a.start();
    net.port("b").onFrame(() => {});
    const e: any = await a.call("b", "send", {}, { timeoutMs: 20, what: "a send" }).catch((x) => x);
    expect(e.timedOut).toBe("a send");
  });

  test("a file sent without its end piece, or a call naming a file that never came, fails the call", async () => {
    const net = app();
    const b = new HubWire(net.port("b"));
    b.start();
    b.handle(async () => "ok");
    const answers: HubFrame[] = [];
    net.port("a").onFrame((_f, m) => answers.push(m));
    const a = net.ports.get("a")!;
    a.post("b", { k: "chunk", x: "x1", i: 0, data: "AAAA" });
    a.post("b", { k: "req", rid: "r1", op: "send", args: {}, files: [{ x: "x1", name: "n", mimeType: "image/png" }] });
    a.post("b", { k: "req", rid: "r2", op: "send", args: {}, files: [{ x: "x9", name: "n", mimeType: "image/png" }] });
    await tick();
    expect(answers).toEqual([
      { k: "res", rid: "r1", ok: false, error: "A file didn't come through." },
      { k: "res", rid: "r2", ok: false, error: "A file didn't come through." },
    ]);
  });
});

describe("one number for every computer", () => {
  test("remote keys round-trip", () => {
    expect(parseRemote(remoteKey("aws", "claude:x"))).toEqual({ runnerId: "aws", sessionId: "claude:x" });
    expect(parseRemote("claude:x")).toBeUndefined();
  });

  test("the hub says it's the hub, and whether texts can go", async () => {
    const { net } = await pair();
    // Its texts go to iMessage here (the first connected), which takes no images.
    expect(net.ports.get("dev")!.state).toEqual({ up: true, images: false });
    // A spoke never says it is one.
    expect(net.ports.get("aws")!.state).toBeUndefined();
  });

  test("a spoke's session texts through the hub, numbered with the hub's own; a reply by number goes back to it", async () => {
    const { im, hub, spoke } = await pair();
    await hub.t.tell("claude:here", "asked you something", "Here?", { quick: true });
    await spoke.t.tell("claude:there", "asked you something", "Which database?", { quick: true });
    expect(im.sent.map(words)).toEqual(["[1] Here?", "[2] Which database?"]);
    // The spoke's link is its own runner's.
    await spoke.t.tell("claude:there", "asked you something", "Still there?");
    expect(im.sent.at(-1)!.text).toContain("/#/s/aws/claude%3Athere");
    // A number that isn't open: the picker lists both computers' sessions.
    im.hear({ text: "7 hm" });
    await tick(20);
    expect(im.sent.at(-1)!.text).toContain("[1]");
    expect(im.sent.at(-1)!.text).toContain("[2]");
    im.hear({ text: "2 postgres", react: async (e) => void im.reacted.push(e) });
    await tick(20);
    expect(spoke.told).toEqual([["claude:there", "postgres"]]);
    expect(hub.told).toEqual([]);
    // Taken there: the ✅ comes back to the person's message on the hub.
    expect(im.reacted).toEqual(["✅"]);
  });

  test("a spoke's request is answered by y on the hub's phone; once closed there, a late y says so", async () => {
    const { im, spoke } = await pair();
    const r: Request = { id: "r1", sessionId: "claude:there", kind: "approval", tool: "Bash", toolKind: "shell", openedAt: 1 } as Request;
    spoke.add("claude:there", { requests: ["r1"], state: { canText: true, requests: [r] } });
    await spoke.t.request(r);
    expect(im.sent.at(-1)!.text.startsWith("[1] ")).toBe(true);
    im.hear({ text: "y" });
    await tick(20);
    expect(spoke.answered.map(([s, id, a]) => [s, id, a.allow])).toEqual([["claude:there", "r1", true]]);
    // Closed meanwhile (answered in Tether): a threaded y to the request's text is turned away, through the hub.
    spoke.add("claude:there", { requests: [], state: { canText: true, requests: [] } });
    await spoke.t.request({ ...r, id: "r2" });
    spoke.add("claude:there", { requests: ["r2"], state: { canText: true, requests: [{ ...r, id: "r2" }] } });
    await spoke.t.request({ ...r, id: "r2" });
    spoke.add("claude:there", { requests: [], state: { canText: true, requests: [] } });
    im.hear({ text: "1 y" });
    await tick(20);
    expect(im.sent.at(-1)!.text).toBe(TEXTS.alreadyAnswered(1));
  });

  test("a photo texted to a spoke's session arrives there as an attachment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-photo-"));
    try {
      const { dc, spoke } = await pair({ attachmentsDir: dir });
      await spoke.t.tell("claude:there", "asked you something", "Show me?", { quick: true });
      const big = Buffer.alloc(HUB_CHUNK + 5, 7);
      dc.hear({ text: "1 here", files: [{ name: "shot.png", mimeType: "image/png", size: PNG.length, read: async () => new Uint8Array(PNG) }, { name: "notes.bin", mimeType: "application/octet-stream", size: big.length, read: async () => new Uint8Array(big) }] });
      await tick(50);
      const [sid, text, files] = spoke.told.at(-1)!;
      expect([sid, text]).toEqual(["claude:there", "here"]);
      expect(files!.map((f) => [f.name, f.mimeType, f.size])).toEqual([
        ["shot.png", "image/png", PNG.length],
        ["notes.bin", "application/octet-stream", big.length],
      ]);
      expect(files![0]!.path.startsWith(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a spoke's session texts the person a photo; a threaded reply to it reaches that session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-out-"));
    try {
      const { dc, spoke, hub } = await pair();
      hub.store.prefer = "discord";
      const p = join(dir, "chart.png");
      writeFileSync(p, PNG);
      const r = await spoke.t.personText("claude:there", "Here's the chart", { image: p });
      expect(r.isError).toBeUndefined();
      expect(dc.sent.at(-2)!.text.startsWith("[1] Here's the chart")).toBe(true);
      const img = dc.sent.at(-1)!;
      expect(img.files!.map((f) => [f.name, f.mimeType, Buffer.from(f.data).equals(PNG)])).toEqual([["chart.png", "image/png", true]]);
      // The image's id is noted for that session on the hub.
      dc.hear({ text: "nice", replyTo: "discord-2" });
      await tick(20);
      expect(spoke.told.at(-1)).toEqual(["claude:there", "nice"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Discord channel message to a spoke's idle session: that turn's answer goes back to the channel, later ones to the DM", async () => {
    const { dc, spoke } = await pair();
    await spoke.t.tell("claude:there", "asked you something", "Go?", { quick: true });
    dc.hear({ text: "1 dm first", place: "dm-1" });
    await tick(20);
    dc.hear({ text: "1 go", place: "chan-9", shared: true });
    await tick(20);
    spoke.t.said("claude:there", { id: "u-go", role: "user", ts: 1, parts: [{ type: "text", text: "go" }] });
    spoke.t.turnStarted("claude:there");
    spoke.t.said("claude:there", { id: "x", role: "assistant", ts: 1, parts: [{ type: "text", text: "Done that." }] });
    await spoke.t.turnEnded("claude:there");
    expect(dc.sent.at(-1)).toEqual({ text: "[1] Done that.", place: "chan-9", shared: true });
    // The next answer goes to the DM it was last written from.
    spoke.t.said("claude:there", { id: "u2", role: "user", ts: 2, parts: [{ type: "text", text: "more" }] });
    dc.hear({ text: "1 more", place: "dm-1" });
    await tick(20);
    spoke.t.turnStarted("claude:there");
    spoke.t.said("claude:there", { id: "y", role: "assistant", ts: 2, parts: [{ type: "text", text: "More done." }] });
    await spoke.t.turnEnded("claude:there");
    expect(dc.sent.at(-1)).toEqual({ text: "[1] More done.", place: "dm-1" });
  });

  test("answered on the spoke (in Tether): the hub's picker leaves it out", async () => {
    const { im, hub, spoke } = await pair();
    await hub.t.tell("claude:here", "asked you something", "A?", { quick: true });
    await spoke.t.tell("claude:there", "asked you something", "B?", { quick: true });
    spoke.t.settled("claude:there");
    await tick(20);
    const slot = hub.t.router.state.slots.find((s) => s.sessionId === remoteKey("aws", "claude:there"))!;
    expect(slot.answered).toBe(true);
    im.hear({ text: "7 hm" });
    await tick(20);
    expect(im.sent.at(-1)!.text).not.toContain("[2]");
  });

  test("no hub connected: a spoke can't text, and its agent is told; a reply for a spoke that's gone says it didn't go", async () => {
    const { net, im, spoke } = await pair();
    await spoke.t.tell("claude:there", "asked you something", "B?", { quick: true });
    net.ports.get("aws")!.gotHub(null);
    expect((await spoke.t.tell("claude:there", "asked you something", "C?")).sent).toBe(false);
    expect((await spoke.t.personText("claude:there", "hi")).isError).toBe(true);
    // The spoke went offline; the person replies to its number.
    net.ports.delete("aws");
    im.hear({ text: "1 hello" });
    await tick(20);
    expect(im.sent.at(-1)!.text).toBe(TEXTS.couldNotSend("[1]", "That computer is offline."));
  });

  test("the \"Session can text me\" box: the spoke gates its own sessions, and the hub drops and offers them", async () => {
    const { im, hub, spoke } = await pair();
    hub.sessions["claude:here"]!.state.canText = undefined;
    // Unticked on the spoke: nothing reaches the hub.
    spoke.sessions["claude:there"]!.state.canText = undefined;
    expect((await spoke.t.tell("claude:there", "asked you something", "B?", { quick: true })).sent).toBe(false);
    expect((await spoke.t.personText("claude:there", "hi")).isError).toBe(true);
    expect(im.sent).toEqual([]);
    // Ticked: it texts, numbered by the hub, which offers it later by the name it sent.
    spoke.sessions["claude:there"]!.state.canText = true;
    spoke.sessions["claude:there"]!.summary.title = "db migration";
    spoke.t.canTextChanged("claude:there", true);
    await tick(20);
    const key = remoteKey("aws", "claude:there");
    expect(hub.store.remoteTexters[key]?.label).toBe("db migration");
    await spoke.t.tell("claude:there", "asked you something", "B?", { quick: true });
    expect(words(im.sent.at(-1))).toBe("[1] B?");
    // Unticked: its number goes on the hub too, and a text to it says it can't text.
    spoke.sessions["claude:there"]!.state.canText = undefined;
    spoke.t.canTextChanged("claude:there", false);
    await tick(20);
    expect(hub.t.router.state.slots.find((x) => x.sessionId === key)).toBeUndefined();
    expect(hub.store.remoteTexters[key]).toBeUndefined();
    im.hear({ text: "1 go" });
    await tick(20);
    expect(im.sent.at(-1)!.text).toBe(TEXTS.cantText(1));
    expect(spoke.told).toEqual([]);
    // Ticked again with nothing open: the hub's picker offers it, and a number reaches it.
    spoke.sessions["claude:there"]!.state.canText = true;
    spoke.t.canTextChanged("claude:there", true);
    await tick(20);
    im.hear({ text: "status?" });
    await tick(20);
    expect(im.sent.at(-1)!.text).toBe("Which session, by number?\n[1] db migration");
    im.hear({ text: "1" });
    await tick(20);
    expect(spoke.told).toEqual([["claude:there", "status?"]]);
    expect(hub.told).toEqual([]);
  });

  test("a lost untick: the spoke turns away what the hub hands it, and the hub hears the set again", async () => {
    const { net, im, hub, spoke, info } = await pair();
    await spoke.t.tell("claude:there", "asked you something", "B?", { quick: true });
    const key = remoteKey("aws", "claude:there");
    expect(hub.store.remoteTexters[key]).toBeDefined();
    // Unticked (or archived) on the spoke while the hub was away: the hub never heard.
    net.ports.get("aws")!.gotHub(null);
    spoke.sessions["claude:there"]!.state.canText = undefined;
    spoke.t.canTextChanged("claude:there", false);
    expect(hub.t.router.state.slots.some((x) => x.sessionId === key)).toBe(true);
    // Back: the hub hears the set again at once.
    net.ports.get("aws")!.gotHub(info);
    await tick(20);
    expect(hub.t.router.state.slots.some((x) => x.sessionId === key)).toBe(false);
    expect(hub.store.remoteTexters[key]).toBeUndefined();
    // Even if the hub's router still had it: the spoke says it can't text, and delivers nothing.
    hub.t.router.stamp(key, "asked you something", ".");
    im.hear({ text: "1 go" });
    await tick(30);
    expect(spoke.told).toEqual([]);
    expect(im.sent.at(-1)!.text).toBe(TEXTS.cantText(1));
    expect(hub.t.router.state.slots.some((x) => x.sessionId === key)).toBe(false);
  });

  test("a spoke that starts tells its hub the sessions that may text", async () => {
    const { net, hub } = await pair();
    // Its hub known before its texting starts (no change to hear of): the start itself says.
    const port = net.port("gcp");
    port.gotHub({ id: "dev", name: "dev", up: true, images: true });
    const late = runner("gcp", port);
    late.add("claude:far", { summary: { id: "claude:far", projectPath: "/p", title: "far away" } });
    expect(hub.store.remoteTexters[remoteKey("gcp", "claude:far")]).toBeUndefined();
    await late.t.start();
    await tick(20);
    expect(hub.store.remoteTexters[remoteKey("gcp", "claude:far")]?.label).toBe("far away");
  });

  test("a spoke's Home agent doesn't text through the hub", async () => {
    const { im, spoke } = await pair();
    expect(await spoke.t.homeText("on it")).toBe(false);
    const r = await spoke.t.personText("home", "hello");
    expect([r.isError, r.text.includes("dev")]).toEqual([true, true]);
    expect(im.sent).toEqual([]);
  });

  test("a runner that isn't the hub refuses a spoke's texts, and only its own hub delivers to a spoke", async () => {
    const net = app();
    const notHub = runner("x", net.port("x"));
    const spoke = runner("aws", net.port("aws"));
    await notHub.t.start();
    await spoke.t.start();
    const w = new HubWire(net.port("y"));
    w.start();
    await expect(w.call("x", "send", { text: "hi" })).rejects.toThrow("isn't the texting hub");
    net.ports.get("aws")!.gotHub({ id: "dev", name: "dev", up: true, images: false });
    await expect(w.call("aws", "deliver", { sessionId: "claude:a", n: 1, text: "y" })).rejects.toThrow("doesn't text for this one");
  });
});
