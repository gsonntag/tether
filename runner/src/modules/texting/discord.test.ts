import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../../credentials";
import { Channel, isFatal, type Inbound } from "./connector";
import { cleanSettings, discordConnector, personMessage, splitMessage, takeEnv, unmask } from "./discord";
import { download, Gateway, INTENTS, Rest, retryAfter, type Socket } from "./discordGateway";
import { TextingStore } from "./store";

const TOKEN = "MTAx.discord-bot-token.abcdefghijklmnop";
const ME = "111111111111111111";
const OTHER = "222222222222222222";
const BOT = "999999999999999999";
const CHAN = "333333333333333333";
const DM = "444444444444444444";

class FakeSocket implements Socket {
  sent: any[] = [];
  closedWith?: number;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason?: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
  }
  push(p: unknown) {
    this.onmessage?.({ data: JSON.stringify(p) });
  }
  /** Discord closes it */
  drop(code: number) {
    this.onclose?.({ code });
  }
  ops(op: number) {
    return this.sent.filter((p) => p.op === op);
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(2);
  }
}

function sockets() {
  const all: FakeSocket[] = [];
  return { all, open: (url: string) => (all.push(new FakeSocket(url)), all.at(-1)!), last: () => all.at(-1)! };
}

const ready = (s: FakeSocket, seq = 1) => s.push({ op: 0, t: "READY", s: seq, d: { session_id: "sess1", resume_gateway_url: "wss://resume.discord.gg", user: { id: BOT, username: "tether" } } });

/** A gateway connected and ready. */
async function connected(o: Partial<ConstructorParameters<typeof Gateway>[2]> = {}) {
  const socks = sockets();
  const events: [string, any][] = [];
  const g = new Gateway(TOKEN, (t, d) => events.push([t, d]), { socket: socks.open, reconnectMinMs: 5, reconnectMaxMs: 20, invalidMs: 5, identifyGapMs: 0, random: () => 1, ...o });
  const started = g.start();
  socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
  ready(socks.last());
  await started;
  return { g, socks, events };
}

