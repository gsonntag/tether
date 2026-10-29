import { afterEach, expect, test } from "bun:test";
import { Link, linkBackoff, type LinkDeps, type LinkTimings, type SocketLike } from "./link";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: any[] = [];
  closed = false;
  onopen: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // test side
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  serverClose() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const links: Link[] = [];
afterEach(() => links.splice(0).forEach((l) => l.stop()));

function setup(timings: Partial<LinkTimings> = {}, me: LinkDeps["me"] = async () => ({ status: 200, redirected: false, json: true, body: { allowed: true } })) {
  const socks: FakeSocket[] = [];
  const link = new Link({ url: "ws://x/api/ws", open: () => (socks.push(new FakeSocket()), socks.at(-1)!), me }, { maxBackoffMs: 50, ...timings });
  links.push(link);
  const states: string[] = [];
  const auth: string[] = [];
  link.onState((s) => states.push(s));
  link.onAuth((a) => auth.push(a));
  return { link, socks, states, auth, last: () => socks.at(-1)! };
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

test("backoff doubles from 0.5 s to the cap", () => {
  expect([0, 1, 2, 3, 4, 5, 20].map((a) => linkBackoff(a, 15_000))).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000]);
});

test("rpcs resolve by id, fail with the server's error, and fail on disconnect", async () => {
  const { link, last } = setup();
  link.connect();
  last().open();
  const a = link.rpc("box", "ping", {});
  const b = link.rpc("box", "ping", {});
  const c = link.rpc("box", "ping", {});
  const [ra, rb] = last().sent;
  last().receive({ t: "result", id: rb.id, ok: false, error: "nope" });
  last().receive({ t: "result", id: ra.id, ok: true, data: 1 });
  expect(await a).toBe(1);
  await expect(b).rejects.toThrow("nope");
  last().serverClose();
  await expect(c).rejects.toThrow("Disconnected.");
  await expect(link.rpc("box", "ping", {})).rejects.toThrow("Not connected.");
});

test("reconnects after a close, and messages reach listeners by type", async () => {
  const { link, socks, states, last } = setup();
  const runners: unknown[] = [];
  link.on("runners", (m) => runners.push(m.runners));
  link.connect();
  last().open();
  last().serverClose();
  expect(states).toEqual(["connecting", "open", "down"]);
  await until(() => socks.length === 2);
  last().open();
  last().receive({ t: "runners", runners: [] });
  expect(runners).toEqual([[]]);
  expect(states.at(-1)).toBe("open");
});

test("a silent link is dropped and redialled at once", async () => {
  const { link, socks, last } = setup({ pingMs: 20, silenceMs: 50 });
  link.connect();
  last().open();
  const first = last();
  await until(() => socks.length === 2, 1000);
  expect(first.closed).toBe(true);
  expect(first.sent.some((m) => m.t === "ping")).toBe(true);
});

test("pongs keep a link alive", async () => {
  const { link, socks, last } = setup({ pingMs: 20, silenceMs: 60 });
  link.connect();
  last().open();
  const s = last();
  const t = setInterval(() => s.receive({ t: "pong" }), 15);
  await Bun.sleep(200);
  clearInterval(t);
  expect(socks.length).toBe(1);
});

test("wake: an open socket that doesn't answer the probe is replaced; one that answers is kept", async () => {
  const { link, socks, last } = setup({ probeMs: 30 });
  link.connect();
  last().open();
  link.wake();
  last().receive({ t: "pong" });
  await Bun.sleep(60);
  expect(socks.length).toBe(1);
  link.wake();
  await until(() => socks.length === 2, 500);
  expect(socks[0]!.closed).toBe(true);
});

test("wake while waiting out a backoff dials now", async () => {
  const { link, socks, last } = setup({ maxBackoffMs: 10_000 });
  link.connect();
  last().serverClose(); // never opened: backoff 500 ms
  link.wake();
  expect(socks.length).toBe(2);
});

test("a refused connection checks the sign-in", async () => {
  for (const [me, expected] of [
    [{ status: 401, redirected: false, json: true }, "signedOut"],
    [{ status: 200, redirected: true, json: false }, "signedOut"],
    [{ status: 200, redirected: false, json: true, body: { allowed: false } }, "notOwner"],
    [{ status: 200, redirected: false, json: true, body: { allowed: true } }, "ok"],
  ] as const) {
    const { link, last, auth } = setup({ maxBackoffMs: 10_000 }, async () => me);
    link.connect();
    last().serverClose();
    await until(() => auth.length > 0);
    expect(auth).toEqual([expected]);
    link.stop();
  }
});

test("a drop after being open doesn't check the sign-in", async () => {
  let asked = 0;
  const { link, last } = setup({}, async () => (asked++, { status: 200, redirected: false, json: true, body: { allowed: true } }));
  link.connect();
  last().open();
  last().serverClose();
  await Bun.sleep(20);
  expect(asked).toBe(0);
});

test("a dial that never opens is abandoned and redialled, without a sign-in check", async () => {
  let asked = 0;
  const { link, socks, states } = setup({ dialMs: 30, maxBackoffMs: 20 }, async () => (asked++, { status: 200, redirected: false, json: true, body: { allowed: true } }));
  link.connect();
  await until(() => socks.length >= 2, 1000);
  expect(socks[0]!.closed).toBe(true);
  expect(states.slice(0, 2)).toEqual(["connecting", "down"]);
  expect(asked).toBe(0);
});

test("wake replaces a socket stuck connecting, and a late open of the old one is ignored", () => {
  const { link, socks, states } = setup({ dialMs: 60_000 });
  link.connect();
  const stuck = socks[0]!;
  link.wake();
  expect(socks.length).toBe(2);
  expect(stuck.closed).toBe(true);
  stuck.open();
  expect(states.at(-1)).toBe("connecting");
  socks[1]!.open();
  expect(states.at(-1)).toBe("open");
});
