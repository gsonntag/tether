import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FROM_DISCORD, FROM_IMESSAGE, TEXTED_MARKS, fromTexted, tetherOrigin, titleText } from "../../../../shared/fromTether";
import type { Attachment } from "../../../../shared/attachments";
import { FILES_ONLY, Texter } from ".";
import { Channel, type ChannelLink, type Connector, type Inbound } from "./connector";
import { connectors } from "./connectors";
import { imessageConnector } from "./imessage";
import { HomeLine, type TakeVia } from "../homeLine";
import { TextingStore } from "./store";
import { TEXTS } from "./texts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A connector whose link the test holds: what it sent, and a way to be the person. */
function fake(id: string, mark: string) {
  const state = { enabled: true, configured: true, sent: [] as { text: string; images?: string[] }[], opens: 0, fail: undefined as string | undefined, hear: (_m: Inbound) => {}, links: [] as (ChannelLink & { end: () => void })[] };
  let n = 0;
  const c: Connector = {
    id,
    label: id,
    mark,
    images: id === "discord",
    about: "",
    notReady: `${id} isn't set`,
    enabled: () => state.enabled,
    configured: () => state.configured,
    async open(onInbound) {
      state.opens++;
      if (state.fail) throw new Error(state.fail);
      state.hear = onInbound;
      let end!: () => void;
      const closed = new Promise<void>((r) => (end = r));
      const link = { send: async (o: { text: string; images?: string[] }) => (state.sent.push(o), `${id}-${++n}`), closed, stop: async () => end(), end };
      state.links.push(link);
      return link;
    },
    forms: () => [],
    update: () => {},
  };
  return { c, state };
}

function setup(o: { home?: boolean; attachmentsDir?: string } = {}) {
  const im = fake("imessage", FROM_IMESSAGE);
  const dc = fake("discord", FROM_DISCORD);
  const told: [string, string, Attachment[]?][] = [];
  const took: [string, TakeVia | undefined][] = [];
  const line = new HomeLine();
  if (o.home) line.home = { take: async (text, via) => void took.push([text, via]), isTextsChat: () => false };
  const sessions: Record<string, any> = {
    "claude:a": { summary: { id: "claude:a", projectPath: "/p" }, status: "idle", requests: [], state: { requests: [] } },
  };
  const store = new TextingStore(undefined, {});
  const t = new Texter(
    {
      log: () => {},
      runnerId: "box",
      appUrl: "https://tether.example/",
      homeLine: line,
      ...(o.attachmentsDir ? { attachmentsDir: o.attachmentsDir } : {}),
      session: (id) => sessions[id],
      viewersOf: () => [],
      sessions: { tell: async (id, text, files) => void told.push(files ? [id, text, files] : [id, text]), answer: async () => {} },
    },
    store,
    undefined,
    Date.now,
    { list: [im.c, dc.c] },
  );
  line.phone = { send: (text) => t.homeText(text), text: (from, body) => t.personText(from, body) };
  return { t, im: im.state, dc: dc.state, told, took, store, line };
}

describe("the registry", () => {
  test("iMessage first, then Discord; each marks the person's words its own way", () => {
    const list = connectors(new TextingStore(undefined, {}));
    expect(list.map((c) => c.id)).toEqual(["imessage", "discord"]);
    expect(new Set(list.map((c) => c.mark)).size).toBe(list.length);
    // Every connector's mark is one the app knows (shared/fromTether.ts), so its texts show as the person's.
    for (const c of list) expect(Object.values(TEXTED_MARKS)).toContain(c.mark as any);
    expect(fromTexted(`${FROM_DISCORD}hi`)).toEqual({ kind: "discord", text: "hi" });
    expect(tetherOrigin(`${FROM_DISCORD}start x`)).toEqual({ origin: { kind: "discord" }, text: "start x" });
    expect(titleText(`${FROM_DISCORD}start x`)).toBe("start x");
    expect(fromTexted("hi")).toBeUndefined();
  });

  test("nothing configured: nothing opens", async () => {
    const list = connectors(new TextingStore(undefined, {}));
    for (const c of list) expect([c.id, c.enabled(), c.configured()]).toEqual([c.id, false, false]);
  });
});