describe("the gateway", () => {
  test("hello, then identify with the message intents; READY gives the bot's own id", async () => {
    const { g, socks, events } = await connected();
    const s = socks.last();
    expect(s.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    expect(s.ops(2)).toEqual([{ op: 2, d: { token: TOKEN, intents: INTENTS, properties: { os: process.platform, browser: "tether", device: "tether" } } }]);
    // GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
    expect(INTENTS).toBe(512 + 4096 + 32768);
    expect(g.self).toEqual({ id: BOT, username: "tether" });
    s.push({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "1" } });
    expect(events.map((e) => e[0])).toEqual(["READY", "MESSAGE_CREATE"]);
    g.stop();
    await g.closed;
    expect(s.closedWith).toBe(1000);
  });

  test("heartbeats with the last sequence; a missed ack resumes on a new connection", async () => {
    const socks = sockets();
    const g = new Gateway(TOKEN, () => {}, { socket: socks.open, reconnectMinMs: 5, random: () => 0 });
    const started = g.start();
    const s = socks.last();
    s.push({ op: 10, d: { heartbeat_interval: 30 } });
    ready(s, 7);
    await started;
    await until(() => s.ops(1).length >= 1);
    expect(s.ops(1)[0]).toEqual({ op: 1, d: 7 });
    s.push({ op: 11 });
    await until(() => s.ops(1).length >= 2);
    // No ack this time: a zombie. Closed and resumed.
    await until(() => socks.all.length === 2);
    expect(s.closedWith).toBe(4000);
    const r = socks.last();
    expect(r.url).toBe("wss://resume.discord.gg/?v=10&encoding=json");
    r.push({ op: 10, d: { heartbeat_interval: 10_000 } });
    expect(r.ops(6)).toEqual([{ op: 6, d: { token: TOKEN, session_id: "sess1", seq: 7 } }]);
    expect(r.ops(2)).toEqual([]);
    g.stop();
  });

  test("Discord asks for a heartbeat: one now", async () => {
    const { g, socks } = await connected();
    socks.last().push({ op: 1 });
    expect(socks.last().ops(1)).toEqual([{ op: 1, d: 1 }]);
    g.stop();
  });

  test("a drop reconnects with backoff and resumes; a reconnect request resumes at once", async () => {
    const { g, socks } = await connected();
    socks.last().drop(1006);
    await until(() => socks.all.length === 2);
    socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    expect(socks.last().ops(6).length).toBe(1);
    socks.last().push({ op: 0, t: "RESUMED", s: 3, d: {} });
    socks.last().push({ op: 7 });
    expect(socks.all.length).toBe(3);
    socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    expect(socks.last().ops(6)[0].d.seq).toBe(3);
    g.stop();
  });

  test("an invalid session that can't resume identifies afresh; 4009 does too", async () => {
    const { g, socks } = await connected();
    socks.last().push({ op: 9, d: false });
    await until(() => socks.all.length === 2);
    socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    expect(socks.last().url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    expect(socks.last().ops(2).length).toBe(1);
    ready(socks.last());
    socks.last().drop(4009);
    await until(() => socks.all.length === 3);
    socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    expect(socks.last().ops(2).length).toBe(1);
    g.stop();
  });

  test("a bad token or refused intents end it for good, with why", async () => {
    const socks = sockets();
    const g = new Gateway(TOKEN, () => {}, { socket: socks.open, reconnectMinMs: 5 });
    const started = g.start();
    socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    socks.last().drop(4004);
    await expect(started).rejects.toThrow("turned down the bot token");
    await g.closed;
    await tick(20);
    expect(socks.all.length).toBe(1);

    const later = await connected();
    later.socks.last().drop(4014);
    await later.g.closed;
    expect(later.g.fatal).toContain("Message Content Intent");
    await tick(20);
    expect(later.socks.all.length).toBe(1);
  });

  test("no answer: the start fails", async () => {
    const socks = sockets();
    const g = new Gateway(TOKEN, () => {}, { socket: socks.open, readyMs: 10 });
    await expect(g.start()).rejects.toThrow("didn't answer");
  });
});

describe("who may drive it", () => {
  const who = { selfId: BOT, ownerIds: [ME], channelId: CHAN };
  const msg = (o: any = {}) => ({ id: "m1", type: 0, channel_id: DM, content: "2 yes", author: { id: ME }, attachments: [], ...o });

  test("the owner in a DM, or in the set channel", () => {
    expect(personMessage(msg(), who)).toEqual({ text: "2 yes", id: "m1", author: ME, channelId: DM, dm: true, attachments: [] });
    expect(personMessage(msg({ guild_id: "g", channel_id: CHAN }), who)?.channelId).toBe(CHAN);
    // A reply, and a mention of the bot in front.
    expect(personMessage(msg({ type: 19, content: `<@${BOT}> y`, message_reference: { message_id: "t1", channel_id: DM } }), who)).toEqual({ text: "y", id: "m1", author: ME, channelId: DM, dm: true, replyTo: "t1", attachments: [] });
    expect(personMessage(msg({ content: `<@!${BOT}>   home: hi` }), who)?.text).toBe("home: hi");
  });

  test("anyone else, bots, webhooks, the bot itself, other channels and system messages: nothing", () => {
    expect(personMessage(msg({ author: { id: OTHER } }), who)).toBeUndefined();
    expect(personMessage(msg({ author: { id: ME, bot: true } }), who)).toBeUndefined();
    expect(personMessage(msg({ author: { id: BOT } }), { ...who, ownerIds: [ME, BOT] })).toBeUndefined();
    expect(personMessage(msg({ webhook_id: "w" }), who)).toBeUndefined();
    expect(personMessage(msg({ guild_id: "g", channel_id: "555555555555555555" }), who)).toBeUndefined();
    expect(personMessage(msg({ guild_id: "g", channel_id: CHAN }), { ...who, channelId: undefined })).toBeUndefined();
    expect(personMessage(msg({ type: 7 }), who)).toBeUndefined();
    expect(personMessage(msg({ author: undefined }), who)).toBeUndefined();
  });
});

describe("splitting", () => {
  test("at 2000, at a line break or a space", () => {
    expect(splitMessage("short")).toEqual(["short"]);
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
    const parts = splitMessage(lines);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(2000);
    expect(parts.join("\n")).toBe(lines);
    const words = Array.from({ length: 900 }, () => "word").join(" ");
    expect(splitMessage(words).every((p) => p.length <= 2000 && !p.startsWith(" "))).toBe(true);
    expect(splitMessage(words).join(" ")).toBe(words);
    // No break anywhere: cut hard.
    expect(splitMessage("y".repeat(4500)).map((p) => p.length)).toEqual([2000, 2000, 500]);
  });
});

/** A Discord connector on a fake Discord: its REST calls, and the gateway's sockets. */
function fakeDiscord(env: Record<string, string> = {}, file?: string) {
  const calls: { method: string; url: string; body?: any; form?: FormData }[] = [];
  let n = 0;
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const form = init.body instanceof FormData ? init.body : undefined;
    calls.push({ method, url: String(url), ...(form ? { form } : init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (String(url).startsWith("https://cdn.discordapp.com/")) return new Response(new Uint8Array([1, 2, 3]));
    if (url.endsWith("/users/@me/channels")) return Response.json({ id: DM });
    if (url.endsWith("/messages")) return Response.json({ id: `out${++n}` });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const socks = sockets();
  const store = new TextingStore(file, env);
  const c = discordConnector(store, { fetch: fetcher, gateway: { socket: socks.open, reconnectMinMs: 5 } });
  return { c, store, calls, socks };
}

async function openIt(f: ReturnType<typeof fakeDiscord>) {
  const heard: Inbound[] = [];
  const opening = f.c.open((m) => heard.push(m), () => {});
  await until(() => f.socks.all.length > 0);
  f.socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
  ready(f.socks.last());
  const link = await opening;
  return { link, heard, gw: f.socks.last() };
}

describe("the Discord connector", () => {
  test("off and not set until configured; the token never shows, and is redacted", () => {
    const dir = mkdtempSync(join(tmpdir(), "discord-"));
    try {
      const file = join(dir, "texting.json");
      const { c } = fakeDiscord({}, file);
      expect([c.enabled(), c.configured()]).toEqual([false, false]);
      c.update({ enabled: true, values: { token: `Bot ${TOKEN}` } });
      expect(c.configured()).toBe(false);
      c.update({ values: { ownerIds: `${ME}, ${OTHER}`, channelId: CHAN } });
      expect([c.enabled(), c.configured()]).toEqual([true, true]);
      expect(JSON.stringify(c.forms())).not.toContain(TOKEN);
      expect(c.forms().find((f) => f.key === "token")?.status).toBe("Set");
      expect(c.forms().find((f) => f.key === "owners")?.status).toBe(`${ME}, ${OTHER}`);
      expect(redact(`token ${TOKEN}`)).toBe("token [redacted]");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const saved = JSON.parse(readFileSync(file, "utf8"));
      expect(saved.connectors.discord).toEqual({ enabled: true, token: TOKEN, ownerIds: [ME, OTHER], channelId: CHAN });
      // iMessage's settings are untouched, and a fresh load reads it back.
      expect(saved.settings).toEqual({});
      expect(fakeDiscord({}, file).c.configured()).toBe(true);
      // Bad values.
      expect(() => c.update({ values: { token: "not a token" } })).toThrow("doesn't look like a bot token");
      expect(() => c.update({ values: { ownerIds: "gavin" } })).toThrow("long number");
      expect(() => c.update({ values: { channelId: "#general" } })).toThrow("long number");
      // Cleared.
      c.update({ values: { channelId: "" } });
      expect(c.forms().find((f) => f.key === "channel")?.status).toBe("DMs only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runner.env wins and alone turns it on", () => {
    const { c } = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME });
    expect([c.enabled(), c.configured()]).toEqual([true, true]);
    const token = c.forms().find((f) => f.key === "token")!;
    expect([token.status, token.fromEnv, token.unset]).toEqual(["Set · from runner.env", true, false]);
    c.update({ enabled: false });
    expect(c.enabled()).toBe(false);
  });

  test("the owner's DM comes in, with its files; others don't; replies go back where they wrote", async () => {
    const f = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME });
    const { link, heard, gw } = await openIt(f);
    const create = (d: any) => gw.push({ op: 0, t: "MESSAGE_CREATE", s: 5, d: { type: 0, attachments: [], ...d } });
    create({ id: "a", channel_id: DM, content: "hi", author: { id: OTHER } });
    create({ id: "b", channel_id: DM, content: "hi", author: { id: BOT, bot: true } });
    create({ id: "c", guild_id: "g", channel_id: CHAN, content: "hi", author: { id: ME } });
    create({ id: "d", channel_id: DM, content: "look", author: { id: ME }, message_reference: { message_id: "out1", channel_id: DM }, attachments: [{ id: "f", filename: "shot.png", size: 3, content_type: "image/png", url: "https://cdn.discordapp.com/x/shot.png" }] });
    expect(heard.length).toBe(1);
    const m = heard[0]!;
    expect([m.text, m.id, m.replyTo]).toEqual(["look", "d", "out1"]);
    expect(m.files!.map((x) => [x.name, x.mimeType, x.size])).toEqual([["shot.png", "image/png", 3]]);
    expect([...(await m.files![0]!.read())]).toEqual([1, 2, 3]);
    await m.react!("✅");
    expect(f.calls.at(-1)).toMatchObject({ method: "PUT", url: `https://discord.com/api/v10/channels/${DM}/messages/d/reactions/${encodeURIComponent("✅")}/@me` });
    // Back to the DM they wrote in, split at 2000, mentions off.
    const ids = await link.send({ text: "z".repeat(2500) });
    expect(ids).toEqual(["out1", "out2"]);
    const posts = f.calls.filter((c) => c.method === "POST");
    expect(posts.map((p) => [p.url, p.body.content.length])).toEqual([[`https://discord.com/api/v10/channels/${DM}/messages`, 2000], [`https://discord.com/api/v10/channels/${DM}/messages`, 500]]);
    expect(posts[0]!.body.allowed_mentions).toEqual({ parse: [] });
    await link.stop();
    await link.closed;
  });

  test("before the person writes: a DM opened with the first owner, even with a channel set", async () => {
    const f = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: `${ME},${OTHER}` });
    const { link } = await openIt(f);
    await link.send({ text: "[1] Can I run the tests? y/n" });
    expect(f.calls.map((c) => [c.method, c.url.replace("https://discord.com/api/v10", "")])).toEqual([["POST", "/users/@me/channels"], ["POST", `/channels/${DM}/messages`]]);
    expect(f.calls[0]!.body).toEqual({ recipient_id: ME });
    await link.stop();

    const g = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME, TETHER_DISCORD_CHANNEL_ID: CHAN });
    const o = await openIt(g);
    await o.link.send({ text: "hey" });
    expect(g.calls.map((c) => c.url)).toEqual(["https://discord.com/api/v10/users/@me/channels", `https://discord.com/api/v10/channels/${DM}/messages`]);
    // The channel's messages come in too.
    o.gw.push({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "e", type: 0, guild_id: "g", channel_id: CHAN, content: `<@${BOT}> 1 y`, author: { id: ME } } });
    expect(o.heard.map((m) => m.text)).toEqual(["1 y"]);
    await o.link.stop();
  });

  test("images go out as attachments, on the last part", async () => {
    const dir = mkdtempSync(join(tmpdir(), "discord-img-"));
    try {
      const img = join(dir, "chart.png");
      writeFileSync(img, new Uint8Array([9, 9]));
      const f = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME, TETHER_DISCORD_CHANNEL_ID: CHAN });
      const { link } = await openIt(f);
      await link.send({ text: "[home] here's the chart", images: [img] });
      const form = f.calls.find((c) => c.form)!.form!;
      expect(JSON.parse(String(form.get("payload_json")))).toEqual({ content: "[home] here's the chart", allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: "chart.png" }] });
      const file = form.get("files[0]") as File;
      expect([file.name, file.type, [...new Uint8Array(await file.arrayBuffer())]]).toEqual(["chart.png", "image/png", [9, 9]]);
      await link.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refused token: the link ends for good with why", async () => {
    const f = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME });
    const { link, gw } = await openIt(f);
    gw.drop(4004);
    await link.closed;
    expect(link.fatal).toContain("bot token");
  });

  test("a 429 waits and tries again", async () => {
    let n = 0;
    const fetcher = (async () => (++n === 1 ? Response.json({ retry_after: 0.01 }, { status: 429 }) : Response.json({ id: "ok" }))) as unknown as typeof fetch;
    const { Rest } = await import("./discordGateway");
    expect(await new Rest(TOKEN, fetcher).post(CHAN, "hi")).toBe("ok");
    expect(n).toBe(2);
    const denied = (async () => Response.json({ message: "Missing Access" }, { status: 403 })) as unknown as typeof fetch;
    await expect(new Rest(TOKEN, denied).post(CHAN, "hi")).rejects.toThrow("Discord answered 403: Missing Access");
  });
});

