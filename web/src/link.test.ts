import { afterEach, describe, expect, test } from "bun:test";
import { CLOSE_REAUTH } from "../../shared/protocol";
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
  serverClose(code?: number) {
    this.readyState = 3;
    this.onclose?.(code ? { code } : {});
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

describe("sign-in renewal", () => {
  function renewing(timings: Partial<LinkTimings>, answer: () => { status: number; ticket?: string }, meAllowed = true) {
    const socks: FakeSocket[] = [];
    let fetches = 0;
    let now = 0;
    const link = new Link(
      {
        url: "ws://x/api/ws",
        open: () => (socks.push(new FakeSocket()), socks.at(-1)!),
        me: async () => ({ status: 200, redirected: false, json: true, body: { allowed: meAllowed } }),
        ticket: async () => (fetches++, answer()),
        now: () => now,
      },
      { maxBackoffMs: 50, ...timings },
    );
    links.push(link);
    const auth: string[] = [];
    link.onAuth((a) => auth.push(a));
    return { link, socks, auth, last: () => socks.at(-1)!, fetches: () => fetches, tick: (ms: number) => (now += ms) };
  }
  const renews = (s: FakeSocket) => s.sent.filter((m) => m.t === "renew").map((m) => m.ticket);

  test("renews right after opening and then on a timer", async () => {
    let n = 0;
    const { link, last } = renewing({ renewMs: 30 }, () => ({ status: 200, ticket: `t${++n}` }));
    link.connect();
    last().open();
    await until(() => renews(last()).length >= 3);
    expect(renews(last()).slice(0, 3)).toEqual(["t1", "t2", "t3"]);
  });

  test("waking renews at once when the last renewal is old, not when it's recent", async () => {
    const { link, last, fetches, tick } = renewing({ renewMs: 60_000, renewWakeMs: 30_000 }, () => ({ status: 200, ticket: "t" }));
    link.connect();
    last().open();
    await until(() => renews(last()).length === 1);
    tick(10_000);
    link.wake();
    await Bun.sleep(10);
    expect(fetches()).toBe(1);
    tick(30_000);
    link.wake();
    await until(() => renews(last()).length === 2);
  });

  test("a refused ticket stops renewing and checks the sign-in", async () => {
    const { link, last, fetches, auth } = renewing({ renewMs: 20 }, () => ({ status: 403 }), false);
    link.connect();
    last().open();
    await until(() => auth.includes("notOwner"));
    await Bun.sleep(80);
    expect(fetches()).toBe(1);
    expect(renews(last())).toEqual([]);
  });

  test("a ticket that arrives after its socket closed isn't sent on the next one", async () => {
    let release!: (v: { status: number; ticket: string }) => void;
    const socks: FakeSocket[] = [];
    const link = new Link({ url: "ws://x/api/ws", open: () => (socks.push(new FakeSocket()), socks.at(-1)!), me: async () => ({ status: 200, redirected: false, json: true, body: { allowed: true } }), ticket: () => new Promise((r) => (release = r)) }, { maxBackoffMs: 5 });
    links.push(link);
    link.connect();
    socks[0]!.open();
    const first = release;
    socks[0]!.serverClose();
    await until(() => socks.length === 2);
    socks[1]!.open();
    expect(release).not.toBe(first);
    first({ status: 200, ticket: "old" });
    release({ status: 200, ticket: "new" });
    await until(() => renews(socks[1]!).length === 1);
    expect(renews(socks[1]!)).toEqual(["new"]);
    expect(renews(socks[0]!)).toEqual([]);
  });

  test("closed for an expired sign-in: reconnects and checks the sign-in", async () => {
    const { link, socks, last, auth } = renewing({}, () => ({ status: 200, ticket: "t" }), false);
    link.connect();
    last().open();
    auth.length = 0;
    last().serverClose(CLOSE_REAUTH);
    await until(() => auth.includes("notOwner"));
    await until(() => socks.length === 2);
  });
});