describe("a channel", () => {
  test("opens only when on and set; tags what it hears; reconnects after a drop; a fatal end stays down", async () => {
    const f = fake("x", "[From X] ");
    const heard: Inbound[] = [];
    const ch = new Channel(f.c, (m) => heard.push(m), () => {});
    f.state.enabled = false;
    await ch.start();
    expect([f.state.opens, ch.connected]).toEqual([0, false]);
    f.state.enabled = true;
    await ch.start();
    expect(ch.connected).toBe(true);
    f.state.hear({ text: "hi" });
    expect(heard).toEqual([{ text: "hi", via: "x" }]);
    expect(await ch.send({ text: "yo" })).toEqual(["x-1"]);
    // Images only to a connector that takes them.
    await ch.send({ text: "pic", images: ["/tmp/a.png"] });
    expect(f.state.sent.at(-1)).toEqual({ text: "pic" });
    // A fatal end: down, with why, no retry.
    const link = f.state.links.at(-1)!;
    link.fatal = "bad token";
    link.end();
    await tick();
    expect([ch.connected, ch.lastError]).toEqual([false, "bad token"]);
    // Settings changed: it comes back.
    await ch.restart();
    expect([ch.connected, ch.lastError, f.state.opens]).toEqual([true, undefined, 2]);
    await ch.stop();
    expect(ch.connected).toBe(false);
  });

  test("a failed connect says so", async () => {
    const f = fake("x", "[From X] ");
    f.state.fail = "nope";
    const ch = new Channel({ ...f.c, service: "X Cloud" }, () => {}, () => {});
    await ch.start();
    expect(ch.lastError).toBe("Couldn't connect to X Cloud: nope");
    await ch.stop();
  });
});