describe("review fixes", () => {
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  test("Tether writes to the owner's DM; the channel only while the person last wrote there, kept across a reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "discord-where-"));
    try {
      const file = join(dir, "texting.json");
      const env = { TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME, TETHER_DISCORD_CHANNEL_ID: CHAN };
      const f = fakeDiscord(env, file);
      const o = await openIt(f);
      const posted = () => f.calls.filter((c) => c.url.endsWith("/messages")).map((c) => c.url.split("/channels/")[1]!.split("/")[0]);
      await o.link.send({ text: "[1] Can I run the tests? y/n" });
      expect(posted()).toEqual([DM]);
      // They write in the channel: answers go there now.
      o.gw.push({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "c1", type: 0, guild_id: "g", channel_id: CHAN, content: "1 y", author: { id: ME } } });
      await o.link.send({ text: "[1] ok" });
      expect(posted()).toEqual([DM, CHAN]);
      expect(JSON.parse(readFileSync(file, "utf8")).connectors.discord.where).toEqual({ kind: "channel", id: CHAN });
      await o.link.stop();
      // A restart keeps it.
      const g = fakeDiscord(env, file);
      const p = await openIt(g);
      await p.link.send({ text: "[2] hi" });
      expect(g.calls.map((c) => c.url)).toEqual([`https://discord.com/api/v10/channels/${CHAN}/messages`]);
      // Back in the DM: DMs again.
      p.gw.push({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { id: "d1", type: 0, channel_id: DM, content: "hi", author: { id: ME } } });
      await p.link.send({ text: "[2] ok" });
      expect(g.calls.at(-1)!.url).toBe(`https://discord.com/api/v10/channels/${DM}/messages`);
      await p.link.stop();
      // The channel changed in settings: never the old one.
      const h = fakeDiscord({ ...env, TETHER_DISCORD_CHANNEL_ID: "555555555555555555" }, file);
      h.store.setSection("discord", { ...h.store.section("discord"), where: { kind: "channel", id: CHAN } });
      const q = await openIt(h);
      await q.link.send({ text: "x" });
      expect(h.calls.map((c) => c.url.replace("https://discord.com/api/v10", ""))).toEqual(["/users/@me/channels", `/channels/${DM}/messages`]);
      await q.link.stop();
      expect(h.c.forms().find((x) => x.key === "channel")!.note).toContain("Anyone who can see the channel can read");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refused token at the first start is fatal: no retry, the reason shown until settings change", async () => {
    const socks = sockets();
    const g = new Gateway(TOKEN, () => {}, { socket: socks.open });
    const started = g.start();
    socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    socks.last().drop(4014);
    const e = await started.catch((x) => x);
    expect(isFatal(e)).toBe(true);
    // The connector's open throws it as it is; the channel doesn't retry.
    const f = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME });
    const ch = new Channel(f.c, () => {}, () => {});
    const starting = ch.start();
    await until(() => f.socks.all.length === 1);
    f.socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    f.socks.last().drop(4004);
    await starting;
    expect(ch.lastError).toContain("turned down the bot token");
    expect((ch as any).retry).toBeUndefined();
    await ch.stop();
  });

  test("the backoff starts over only after a stable connection; identifies keep a gap", async () => {
    const { g, socks } = await connected({ stableMs: 60, reconnectMinMs: 5, reconnectMaxMs: 1000 });
    for (let i = 0; i < 3; i++) {
      socks.last().drop(1006);
      const n = socks.all.length;
      await until(() => socks.all.length === n + 1);
      socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
      socks.last().push({ op: 0, t: "RESUMED", s: 2, d: {} });
    }
    // READY/RESUMED alone don't reset it.
    expect((g as any).delay).toBe(40);
    await tick(90);
    expect((g as any).delay).toBe(5);
    g.stop();

    const late = await connected({ identifyGapMs: 150 });
    const at = Date.now();
    late.socks.last().push({ op: 9, d: false });
    await until(() => late.socks.all.length === 2);
    expect(Date.now() - at).toBeGreaterThanOrEqual(140);
    late.g.stop();
  });

  test("splitting never cuts an emoji and drops blank parts; nothing to send posts nothing", async () => {
    const parts = splitMessage("a" + "😀".repeat(1500));
    for (const p of parts) expect(LONE.test(p)).toBe(false);
    expect(parts.join("")).toBe("a" + "😀".repeat(1500));
    expect(parts[0]!.length).toBe(1999);
    expect(splitMessage("  \n  ")).toEqual([]);
    expect(splitMessage("")).toEqual([]);
    expect(splitMessage("x".repeat(2000) + "\n" + " ".repeat(2500))).toEqual(["x".repeat(2000)]);
    const f = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME });
    const { link } = await openIt(f);
    expect(await link.send({ text: "   " })).toEqual([]);
    expect(f.calls).toEqual([]);
    await link.stop();
  });

  test("downloads: Discord's CDN over https only, streamed, cut off past the cap, timing out", async () => {
    const ok = (async () => new Response(new Uint8Array([1, 2]))) as unknown as typeof fetch;
    for (const url of ["http://cdn.discordapp.com/a.png", "https://evil.example/a.png", "https://cdn.discordapp.com.evil.example/a", "file:///etc/passwd", "nonsense"]) await expect(download(url, 100, ok)).rejects.toThrow("not a Discord attachment");
    expect([...(await download("https://media.discordapp.net/a.png", 100, ok))]).toEqual([1, 2]);
    let pulled = 0;
    const endless = (async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            pulled++;
            c.enqueue(new Uint8Array(1000));
          },
        }),
      )) as unknown as typeof fetch;
    await expect(download("https://cdn.discordapp.com/big", 5000, endless)).rejects.toThrow("too big");
    expect(pulled).toBeLessThan(20);
    const hangs = ((_: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(download("https://cdn.discordapp.com/slow", 100, hangs, 20)).rejects.toThrow();
    // REST calls time out too.
    await expect(new Rest(TOKEN, hangs, undefined, 20).post(CHAN, "hi")).rejects.toThrow();
  });

  test("429: a bad retry_after waits 1 s; a long one fails at once", async () => {
    expect([retryAfter("abc"), retryAfter(NaN), retryAfter(Infinity), retryAfter(-2), retryAfter(undefined), retryAfter("2.5"), retryAfter(0.2)]).toEqual([1, 1, 1, 1, 1, 2.5, 0.2]);
    let n = 0;
    const slow = (async () => (n++, Response.json({ retry_after: 30, global: true }, { status: 429 }))) as unknown as typeof fetch;
    const at = Date.now();
    await expect(new Rest(TOKEN, slow).post(CHAN, "hi")).rejects.toThrow("rate limiting");
    expect([n, Date.now() - at < 500]).toEqual([1, true]);
  });

  test("saved settings are checked on load: no string owner ids, no bad channel; the setter checks the same", () => {
    expect(cleanSettings({ ownerIds: "111111111111111111", channelId: 5, token: 7, enabled: "yes" })).toEqual({});
    expect(cleanSettings({ ownerIds: ["111111111111111111", 5, "abc", "1234"], channelId: "333333333333333333", where: { kind: "dm", id: DM } })).toEqual({ ownerIds: ["111111111111111111"], channelId: "333333333333333333" });
    expect(cleanSettings(null)).toEqual({});
    const store = new TextingStore(undefined, {});
    store.connectors = { discord: { token: TOKEN, ownerIds: "111111111111111111", channelId: { x: 1 } } as any };
    const c = discordConnector(store);
    expect(c.configured()).toBe(false);
    expect(c.forms().find((x) => x.key === "owners")!.status).toBe("Not set");
    expect(c.forms().find((x) => x.key === "channel")!.status).toBe("DMs only");
    expect(() => c.update({ values: { ownerIds: "1234" } })).toThrow("long number");
    expect(() => c.update({ values: { channelId: "12a45" } })).toThrow("long number");
    c.update({ values: { ownerIds: "12345" } });
    expect(c.configured()).toBe(true);
    // An env value that isn't an id isn't one.
    const e = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: "me,1", TETHER_DISCORD_CHANNEL_ID: "general" });
    expect(e.c.configured()).toBe(false);
  });

  test("a forward or a reference to another channel isn't a reply", () => {
    const who = { selfId: BOT, ownerIds: [ME] };
    const msg = (ref: any) => ({ id: "m", type: 19, channel_id: DM, content: "x", author: { id: ME }, message_reference: ref });
    expect(personMessage(msg({ message_id: "t", channel_id: DM, type: 0 }), who)?.replyTo).toBe("t");
    expect(personMessage(msg({ message_id: "t", channel_id: DM, type: 1 }), who)?.replyTo).toBeUndefined();
    expect(personMessage(msg({ message_id: "t", channel_id: CHAN }), who)?.replyTo).toBeUndefined();
    expect(personMessage(msg({ message_id: "t" }), who)?.replyTo).toBeUndefined();
  });

  test("masked links are spelled out; other markdown stays", async () => {
    expect(unmask("see [the docs](https://evil.example/x) now")).toBe("see the docs (https://evil.example/x) now");
    expect(unmask('[a](<https://x.dev/a> "t") and **bold** [1] ok `[c](d)`')).toBe("a (https://x.dev/a) and **bold** [1] ok `c (d)`");
    expect(unmask("[](https://x.dev)")).toBe("https://x.dev");
    expect(unmask("[2] Can I run it? y/n\nhttps://tether.example/#/s/a")).toBe("[2] Can I run it? y/n\nhttps://tether.example/#/s/a");
    const f = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME });
    const { link } = await openIt(f);
    await link.send({ text: "[home] done: [PR](https://evil.example)" });
    expect(f.calls.at(-1)!.body.content).toBe("[home] done: PR (https://evil.example)");
    await link.stop();
  });

  test("the bot token is taken out of the environment agents inherit", () => {
    const env: Record<string, string | undefined> = { TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME, PATH: "/bin" };
    expect(takeEnv(env)).toEqual({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME });
    expect(env).toEqual({ PATH: "/bin" });
    // The runner's own was taken when discord.ts loaded.
    expect(process.env.TETHER_DISCORD_TOKEN).toBeUndefined();
  });
});
