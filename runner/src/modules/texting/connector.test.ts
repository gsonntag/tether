import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FROM_DISCORD, FROM_IMESSAGE, TEXTED_MARKS, fromTexted, tetherOrigin, titleText } from "../../../../shared/fromTether";
import type { Attachment } from "../../../../shared/attachments";
import { FILES_ONLY, Texter } from ".";
import { Channel, FatalError, type ChannelLink, type Connector, type Inbound, type Outbound } from "./connector";
import { connectors } from "./connectors";
import { imessageConnector } from "./imessage";
import { HomeLine, type TakeVia } from "../homeLine";
import { TextingStore } from "./store";
import { casualText, TEXTS } from "./texts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A connector whose link the test holds: what it sent, and a way to be the person. */
function fake(id: string, mark: string) {
  const state = { enabled: true, configured: true, sent: [] as Outbound[], opens: 0, fail: undefined as string | undefined, hear: (_m: Inbound) => {}, links: [] as (ChannelLink & { end: () => void })[] };
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
      const link = { send: async (o: Outbound) => (state.sent.push(o), `${id}-${++n}`), closed, stop: async () => end(), end };
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
  /** the Home agent's Texts chat, and whether it's busy (a turn running or messages waiting) */
  const home = { busy: false };
  if (o.home) line.home = { take: async (text, via) => void took.push([text, via]), isTextsChat: (id) => id === "claude:texts", textsBusy: () => home.busy };
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
  // As the texting module wires it.
  line.phone = { send: (text, o) => t.homeText(text, { reply: true, answer: !!o?.answer }), text: (from, body) => t.personText(from, body) };
  /** the session's state as the runner sees it (idle unless set) */
  const look = (id: string) => sessions[id];
  return { t, im: im.state, dc: dc.state, told, took, store, line, home, look };
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

describe("review fixes", () => {
  test("answers go back the way the person wrote; Send to only steers Tether's own texts", async () => {
    const s = setup({ home: true });
    await s.t.start();
    s.t.prefer("imessage");
    // A request text: Tether's own, to the preferred one.
    await s.t.attention("claude:a");
    expect(s.im.sent.length).toBe(1);
    // They answer it on Discord; the session's answer comes back on Discord.
    s.dc.hear({ text: "1 why?" });
    await tick();
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", { id: "x", role: "assistant", ts: 1, parts: [{ type: "text", text: "Because the tests." }] });
    await s.t.turnEnded("claude:a");
    expect(s.dc.sent.at(-1)!.text).toBe("[1] Because the tests.");
    expect(s.im.sent.length).toBe(1);
    // Its next request is Tether's own again: the preferred one.
    await s.t.attention("claude:a");
    expect(s.im.sent.length).toBe(2);
    // The Home agent: its reply goes back on Discord, its own text_person on the preferred one.
    s.dc.hear({ text: "home: what's up" });
    await tick();
    expect(await s.line.phone!.send("not much")).toBe(true);
    expect(s.dc.sent.at(-1)!.text).toBe("[home] not much");
    expect((await s.line.phone!.text("home", "PR merged")).isError).toBeUndefined();
    expect(s.im.sent.at(-1)!.text).toBe("[home] PR merged");
  });

  test("files never drop silently: held with the picker's text, a number with just files, with an answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "texting-held-"));
    try {
      const s = setup({ attachmentsDir: dir });
      const sessions = (s.t as any).ctx.session;
      await s.t.start();
      const png = (name = "a.png") => ({ name, mimeType: "image/png", size: 1, read: async () => new Uint8Array([7]) });
      // Nothing open, no Home agent: the reply says nothing's waiting, and that the file didn't go.
      s.dc.hear({ text: "look", files: [png()] });
      await tick(5);
      expect(s.dc.sent.map((o) => o.text)).toEqual([TEXTS.nothingOpen, TEXTS.filesNotSent]);
      // Two open: held for the picker with its file, then delivered with it.
      await s.t.attention("claude:a");
      (s.t as any).ctx.session = (id: string) => sessions(id) ?? { summary: { id, projectPath: "/p" }, status: "idle", requests: [], state: { requests: [] } };
      await s.t.attention("codex:b");
      s.dc.hear({ text: "see this", files: [png("held.png")] });
      await tick(5);
      expect(s.dc.sent.at(-1)!.text).toStartWith(TEXTS.which);
      expect(s.dc.sent.at(-1)!.text).not.toContain(TEXTS.filesNotSent);
      s.dc.hear({ text: "2" });
      await tick(5);
      expect(s.told.at(-1)![0]).toBe("codex:b");
      expect(s.told.at(-1)![1]).toBe("see this");
      expect(s.told.at(-1)![2]!.map((f) => f.name)).toEqual(["held.png"]);
      // A number and only a file: the file goes there.
      s.dc.hear({ text: "1", files: [png("only.png")] });
      await tick(5);
      expect(s.told.at(-1)![0]).toBe("claude:a");
      expect(s.told.at(-1)![1]).toBe(FILES_ONLY);
      expect(s.told.at(-1)![2]!.map((f) => f.name)).toEqual(["only.png"]);
      // A file with an answer to a request: the request is answered, the person told the file wasn't passed on.
      const r = { id: "r1", sessionId: "claude:a", kind: "approval", tool: "Bash", toolKind: "shell", command: "ls", openedAt: 1 } as any;
      const look = (s.t as any).ctx.session("claude:a");
      look.requests = ["r1"];
      look.state.requests = [r];
      s.dc.hear({ text: "1 y", files: [png()] });
      await tick(5);
      expect(s.dc.sent.at(-1)!.text).toBe(TEXTS.filesWithAnswer(1));
      // A name that isn't safe is cleaned in the reply.
      look.requests = [];
      s.dc.hear({ text: "1 x", files: [{ ...png("../../etc/evil name.png"), size: 99 * 1024 * 1024 }] });
      await tick(5);
      expect(s.dc.sent.some((o) => o.text === TEXTS.fileSkipped("evil_name.png"))).toBe(true);
      for (const t of [TEXTS.filesNotSent, TEXTS.filesWithAnswer(2), TEXTS.fileSkipped("a.png")]) expect(casualText(t)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fatal connect error isn't retried; restart clears it", async () => {
    const f = fake("x", "[From X] ");
    let calls = 0;
    const ch = new Channel({ ...f.c, open: async () => (calls++, Promise.reject(new FatalError("bad token"))) }, () => {}, () => {});
    await ch.start();
    expect(ch.lastError).toBe("Couldn't connect to x: bad token");
    expect((ch as any).retry).toBeUndefined();
    await ch.restart();
    expect(calls).toBe(2);
    await ch.stop();
  });
});

test("a session's link in a Discord text is its short link, as on iMessage", async () => {
  const s = setup();
  (s.t as any).ctx.links = { url: (app: string, id: string) => `${app}#/l/${id === "claude:a" ? "abc123" : "x"}` };
  await s.t.start();
  s.dc.hear({ text: "hi" });
  await tick();
  s.store.lastVia = "discord";
  await s.t.attention("claude:a");
  expect(s.dc.sent.at(-1)!.text).toEndWith("\nhttps://tether.example/#/l/abc123");
});

describe("second review round", () => {
  const png = (name = "a.png") => ({ name, mimeType: "image/png", size: 1, read: async () => new Uint8Array([7]) });
  /** Two sessions open, so plain text gets the picker. */
  async function twoOpen(o: { attachmentsDir?: string } = {}) {
    const s = setup(o);
    const sessions = (s.t as any).ctx.session;
    (s.t as any).ctx.session = (id: string) => sessions(id) ?? { summary: { id, projectPath: "/p" }, status: "idle", requests: [], state: { requests: [] } };
    await s.t.start();
    await s.t.attention("claude:a");
    await s.t.attention("codex:b");
    return s;
  }

  test("N7: held files that don't go are reported: picked with other words, replaced, expired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "texting-held2-"));
    try {
      const s = await twoOpen({ attachmentsDir: dir });
      const notSent = () => s.dc.sent.filter((o) => o.text === TEXTS.filesNotSent).length;
      // Held, then "2 other words": those words go, the held file doesn't, and they're told.
      s.dc.hear({ text: "look", files: [png()] });
      await tick(5);
      s.dc.hear({ text: "2 other words" });
      await tick(5);
      expect(s.told.at(-1)).toEqual(["codex:b", "other words"]);
      expect(notSent()).toBe(1);
      // Held, then a new unclear text replaces it.
      await s.t.attention("codex:b");
      s.dc.hear({ text: "look again", files: [png()] });
      await tick(5);
      s.dc.hear({ text: "something else" });
      await tick(5);
      expect(notSent()).toBe(2);
      // Held, then it expires.
      s.dc.hear({ text: "and this", files: [png()] });
      await tick(5);
      (s.t as any).now = () => Date.now() + 11 * 60_000;
      await s.t.checkHeld();
      expect(notSent()).toBe(3);
      // Not twice.
      await s.t.checkHeld();
      expect(notSent()).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N8: someone typing \"(sent a file)\" is just words; a file alone is flagged, not matched by text", async () => {
    const s = setup();
    const sessions = (s.t as any).ctx.session;
    await s.t.start();
    await s.t.attention("claude:a");
    const look = sessions("claude:a");
    look.requests = ["r1"];
    look.state.requests = [{ id: "r1", sessionId: "claude:a", kind: "approval", tool: "Bash", toolKind: "shell", command: "ls", openedAt: 1 }];
    const answered: any[] = [];
    (s.t as any).ctx.sessions.answer = async (...a: any[]) => void answered.push(a);
    s.dc.hear({ text: FILES_ONLY });
    await tick(5);
    // Words to a request: the agent reads them as the reason.
    expect(answered).toEqual([["claude:a", "r1", { allow: false, reason: FILES_ONLY }]]);
    expect(s.told).toEqual([]);
    // A NUL can't smuggle the flag in either.
    s.dc.hear({ text: "\u0000" });
    await tick(5);
    expect(s.told).toEqual([]);
  });

  test("N9: files with a reply to an already-answered request: told they didn't go", async () => {
    const dir = mkdtempSync(join(tmpdir(), "texting-n9-"));
    try {
      const s = setup({ attachmentsDir: dir });
      await s.t.start();
      const look = (s.t as any).ctx.session("claude:a");
      look.requests = ["r1"];
      look.state.requests = [{ id: "r1", sessionId: "claude:a", kind: "approval", tool: "Bash", toolKind: "shell", command: "ls", openedAt: 1 }];
      await s.t.request(look.state.requests[0]);
      look.requests = [];
      s.dc.hear({ text: "y", files: [png()], replyTo: s.t.router.state.sent.at(-1)!.id });
      await tick(5);
      expect(s.dc.sent.slice(-2).map((o) => o.text)).toEqual([TEXTS.alreadyAnswered(1), TEXTS.filesNotSent]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N11: every connector's app is in the shared registry, with its marker and label", async () => {
    const { MESSAGING_APPS, TEXTED_MARKS, TEXTED_VIA } = await import("../../../../shared/fromTether");
    for (const c of connectors(new TextingStore(undefined, {}))) {
      expect(Object.keys(MESSAGING_APPS)).toContain(c.id);
      expect(c.mark).toBe(TEXTED_MARKS[c.id as keyof typeof TEXTED_MARKS]);
      expect(TEXTED_VIA[c.id as keyof typeof TEXTED_VIA]).toBe(c.label);
    }
  });

  test("N3/N12: answers carry their place; the way back is saved; Send to skips a connector that's off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "texting-n12-"));
    try {
      const file = join(dir, "texting.json");
      const s = setup();
      (s.t.store as any).file = file;
      await s.t.start();
      await s.t.attention("claude:a");
      s.dc.hear({ text: "1 go", place: "chan-9", shared: true });
      await tick();
      s.t.turnStarted("claude:a");
      // A shared place is never saved: only the connector (a DM's place would be).
      expect(JSON.parse(readFileSync(file, "utf8")).replyVia["claude:a"]).toEqual({ via: "discord" });
      s.dc.hear({ text: "1 and you", place: "dm-1" });
      await tick();
      expect(new TextingStore(file, {}).replyVia["claude:a"]).toEqual({ via: "discord", place: "dm-1" });
      s.dc.hear({ text: "1 go", place: "chan-9", shared: true });
      await tick();
      s.t.said("claude:a", { id: "u-go", role: "user", ts: 1, parts: [{ type: "text", text: "go" }] });
      s.t.turnStarted("claude:a");
      s.t.said("claude:a", { id: "x", role: "assistant", ts: 1, parts: [{ type: "text", text: "Done that." }] });
      await s.t.turnEnded("claude:a");
      expect(s.dc.sent.at(-1)).toEqual({ text: "[1] Done that.", place: "chan-9", shared: true });
      // Tether's own texts carry no place.
      await s.t.attention("claude:a");
      expect(s.dc.sent.at(-1)!.place).toBeUndefined();
      // The DM it was last written from stays the private way back.
      expect(JSON.parse(readFileSync(file, "utf8")).replyVia["claude:a"]).toEqual({ via: "discord", place: "dm-1" });
      // A preference for a connector that's off: refused, and an old one is skipped.
      s.t.prefer("imessage");
      s.im.enabled = false;
      expect(() => s.t.prefer("imessage")).toThrow("Turn it on first");
      await s.t.attention("claude:a");
      expect(s.im.sent.length).toBe(1);
      expect(s.t.prefer(null).prefer).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("N12/round 3: a settings change waits for the old link to close, but not long", async () => {
    const f = fake("x", "[From X] ");
    (f.c as { stopWaitMs?: number }).stopWaitMs = 50;
    const ch = new Channel(f.c, () => {}, () => {});
    await ch.start();
    // A link that closes: the new one opens only after it has.
    const order: string[] = [];
    const first = f.state.links.at(-1)!;
    first.stop = async () => {
      await tick(10);
      order.push("old closed");
    };
    const open = f.c.open;
    f.c.open = async (...a) => (order.push("new opened"), open(...a));
    await ch.restart();
    expect(order).toEqual(["old closed", "new opened"]);
    // A link that never closes: the settings change still goes through, after the wait.
    f.state.links.at(-1)!.stop = () => new Promise(() => {});
    const at = Date.now();
    const done = await Promise.race([ch.restart().then(() => "restarted"), tick(1000).then(() => "stuck")]);
    expect(done).toBe("restarted");
    expect(Date.now() - at).toBeGreaterThanOrEqual(45);
    expect(ch.connected).toBe(true);
  });
});

describe("round 3", () => {
  test("a channel message: the direct answer goes to the channel; a later report or request goes to the DM", async () => {
    const s = setup({ home: true });
    await s.t.start();
    // Home: they write in the channel while it's idle; the turn it starts.
    s.dc.hear({ text: "home: hi", place: "chan-1", shared: true });
    await tick();
    s.t.said("claude:texts", { id: "u-hi", role: "user", ts: 1, parts: [{ type: "text", text: "[From Discord] hi" }] });
    s.t.turnStarted("claude:texts");
    // A report's outcome: private.
    expect(await s.line.phone!.send("done: PR #3")).toBe(true);
    expect(s.dc.sent.at(-1)).toEqual({ text: "[home] done: PR #3" });
    // The direct answer to their text: the channel, once.
    expect(await s.line.phone!.send("ok, on it", { answer: true })).toBe(true);
    expect(s.dc.sent.at(-1)).toEqual({ text: "[home] ok, on it", place: "chan-1", shared: true });
    expect(await s.line.phone!.send("one more", { answer: true })).toBe(true);
    expect(s.dc.sent.at(-1)).toEqual({ text: "[home] one more" });
    // Sessions: a failure to the DM; the answer of the turn a channel message started there; after it, the DM.
    await s.t.attention("claude:a");
    s.dc.hear({ text: "1 why", place: "chan-1", shared: true });
    await tick();
    s.t.turnStarted("claude:a");
    await s.t.turnEnded("claude:a", "boom");
    expect(s.dc.sent.at(-1)!.place).toBeUndefined();
    s.dc.hear({ text: "1 try again", place: "chan-1", shared: true });
    await tick();
    s.t.turnStarted("claude:a");
    // The message shows after its turn started: the claim is that turn's from then.
    s.t.said("claude:a", { id: "u-again", role: "user", ts: 1, parts: [{ type: "text", text: "try again" }] });
    s.t.said("claude:a", { id: "x", role: "assistant", ts: 1, parts: [{ type: "text", text: "Retried." }] });
    await s.t.turnEnded("claude:a");
    expect(s.dc.sent.at(-1)).toEqual({ text: "[1] Retried.", place: "chan-1", shared: true });
    await s.t.attention("claude:a");
    expect(s.dc.sent.at(-1)!.place).toBeUndefined();
    expect((await s.line.phone!.text("claude:a", "PR up")).isError).toBeUndefined();
    expect(s.dc.sent.at(-1)!.place).toBeUndefined();
  });

  test("a files-only hold from before a restart isn't delivered as words", async () => {
    const s = setup();
    s.store.router.held = { text: "\u0000", at: Date.now() };
    const t2 = new Texter((s.t as any).ctx, s.store, undefined, Date.now, { list: [] });
    expect(t2.router.state.held).toBeUndefined();
    // And if one survives in the router anyway, picking it says the file didn't go.
    await s.t.start();
    await s.t.attention("claude:a");
    const sessions = (s.t as any).ctx.session;
    (s.t as any).ctx.session = (id: string) => sessions(id) ?? { summary: { id, projectPath: "/p" }, status: "idle", requests: [], state: { requests: [] } };
    await s.t.attention("codex:b");
    s.t.router.state.held = { text: "\u0000", at: Date.now() };
    s.dc.hear({ text: "2" });
    await tick();
    expect(s.told).toEqual([]);
    expect(s.dc.sent.at(-1)!.text).toBe(TEXTS.filesNotSent);
  });

  test("the store keeps keys it doesn't know", () => {
    const dir = mkdtempSync(join(tmpdir(), "texting-keys-"));
    try {
      const file = join(dir, "texting.json");
      writeFileSync(file, JSON.stringify({ settings: { phone: "+13105551234" }, router: { slots: [], sent: [] }, future: { x: 1 }, older: [2] }));
      const st = new TextingStore(file, {});
      st.prefer = "discord";
      st.save();
      const v = JSON.parse(readFileSync(file, "utf8"));
      expect([v.future, v.older, v.prefer, v.settings.phone]).toEqual([{ x: 1 }, [2], "discord", "+13105551234"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round 4: only the turn a channel message started answers in the channel", () => {
  const user = (text: string) => ({ id: "u", role: "user" as const, ts: 1, parts: [{ type: "text" as const, text }] });
  const agent = (text: string) => ({ id: "a", role: "assistant" as const, ts: 1, parts: [{ type: "text" as const, text }] });

  test("(a) a DM in flight, then a channel message: the DM's answer goes to the DM", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    s.dc.hear({ text: "1 summarize the doc", place: "dm-1" });
    await tick();
    s.t.turnStarted("claude:a");
    s.look("claude:a").status = "running";
    // Mid-turn, a channel message: queued behind the DM's turn, so it claims nothing.
    s.dc.hear({ text: "1 hi", place: "chan-1", shared: true });
    await tick();
    s.t.said("claude:a", agent("Here's the summary."));
    s.look("claude:a").status = "idle";
    await s.t.turnEnded("claude:a");
    expect(s.dc.sent.at(-1)).toEqual({ text: "[1] Here's the summary.", place: "dm-1" });
    // Its own turn (queued) starts after: it isn't the channel's either.
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", agent("Hi."));
    await s.t.turnEnded("claude:a");
    for (const o of s.dc.sent) expect(o.shared).toBeUndefined();
  });

  test("(b) a channel message while the session is idle: its answer goes to the channel", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    s.dc.hear({ text: "1 status?", place: "chan-1", shared: true });
    await tick();
    // The runner shows the message (defanged): it's the channel's own.
    s.t.said("claude:a", user("\u200bstatus?"));
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", agent("All green."));
    await s.t.turnEnded("claude:a");
    expect(s.dc.sent.at(-1)).toEqual({ text: "[1] All green.", place: "chan-1", shared: true });
  });

  test("(c) a web-started turn while a channel claim exists goes to the DM", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    s.dc.hear({ text: "1 status?", place: "chan-1", shared: true });
    await tick();
    // Its turn ran and ended without a text (someone was looking); then a turn from the web.
    s.t.turnStarted("claude:a");
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", agent("Done, want more?"));
    await s.t.turnEnded("claude:a");
    expect(s.dc.sent.at(-1)!.shared).toBeUndefined();
    // Typed in Tether into the channel's own turn: in doubt, the DM.
    s.dc.hear({ text: "1 status?", place: "chan-1", shared: true });
    await tick();
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", user("also check the logs"));
    s.t.said("claude:a", agent("Logs look fine?"));
    await s.t.turnEnded("claude:a");
    expect(s.dc.sent.at(-1)!.shared).toBeUndefined();
  });

  test("(d) Home: busy or interrupted, the channel gets nothing; idle and uninterrupted, the answer", async () => {
    const s = setup({ home: true });
    await s.t.start();
    // A DM to Home in flight, then a channel message: the DM turn's answer goes to the DM.
    s.dc.hear({ text: "home: summarize the doc", place: "dm-1" });
    await tick();
    s.t.turnStarted("claude:texts");
    s.home.busy = true;
    s.dc.hear({ text: "home: hi", place: "chan-1", shared: true });
    await tick();
    expect(await s.line.phone!.send("summary: …", { answer: true })).toBe(true);
    expect(s.dc.sent.at(-1)!.shared).toBeUndefined();
    // Idle: the channel message's turn answers in the channel.
    s.home.busy = false;
    s.dc.hear({ text: "home: hi", place: "chan-1", shared: true });
    await tick();
    s.t.said("claude:texts", user("[From Discord] hi"));
    s.t.turnStarted("claude:texts");
    expect(await s.line.phone!.send("hey", { answer: true })).toBe(true);
    expect(s.dc.sent.at(-1)).toEqual({ text: "[home] hey", place: "chan-1", shared: true });
    // A web-started (or report) turn after a channel message's turn: the DM.
    s.dc.hear({ text: "home: and?", place: "chan-1", shared: true });
    await tick();
    s.t.turnStarted("claude:texts");
    s.t.said("claude:texts", user("[From Tether] a report"));
    expect(await s.line.phone!.send("noted", { answer: true })).toBe(true);
    expect(s.dc.sent.at(-1)!.shared).toBeUndefined();
  });

  test("a request answered from the channel claims nothing; a held text picked elsewhere neither; dropped-file notices go privately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "texting-r4-"));
    try {
      const s = setup({ attachmentsDir: dir });
      await s.t.start();
      const look = s.look("claude:a");
      look.requests = ["r1"];
      look.state.requests = [{ id: "r1", sessionId: "claude:a", kind: "approval", tool: "Bash", toolKind: "shell", command: "ls", openedAt: 1 }];
      await s.t.request(look.state.requests[0]);
      s.dc.hear({ text: "1 y", place: "chan-1", shared: true });
      await tick();
      look.requests = [];
      look.state.requests = [];
      s.t.turnStarted("claude:a");
      s.t.said("claude:a", agent("Ran it."));
      await s.t.turnEnded("claude:a");
      expect(s.dc.sent.at(-1)!.shared).toBeUndefined();
      // Two open; a text held from the DM, picked from the channel: no channel answer.
      const sessions = (s.t as any).ctx.session;
      (s.t as any).ctx.session = (id: string) => sessions(id) ?? { summary: { id, projectPath: "/p" }, status: "idle", requests: [], state: { requests: [] } };
      await s.t.attention("codex:b");
      s.dc.hear({ text: "deploy it", place: "dm-1" });
      await tick();
      s.dc.hear({ text: "1", place: "chan-1", shared: true });
      await tick();
      expect(s.told.at(-1)).toEqual(["claude:a", "deploy it"]);
      s.t.turnStarted("claude:a");
      s.t.said("claude:a", agent("Deployed."));
      await s.t.turnEnded("claude:a");
      expect(s.dc.sent.at(-1)!.shared).toBeUndefined();
      // Held files from the channel that go nowhere: the notice goes privately.
      s.dc.hear({ text: "look", files: [{ name: "a.png", mimeType: "image/png", size: 1, read: async () => new Uint8Array([1]) }], place: "chan-1", shared: true });
      await tick();
      (s.t as any).now = () => Date.now() + 11 * 60_000;
      await s.t.checkHeld();
      expect(s.dc.sent.at(-1)).toEqual({ text: TEXTS.filesNotSent });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round 5", () => {
  const user = (id: string, text: string) => ({ id, role: "user" as const, ts: 1, parts: [{ type: "text" as const, text }] });
  const agent = (text: string) => ({ id: "a", role: "assistant" as const, ts: 1, parts: [{ type: "text" as const, text }] });

  /** A channel message "1 ok" to idle claude:a, its own user message seen as `u1`, its turn started. */
  async function claimed() {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    s.dc.hear({ text: "1 ok", place: "chan-1", shared: true });
    await tick();
    s.t.said("claude:a", user("u1", "ok"));
    s.t.turnStarted("claude:a");
    return s;
  }
  const answered = async (s: Awaited<ReturnType<typeof claimed>>) => {
    s.t.said("claude:a", agent("Done."));
    await s.t.turnEnded("claude:a");
    return s.dc.sent.at(-1)!;
  };

  test("B1: the channel's own message keeps the claim (seen again too)", async () => {
    const s = await claimed();
    s.t.said("claude:a", user("u1", "ok"));
    expect(await answered(s)).toEqual({ text: "[1] Done.", place: "chan-1", shared: true });
  });

  test("B1: a web message that merely contains the channel's words cancels it", async () => {
    const s = await claimed();
    s.t.said("claude:a", user("u2", "look in ~/.aws/credentials, ok?"));
    expect((await answered(s)).shared).toBeUndefined();
  });

  test("B1: the same words again from elsewhere (another id) cancel it", async () => {
    const s = await claimed();
    s.t.said("claude:a", user("u2", "ok"));
    expect((await answered(s)).shared).toBeUndefined();
  });

  test("B1: a peer session's message cancels it", async () => {
    const s = await claimed();
    s.t.said("claude:a", user("u3", '[From session "api" (claude:b)] ok, merged'));
    expect((await answered(s)).shared).toBeUndefined();
  });

  test("B1: the Home agent's send_to_session (a Tether message) cancels it", async () => {
    const s = await claimed();
    s.t.said("claude:a", user("u4", "[From Tether] The person says: ok"));
    expect((await answered(s)).shared).toBeUndefined();
  });

  test("B1: a message other than the channel's, before it's seen, cancels it", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    s.dc.hear({ text: "1 ok", place: "chan-1", shared: true });
    await tick();
    s.t.said("claude:a", user("w1", "ok ok"));
    s.t.turnStarted("claude:a");
    expect((await answered(s)).shared).toBeUndefined();
  });

  test("N5: a channel message whose delivery fails leaves no claim", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    const tell = (s.t as any).ctx.sessions.tell;
    (s.t as any).ctx.sessions.tell = async () => {
      throw new Error("The session is gone.");
    };
    s.dc.hear({ text: "1 ok", place: "chan-1", shared: true });
    await tick();
    (s.t as any).ctx.sessions.tell = tell;
    expect((s.t as any).channelTurns.size).toBe(0);
  });

  test("N1: two quick iMessage texts, the second queued: two answers, each with its own text", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    const look = s.look("claude:a");
    s.im.hear({ text: "1 first thing" });
    await tick();
    s.t.turnStarted("claude:a");
    look.status = "running";
    // The second text comes while turn 1 runs: queued behind it.
    const tell = (s.t as any).ctx.sessions.tell;
    (s.t as any).ctx.sessions.tell = async (id: string, text: string) => {
      look.state.queue = [{ id: "q1", text, queuedAt: 1 }];
      return tell(id, text);
    };
    s.im.hear({ text: "1 second thing" });
    await tick();
    expect(s.told.map((x) => x[1])).toEqual(["first thing", "second thing"]);
    s.t.said("claude:a", agent("Answer one."));
    // Turn 1 ends (its text goes out FINISH_DELAY_MS later); turn 2 starts at once from the queue.
    look.status = "idle";
    const end1 = s.t.endOf("claude:a");
    look.state.queue = [];
    look.status = "running";
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", agent("Working on the second…"));
    await s.t.turnEnded("claude:a", undefined, end1);
    expect(s.im.sent.at(-1)!.text).toBe("[1] Answer one.");
    // Turn 2 ends: its own answer, once.
    s.t.said("claude:a", agent("Answer two."));
    look.status = "idle";
    const end2 = s.t.endOf("claude:a");
    await s.t.turnEnded("claude:a", undefined, end2);
    expect(s.im.sent.slice(-2).map((o) => o.text)).toEqual(["[1] Answer one.", "[1] Answer two."]);
    // Nothing more waits: a later turn of its own isn't texted.
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", agent("Unprompted note."));
    await s.t.turnEnded("claude:a");
    expect(s.im.sent.at(-1)!.text).toBe("[1] Answer two.");
  });

  test("N1: turn 1's delayed end doesn't take turn 2's channel claim", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    s.dc.hear({ text: "1 first", place: "dm-1" });
    await tick();
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", agent("First done."));
    const end1 = s.t.endOf("claude:a");
    // Idle now: a channel message starts turn 2 before turn 1's text goes.
    s.dc.hear({ text: "1 second", place: "chan-1", shared: true });
    await tick();
    s.t.said("claude:a", user("c1", "second"));
    s.t.turnStarted("claude:a");
    await s.t.turnEnded("claude:a", undefined, end1);
    expect(s.dc.sent.at(-1)).toEqual({ text: "[1] First done.", place: "dm-1" });
    s.t.said("claude:a", agent("Second done."));
    await s.t.turnEnded("claude:a");
    expect(s.dc.sent.at(-1)).toEqual({ text: "[1] Second done.", place: "chan-1", shared: true });
  });

  test("a failed test send leaves no error on the connector's status", async () => {
    const s = setup();
    await s.t.start();
    const link = s.dc.links.at(-1)!;
    link.send = async () => {
      throw new Error("Missing Access");
    };
    await expect(s.t.test("discord")).rejects.toThrow("Missing Access");
    expect(s.t.channel("discord")!.lastError).toBeUndefined();
  });
});

describe("round 6", () => {
  const user = (id: string, text: string) => ({ id, role: "user" as const, ts: 1, parts: [{ type: "text" as const, text }] });
  const agent = (text: string) => ({ id: "a", role: "assistant" as const, ts: 1, parts: [{ type: "text" as const, text }] });

  test("1: a turn the session moved on from texts only what's owed: never a question alone; a failure yes", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    const n = s.dc.sent.length + s.im.sent.length;
    // A turn nobody texted, ending on a question; the next (queued from the web) starts before its end goes.
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", agent("Should I also do the docs?"));
    const end1 = s.t.endOf("claude:a");
    s.t.turnStarted("claude:a");
    await s.t.turnEnded("claude:a", undefined, end1);
    expect(s.dc.sent.length + s.im.sent.length).toBe(n);
    // A failure is still told.
    const end2 = s.t.endOf("claude:a");
    s.t.turnStarted("claude:a");
    await s.t.turnEnded("claude:a", "overloaded 529", end2);
    expect(s.im.sent.at(-1)!.text).toStartWith("[1] Claude stopped");
  });

  test("2: a steer or a request answer doesn't pile up: after \"do it\" and a \"y\", a held queue, the next web turn isn't texted", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    const look = s.look("claude:a");
    s.im.hear({ text: "1 do it" });
    await tick();
    s.t.turnStarted("claude:a");
    look.status = "running";
    // A request in the same turn, answered "y" by text.
    look.requests = ["r1"];
    look.state.requests = [{ id: "r1", sessionId: "claude:a", kind: "approval", tool: "Bash", toolKind: "shell", command: "ls", openedAt: 1 }];
    s.im.hear({ text: "1 y" });
    await tick();
    look.requests = [];
    look.state.requests = [];
    s.t.said("claude:a", agent("Did it."));
    // The turn ends; the queue is held (a stop), with a web message in it.
    look.status = "idle";
    look.state.queue = [{ id: "q", text: "later", queuedAt: 1 }];
    look.state.queueHeld = true;
    await s.t.turnEnded("claude:a");
    expect(s.im.sent.at(-1)!.text).toBe("[1] Did it.");
    // Released later, from the web: its turn isn't an answer to anything they texted.
    look.state.queue = [];
    look.state.queueHeld = false;
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", agent("Did the later thing."));
    await s.t.turnEnded("claude:a");
    expect(s.im.sent.at(-1)!.text).toBe("[1] Did it.");
  });

  test("3: Tether's own replies to a channel message go to the DM", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    s.dc.hear({ text: "1 from dm", place: "dm-1" });
    await tick();
    // A number nothing has: the picker, privately.
    s.dc.hear({ text: "7 hi", place: "chan-1", shared: true });
    await tick();
    expect(s.dc.sent.at(-1)!.text).toContain("[7] isn't waiting");
    expect(s.dc.sent.at(-1)!.shared).toBeUndefined();
    expect(s.dc.sent.at(-1)!.place).not.toBe("chan-1");
    // A closed request's reply: privately, to the session's DM.
    const look = s.look("claude:a");
    look.requests = ["r1"];
    look.state.requests = [{ id: "r1", sessionId: "claude:a", kind: "approval", tool: "Bash", toolKind: "shell", command: "ls", openedAt: 1 }];
    await s.t.request(look.state.requests[0]);
    look.requests = [];
    s.dc.hear({ text: "y", replyTo: s.t.router.state.sent.at(-1)!.id, place: "chan-1", shared: true });
    await tick();
    expect(s.dc.sent.at(-1)).toEqual({ text: TEXTS.alreadyAnswered(1), place: "dm-1" });
    // A failed delivery: privately too.
    (s.t as any).ctx.sessions.tell = async () => {
      throw new Error("gone");
    };
    s.dc.hear({ text: "1 hey", place: "chan-1", shared: true });
    await tick();
    expect(s.dc.sent.at(-1)).toEqual({ text: TEXTS.couldNotSend("[1]", "gone"), place: "dm-1" });
  });

  test("4: no claim on a session in terminal mode, with its queue held, or waiting out a restart; and none until its message is seen", async () => {
    for (const st of [{ mode: "terminal" }, { queueHeld: true }, { restartWait: true }]) {
      const s = setup();
      await s.t.start();
      await s.t.attention("claude:a");
      Object.assign(s.look("claude:a").state, st);
      s.dc.hear({ text: "1 go", place: "chan-1", shared: true });
      await tick();
      s.t.said("claude:a", user("u", "go"));
      s.t.turnStarted("claude:a");
      s.t.said("claude:a", agent("Went."));
      await s.t.turnEnded("claude:a");
      expect([st, s.dc.sent.at(-1)!.shared]).toEqual([st, undefined]);
    }
    // Its turn started, its message never seen: no claim.
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    s.dc.hear({ text: "1 go", place: "chan-1", shared: true });
    await tick();
    s.t.turnStarted("claude:a");
    s.t.said("claude:a", agent("Went."));
    await s.t.turnEnded("claude:a");
    expect(s.dc.sent.at(-1)!.shared).toBeUndefined();
  });

  test("5: a permission answered mid-turn (waiting → running) keeps the channel's claim", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    s.dc.hear({ text: "1 deploy", place: "chan-1", shared: true });
    await tick();
    s.t.said("claude:a", user("u", "deploy"));
    s.t.turnStarted("claude:a", "idle");
    s.t.turnStarted("claude:a", "waiting");
    s.t.said("claude:a", agent("Deployed."));
    await s.t.turnEnded("claude:a");
    expect(s.dc.sent.at(-1)).toEqual({ text: "[1] Deployed.", place: "chan-1", shared: true });
  });

  test("6: a terminal session's late words still make its answer; the count goes once it's told", async () => {
    const s = setup();
    await s.t.start();
    await s.t.attention("claude:a");
    s.im.hear({ text: "1 check it" });
    await tick();
    s.t.turnStarted("claude:a");
    // The turn ends before the file watcher catches up.
    const end = s.t.endOf("claude:a");
    s.t.said("claude:a", agent("Checked: fine?"));
    await s.t.turnEnded("claude:a", undefined, end);
    expect(s.im.sent.at(-1)!.text).toBe("[1] Checked: fine?");
    expect((s.t as any).turns.has("claude:a")).toBe(false);
  });
});