describe("texting over several connectors", () => {
  test("texts follow the person to the connector they wrote on; answers go back the way they came", async () => {
    const s = setup();
    await s.t.start();
    // Nobody wrote yet: the first connected (iMessage).
    await s.t.attention("claude:a");
    expect(s.im.sent.length).toBe(1);
    expect(s.im.sent[0]!.text).toStartWith("[1] Claude needs you in the terminal");
    // They answer on Discord: words to the session, and from now on Tether texts on Discord.
    s.dc.hear({ text: "do the thing", id: "d1" });
    await tick();
    expect(s.told).toEqual([["claude:a", "do the thing"]]);
    expect(s.store.lastVia).toBe("discord");
    await s.t.turnEnded("claude:a", "boom");
    expect(s.dc.sent.at(-1)!.text).toStartWith("[1] Claude stopped");
    // A threaded reply on Discord to that text goes to its session.
    s.dc.hear({ text: "retry", replyTo: "discord-1" });
    await tick();
    expect(s.told.at(-1)).toEqual(["claude:a", "retry"]);
    // The picker answers on the connector that asked, even with a preference elsewhere.
    s.t.prefer("imessage");
    s.dc.hear({ text: "7 what?" });
    await tick();
    expect(s.dc.sent.at(-1)!.text).toContain("[7] isn't waiting");
    // Tether's own texts go to the preferred one.
    await s.t.attention("claude:a");
    expect(s.im.sent.at(-1)!.text).toStartWith("[1] Claude needs you");
    // Preferred but down: the last used.
    await s.t.channel("imessage")!.stop();
    await s.t.attention("claude:a");
    expect(s.dc.sent.at(-1)!.text).toStartWith("[1] Claude needs you");
    expect(() => s.t.prefer("telegram")).toThrow("no such connector");
  });

  test("the same message id on two connectors is two messages", async () => {
    const s = setup({ home: true });
    await s.t.start();
    s.im.hear({ id: "1", text: "home: a" });
    s.dc.hear({ id: "1", text: "home: b" });
    s.dc.hear({ id: "1", text: "home: b" });
    await tick();
    expect(s.took.map((x) => x[0])).toEqual(["a", "b"]);
  });

  test("the Home agent gets Discord's words marked as Discord's, and answers on Discord", async () => {
    const s = setup({ home: true });
    await s.t.start();
    s.dc.hear({ text: "start the login fix" });
    await tick();
    expect(s.took).toEqual([["start the login fix", { mark: FROM_DISCORD }]]);
    expect(await s.line.phone!.send("ok, on it")).toBe(true);
    expect(s.dc.sent.at(-1)!.text).toBe("[home] ok, on it");
    expect(s.im.sent).toEqual([]);
    // text_person from a session goes there too.
    expect((await s.line.phone!.text("claude:a", "PR is up")).isError).toBeUndefined();
    expect(s.dc.sent.at(-1)!.text).toStartWith("[1] PR is up\nhttps://tether.example/");
  });

  test("files: stored for the session (read-only), and passed along; a file alone still reaches it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "texting-files-"));
    try {
      const s = setup({ home: true, attachmentsDir: dir });
      await s.t.start();
      await s.t.attention("claude:a");
      const png = { name: "shot one.png", mimeType: "image/png", size: 3, read: async () => new Uint8Array([1, 2, 3]) };
      s.dc.hear({ text: "1 see this", files: [png] });
      await tick(5);
      const [id, text, files] = s.told.at(-1)!;
      expect([id, text]).toEqual(["claude:a", "see this"]);
      expect(files!.map((f) => [f.name, f.mimeType, f.size])).toEqual([["shot_one.png", "image/png", 3]]);
      expect(files![0]!.path).toMatch(/\/claude_a-[0-9a-f]{16}\/[0-9a-f]{8}-shot_one\.png$/);
      expect(files![0]!.path.startsWith(dir)).toBe(true);
      expect([...readFileSync(files![0]!.path)]).toEqual([1, 2, 3]);
      expect(statSync(files![0]!.path).mode & 0o777).toBe(0o400);
      // Just an image.
      s.dc.hear({ text: "", files: [png] });
      await tick(5);
      expect(s.told.at(-1)![1]).toBe(FILES_ONLY);
      expect(s.told.at(-1)![2]!.length).toBe(1);
      // Too big: skipped, and the person is told.
      s.dc.hear({ text: "1 and this", files: [{ ...png, name: "huge.png", size: 50 * 1024 * 1024 }] });
      await tick(5);
      expect(s.told.at(-1)).toEqual(["claude:a", "and this"]);
      expect(s.dc.sent.some((o) => o.text === TEXTS.fileSkipped("huge.png"))).toBe(true);
      // The Home agent stores them for its chat.
      s.dc.hear({ text: "home: look", files: [png] });
      await tick(5);
      const via = s.took.at(-1)![1]!;
      expect(via.mark).toBe(FROM_DISCORD);
      const stored = await via.files!("claude:home");
      expect(stored[0]!.path).toContain("/claude_home-");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("settings: every connector's status, no secrets; set and test one", async () => {
    const s = setup();
    await s.t.start();
    const st = s.t.messaging();
    expect(st.connectors.map((c) => [c.id, c.enabled, c.configured, c.connected])).toEqual([["imessage", true, true, true], ["discord", true, true, true]]);
    await s.t.test("discord");
    expect(s.dc.sent.at(-1)!.text).toBe(TEXTS.test);
    await expect(s.t.setConnector({ id: "nope" })).rejects.toThrow("no such connector");
    await expect(s.t.setConnector({ id: "discord", values: { token: 5 } as any })).rejects.toThrow();
    expect(s.t.prefer("discord").prefer).toBe("discord");
    expect(s.t.prefer(null).prefer).toBeUndefined();
  });
});

describe("iMessage as a connector", () => {
  test("its forms show what's set, never the secret; its link sends the text only", async () => {
    const store = new TextingStore(undefined, {});
    store.update({ enabled: true, phone: "+13105551234", projectId: "p", projectSecret: "imessage-secret-123" });
    const sent: string[] = [];
    const c = imessageConnector(store, async () => ({ send: async (t) => (sent.push(t), "m1"), closed: new Promise(() => {}), stop: async () => {} }));
    expect([c.enabled(), c.configured(), c.mark, c.images ?? false]).toEqual([true, true, FROM_IMESSAGE, false]);
    expect(JSON.stringify(c.forms())).not.toContain("imessage-secret-123");
    expect(c.forms().map((f) => [f.key, f.status])).toEqual([["phone", "••••1234"], ["project", "Set"]]);
    const link = await c.open(() => {}, () => {});
    expect(await link.send({ text: "hi", images: ["/x.png"] })).toBe("m1");
    expect(sent).toEqual(["hi"]);
    // Off: still set, just off.
    c.update({ enabled: false });
    expect([c.enabled(), c.configured()]).toEqual([false, true]);
    c.update({ values: { phone: "" } });
    expect(c.configured()).toBe(false);
  });
});
