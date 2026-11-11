import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../../credentials";
import { Channel, isFatal, type Inbound } from "./connector";
import { cleanSettings, discordConnector, personMessage, splitMessage, takeEnv, unmask } from "./discord";
import { download, Gateway, INTENTS, resetIdentifies, Rest, retryAfter, takeIdentify, validResumeUrl, type Socket } from "./discordGateway";
import { TextingStore } from "./store";

// The identify budget is kept by the last connector made: a test's store (and its scratch folder)
// mustn't be written to by the next test's gateways.
afterEach(() => resetIdentifies());

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
    expect(personMessage(msg({ guild_id: "g", channel_id: CHAN, content: `<@${BOT}> 2 yes` }), who)?.channelId).toBe(CHAN);
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

  test("Tether writes to the owner's DM; the channel only for an answer to what was written there; the DM is kept across a reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "discord-where-"));
    try {
      const file = join(dir, "texting.json");
      const env = { TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME, TETHER_DISCORD_CHANNEL_ID: CHAN };
      const f = fakeDiscord(env, file);
      const o = await openIt(f);
      const posted = () => f.calls.filter((c) => c.url.endsWith("/messages")).map((c) => c.url.split("/channels/")[1]!.split("/")[0]);
      await o.link.send({ text: "[1] Can I run the tests? y/n" });
      expect(posted()).toEqual([DM]);
      // They write in the channel: the answer to that goes there, with its place.
      o.gw.push({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "c1", type: 0, guild_id: "g", channel_id: CHAN, content: `<@${BOT}> 1 y`, author: { id: ME } } });
      expect(o.heard.at(-1)!.place).toBe(CHAN);
      await o.link.send({ text: "[1] ok", place: CHAN, shared: true });
      expect(posted()).toEqual([DM, CHAN]);
      // Tether's own next text: the DM, not the channel.
      await o.link.send({ text: "[2] Can I deploy? y/n" });
      expect(posted()).toEqual([DM, CHAN, DM]);
      // A place that isn't the set channel or an owner's DM: the DM.
      await o.link.send({ text: "x", place: "777777777777777777" });
      expect(posted().at(-1)).toBe(DM);
      expect(JSON.parse(readFileSync(file, "utf8")).connectors.discord.where).toEqual({ kind: "dm", id: DM, owner: ME });
      await o.link.stop();
      // A restart keeps the DM: no new DM to open.
      const g = fakeDiscord(env, file);
      const p = await openIt(g);
      await p.link.send({ text: "[2] hi" });
      expect(g.calls.map((c) => c.url)).toEqual([`https://discord.com/api/v10/channels/${DM}/messages`]);
      await p.link.stop();
      // An old saved "channel" target is dropped on load.
      const h = fakeDiscord(env, file);
      h.store.setSection("discord", { ...h.store.section("discord"), where: { kind: "channel", id: CHAN } });
      const q = await openIt(h);
      await q.link.send({ text: "x" });
      expect(h.calls.map((c) => c.url.replace("https://discord.com/api/v10", ""))).toEqual(["/users/@me/channels", `/channels/${DM}/messages`]);
      await q.link.stop();
      expect(h.c.forms().find((x) => x.key === "channel")!.note).toContain("anyone who can see the channel can read it");
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

describe("second review round", () => {
  test("B2: in the channel only a mention of the bot or a reply to it counts; DMs as before", () => {
    const who = { selfId: BOT, ownerIds: [ME], channelId: CHAN, mine: (id: string) => id === "tether1" };
    const inChan = (o: any) => ({ id: "m", type: 0, guild_id: "g", channel_id: CHAN, author: { id: ME }, content: "yes", ...o });
    // "yes" to a coworker: nothing.
    expect(personMessage(inChan({}), who)).toBeUndefined();
    expect(personMessage(inChan({ content: `yes <@${BOT}>` }), who)).toBeUndefined();
    // A reply to a coworker's message: nothing.
    expect(personMessage(inChan({ type: 19, message_reference: { message_id: "other", channel_id: CHAN }, referenced_message: { author: { id: OTHER } } }), who)).toBeUndefined();
    // A mention first, stripped; a reply to Tether's message (by its author, or one it posted).
    expect(personMessage(inChan({ content: `<@${BOT}> yes` }), who)?.text).toBe("yes");
    expect(personMessage(inChan({ type: 19, message_reference: { message_id: "x", channel_id: CHAN }, referenced_message: { author: { id: BOT } } }), who)?.text).toBe("yes");
    expect(personMessage(inChan({ type: 19, message_reference: { message_id: "tether1", channel_id: CHAN } }), who)?.replyTo).toBe("tether1");
    // DMs need neither.
    expect(personMessage({ id: "d", type: 0, channel_id: DM, author: { id: ME }, content: "yes" }, who)?.text).toBe("yes");
  });

  test("B2: a reply in the channel to a message the bot posted there is taken", async () => {
    const f = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME, TETHER_DISCORD_CHANNEL_ID: CHAN });
    const o = await openIt(f);
    o.gw.push({ op: 0, t: "MESSAGE_CREATE", s: 2, d: { id: "c1", type: 0, guild_id: "g", channel_id: CHAN, content: `<@${BOT}> hi`, author: { id: ME } } });
    const [id] = (await o.link.send({ text: "[1] Can I? y/n", place: CHAN, shared: true })) as string[];
    o.gw.push({ op: 0, t: "MESSAGE_CREATE", s: 3, d: { id: "c2", type: 19, guild_id: "g", channel_id: CHAN, content: "y", author: { id: ME }, message_reference: { message_id: id, channel_id: CHAN } } });
    o.gw.push({ op: 0, t: "MESSAGE_CREATE", s: 4, d: { id: "c3", type: 0, guild_id: "g", channel_id: CHAN, content: "y", author: { id: ME } } });
    expect(o.heard.map((m) => [m.id, m.text])).toEqual([["c1", "hi"], ["c2", "y"]]);
    await o.link.stop();
  });

  test("N1: no masked link survives", () => {
    const hostile = ["[a [b] c](https://evil)", "[G](https://evil.com/a_(b))", "[two\nlines](https://evil)", '[t](https://evil "title")', "[t](<https://evil>)", "[t] (https://evil)", "[t](https://evil 'x')"];
    for (const h of hostile) {
      const out = unmask(h);
      // Every link target left is shown, and nothing parses as [text](url) any more.
      expect([h, /\[[^\]]*\]\s*\(/.test(out.replace(/\\\]/g, ""))]).toEqual([h, false]);
      expect(out).toContain("https://evil");
    }
    expect(unmask("**bold** _it_ `code` [1] ok")).toBe("**bold** _it_ `code` [1] ok");
  });

  test("N2: identifies are budgeted across gateways; op 9 and repeated op 7 back off", async () => {
    resetIdentifies();
    expect(takeIdentify(1000, 2)).toBe(true);
    expect(takeIdentify(1001, 2)).toBe(true);
    expect(takeIdentify(1002, 2)).toBe(false);
    // A day later the budget is back.
    expect(takeIdentify(1000 + 24 * 60 * 60_000, 2)).toBe(true);
    resetIdentifies();
    // Spent: the gateway stops for good, with why.
    const socks = sockets();
    const g = new Gateway(TOKEN, () => {}, { socket: socks.open, identifyMax: 0 });
    const started = g.start();
    socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    const e = await started.catch((x) => x);
    expect(isFatal(e)).toBe(true);
    expect(String(e.message)).toContain("daily limit");
    expect(socks.last().ops(2)).toEqual([]);
    resetIdentifies();

    const { g: g2, socks: s2 } = await connected({ reconnectMinMs: 40, reconnectMaxMs: 1000 });
    // First reconnect request: at once. The next ones before it's stable: after the backoff.
    s2.last().push({ op: 7 });
    expect(s2.all.length).toBe(2);
    s2.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    s2.last().push({ op: 7 });
    expect(s2.all.length).toBe(2);
    await until(() => s2.all.length === 3);
    // An invalid session waits the backoff too (now 80 ms, over invalidMs 5).
    s2.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    const at = Date.now();
    s2.last().push({ op: 9, d: true });
    await until(() => s2.all.length === 4);
    expect(Date.now() - at).toBeGreaterThanOrEqual(70);
    g2.stop();
    resetIdentifies();
  });

  test("N4: downloads don't follow redirects", async () => {
    let init: RequestInit | undefined;
    const f = (async (_u: string, i: RequestInit) => ((init = i), new Response(new Uint8Array([1])))) as unknown as typeof fetch;
    await download("https://cdn.discordapp.com/a", 10, f);
    expect(init!.redirect).toBe("error");
  });

  test("N5: junk payloads are ignored; a resume URL off discord.gg never gets the token", async () => {
    expect(validResumeUrl("wss://gateway-us-east1-b.discord.gg")).toBeDefined();
    for (const bad of ["wss://evil.example", "ws://gateway.discord.gg", "wss://discord.gg.evil.example", "wss://x@gateway.discord.gg", 5, null, "nonsense"]) expect(validResumeUrl(bad)).toBeUndefined();
    const socks = sockets();
    const g = new Gateway(TOKEN, () => {}, { socket: socks.open, reconnectMinMs: 5, identifyGapMs: 0 });
    const started = g.start();
    const s = socks.last();
    for (const junk of ["null", "5", "[1]", '"x"', "{}", '{"op":"10"}']) s.onmessage!({ data: junk });
    s.push({ op: 10, d: { heartbeat_interval: 10_000 } });
    s.push({ op: 0, t: "READY", s: 1, d: { session_id: "sess1", resume_gateway_url: "wss://evil.example", user: { id: BOT } } });
    await started;
    s.drop(1006);
    await until(() => socks.all.length === 2);
    expect(socks.last().url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    expect(socks.last().ops(6)).toEqual([]);
    expect(socks.last().ops(2).length).toBe(1);
    g.stop();
    resetIdentifies();
  });

  test("N6: a split message that fails partway reports the parts that went", async () => {
    let n = 0;
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/users/@me/channels")) return Response.json({ id: DM });
      return ++n === 2 ? Response.json({ message: "boom" }, { status: 500 }) : Response.json({ id: `p${n}` });
    }) as unknown as typeof fetch;
    const socks = sockets();
    const c = discordConnector(new TextingStore(undefined, { TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME }), { fetch: fetcher, gateway: { socket: socks.open } });
    const opening = c.open(() => {}, () => {});
    await until(() => socks.all.length > 0);
    socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    ready(socks.last());
    const link = await opening;
    const e = await link.send({ text: "z".repeat(4500) }).catch((x) => x);
    expect(e.ids).toEqual(["p1"]);
    // Through a Channel: it counts as sent, with those ids.
    const ch = new Channel({ ...c, open: async () => link }, () => {}, () => {});
    await ch.start();
    n = 0;
    expect(await ch.send({ text: "z".repeat(4500) })).toEqual(["p1"]);
    expect(ch.lastError).toContain("boom");
    await ch.stop();
    resetIdentifies();
  });

  test("N10: Connected only while the gateway is up", async () => {
    const f = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME });
    const ch = new Channel(f.c, () => {}, () => {});
    const starting = ch.start();
    await until(() => f.socks.all.length === 1);
    f.socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    ready(f.socks.last());
    await starting;
    expect(ch.connected).toBe(true);
    f.socks.last().drop(1006);
    expect(ch.connected).toBe(false);
    await expect(ch.send({ text: "x" })).rejects.toThrow("not connected");
    await until(() => f.socks.all.length === 2);
    f.socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    f.socks.last().push({ op: 0, t: "RESUMED", s: 2, d: {} });
    expect(ch.connected).toBe(true);
    await ch.stop();
    resetIdentifies();
  });
});

describe("round 3", () => {
  test("the identify budget is kept in texting.json and read back after a restart", async () => {
    resetIdentifies();
    const dir = mkdtempSync(join(tmpdir(), "discord-budget-"));
    try {
      const file = join(dir, "texting.json");
      const f = fakeDiscord({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME }, file);
      const o = await openIt(f);
      await o.link.stop();
      const saved = JSON.parse(readFileSync(file, "utf8")).connectors.discord.identifies;
      expect(saved.length).toBe(1);
      // A restart: the count starts from what was kept.
      resetIdentifies();
      const store = new TextingStore(file, {});
      store.setSection("discord", { ...store.section("discord"), identifies: [Date.now() - 1000, Date.now() - 500, ...saved] });
      discordConnector(store);
      expect(takeIdentify(Date.now(), 3)).toBe(false);
      expect(takeIdentify(Date.now(), 4)).toBe(true);
      expect(cleanSettings({ identifies: [1, "x", NaN, 2] }).identifies).toEqual([1, 2]);
    } finally {
      resetIdentifies();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("round 4", () => {
  test("the channel only for a shared answer; owners' DMs kept across a reconnect; a gone DM reopened once; a new token forgets DMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "discord-r4-"));
    try {
      const file = join(dir, "texting.json");
      const env = { TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: `${ME},${OTHER}`, TETHER_DISCORD_CHANNEL_ID: CHAN };
      const DM_A = "600000000000000001";
      const DM_B = "600000000000000002";
      const f = fakeDiscord(env, file);
      const o = await openIt(f);
      const create = (d: any) => o.gw.push({ op: 0, t: "MESSAGE_CREATE", s: 9, d: { type: 0, attachments: [], ...d } });
      create({ id: "a1", channel_id: DM_A, content: "hi", author: { id: ME } });
      create({ id: "b1", channel_id: DM_B, content: "hi", author: { id: OTHER } });
      const url = () => f.calls.at(-1)!.url.replace("https://discord.com/api/v10", "");
      // A channel place without `shared`: never the channel.
      await o.link.send({ text: "x", place: CHAN });
      expect(url()).toBe(`/channels/${DM_B}/messages`);
      await o.link.send({ text: "x", place: CHAN, shared: true });
      expect(url()).toBe(`/channels/${CHAN}/messages`);
      await o.link.stop();
      // After a reconnect, an answer to owner A's DM still goes to A's DM, not B's (the last one written).
      const g = fakeDiscord(env, file);
      const p = await openIt(g);
      await p.link.send({ text: "for A", place: DM_A });
      expect(g.calls.at(-1)!.url).toBe(`https://discord.com/api/v10/channels/${DM_A}/messages`);
      await p.link.stop();
      // A DM Discord no longer takes: reopened once, for its owner.
      let failed = 0;
      const h = fakeDiscord(env, file);
      const realPost = h.calls;
      const q = await (async () => {
        const fetcher = (async (u: string, init: RequestInit = {}) => {
          realPost.push({ method: init.method ?? "GET", url: u, ...(init.body && !(init.body instanceof FormData) ? { body: JSON.parse(String(init.body)) } : {}) });
          if (u.endsWith(`/channels/${DM_A}/messages`) && !failed++) return Response.json({ message: "Unknown Channel" }, { status: 404 });
          if (u.endsWith("/users/@me/channels")) return Response.json({ id: "600000000000000003" });
          return Response.json({ id: "ok" });
        }) as unknown as typeof fetch;
        const socks = sockets();
        const c = discordConnector(new TextingStore(file, env), { fetch: fetcher, gateway: { socket: socks.open } });
        const opening = c.open(() => {}, () => {});
        await until(() => socks.all.length > 0);
        socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
        ready(socks.last());
        return opening;
      })();
      expect(await q.send({ text: "for A again", place: DM_A })).toEqual(["ok"]);
      expect(realPost.map((c) => c.url.replace("https://discord.com/api/v10", ""))).toEqual([`/channels/${DM_A}/messages`, "/users/@me/channels", "/channels/600000000000000003/messages"]);
      expect(realPost[1]!.body).toEqual({ recipient_id: ME });
      await q.stop();
      // A new token: the old bot's DMs are forgotten.
      const store = new TextingStore(file, {});
      const c2 = discordConnector(store);
      c2.update({ values: { token: "MTAy.another-bot-token.abcdefghijk" } });
      expect([store.section<any>("discord").where, store.section<any>("discord").dms]).toEqual([undefined, undefined]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("iMessage waits for its old Photon client to stop before a new one", async () => {
    const { imessageConnector } = await import("./imessage");
    expect(imessageConnector(new TextingStore(undefined, {})).stopWaitMs).toBe(15_000);
  });
});

describe("round 5", () => {
  /** A Discord whose REST is `handle` (url, body), on a fake gateway. */
  async function withRest(env: Record<string, string>, handle: (url: string, body: any) => Response | Promise<Response>) {
    const calls: string[] = [];
    const fetcher = (async (u: string, init: RequestInit = {}) => {
      calls.push(u.replace("https://discord.com/api/v10", ""));
      return handle(u, init.body && !(init.body instanceof FormData) ? JSON.parse(String(init.body)) : undefined);
    }) as unknown as typeof fetch;
    const socks = sockets();
    const c = discordConnector(new TextingStore(undefined, env), { fetch: fetcher, gateway: { socket: socks.open } });
    const opening = c.open(() => {}, () => {});
    await until(() => socks.all.length > 0);
    socks.last().push({ op: 10, d: { heartbeat_interval: 10_000 } });
    ready(socks.last());
    return { link: await opening, calls };
  }

  test("N3: DMs are opened per owner, even at once", async () => {
    const { link, calls } = await withRest({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: `${ME},${OTHER}` }, async (u, body) => {
      if (u.endsWith("/users/@me/channels")) {
        await tick(5);
        return Response.json({ id: body.recipient_id === ME ? "700000000000000001" : "700000000000000002" });
      }
      return Response.json({ id: "m" });
    });
    // No DM yet, nothing written: Tether's own texts go to the first owner's DM; never another owner's by a shared promise.
    await Promise.all([link.send({ text: "a" }), link.send({ text: "b" })]);
    expect(calls.filter((c) => c === "/users/@me/channels").length).toBe(1);
    expect(calls.filter((c) => c.endsWith("/messages"))).toEqual(["/channels/700000000000000001/messages", "/channels/700000000000000001/messages"]);
    await link.stop();
  });

  test("N4: a channel answer Discord refuses goes to the owner's DM", async () => {
    const { link, calls } = await withRest({ TETHER_DISCORD_TOKEN: TOKEN, TETHER_DISCORD_OWNER_IDS: ME, TETHER_DISCORD_CHANNEL_ID: CHAN }, (u) => {
      if (u.endsWith(`/channels/${CHAN}/messages`)) return Response.json({ message: "Missing Access" }, { status: 403 });
      if (u.endsWith("/users/@me/channels")) return Response.json({ id: DM });
      return Response.json({ id: "dm-msg" });
    });
    expect(await link.send({ text: "[1] ok", place: CHAN, shared: true })).toEqual(["dm-msg"]);
    expect(calls).toEqual([`/channels/${CHAN}/messages`, "/users/@me/channels", `/channels/${DM}/messages`]);
    await link.stop();
  });
});
