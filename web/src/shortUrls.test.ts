import { expect, test } from "bun:test";
import { LINK_TTL_MS, LinkCache, RENEW_MS, RETRY_MS } from "./linkCache";
import { formatRoute, parseRoute, presenceFor, resolveRoute, sessionRoute, shortHash } from "./route";

function memStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

/** A cache whose runner answers `codes[sessionId]` (null: no code) and counts the asks. */
function cacheWith(codes: Record<string, string | null>, clock = { t: 1_000_000 }, store = memStore()) {
  const asks: string[] = [];
  const c = new LinkCache(store, () => clock.t);
  c.setAsk(async (runnerId, sessionId) => {
    asks.push(`${runnerId}/${sessionId}`);
    const code = codes[sessionId];
    if (code === undefined) throw new Error('This runner doesn\'t know "linkFor".');
    return code;
  });
  return { c, asks, clock, store };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** The browser's bar and history, as route.ts's startShortUrls drives them. */
class Bar {
  entries: string[];
  at = 0;
  constructor(
    private cache: LinkCache,
    first: string,
  ) {
    this.entries = [first];
    cache.subscribe(() => this.shorten());
    this.shorten();
  }
  get hash() {
    return this.entries[this.at]!;
  }
  push(h: string) {
    if (h === this.hash) return;
    this.entries = [...this.entries.slice(0, this.at + 1), h];
    this.at++;
    this.shorten();
  }
  replace(h: string) {
    this.entries[this.at] = h;
  }
  back() {
    this.at--;
    this.shorten();
  }
  forward() {
    this.at++;
    this.shorten();
  }
  open(runnerId: string, sessionId: string) {
    this.push(formatRoute(sessionRoute(runnerId, sessionId, this.cache)));
  }
  route() {
    return resolveRoute(parseRoute(this.hash), this.cache);
  }
  private shorten() {
    const h = shortHash(this.hash, this.cache);
    if (h) this.replace(h);
  }
}

test("opening a session shows its short link; the second time without asking", async () => {
  const { c, asks } = cacheWith({ "claude:a": "Ab3dE6gH" });
  const bar = new Bar(c, "#/");
  bar.open("box", "claude:a");
  // Until the runner answers, the long form (the session still renders).
  expect(bar.hash).toBe("#/s/box/claude%3Aa");
  await tick();
  expect(bar.hash).toBe("#/l/Ab3dE6gH");
  expect(bar.entries).toEqual(["#/", "#/l/Ab3dE6gH"]);
  expect(bar.route()).toEqual({ page: "session", runnerId: "box", sessionId: "claude:a", code: "Ab3dE6gH" });

  bar.push("#/");
  bar.open("box", "claude:a");
  expect(bar.hash).toBe("#/l/Ab3dE6gH");
  expect(asks).toEqual(["box/claude:a"]);
});

test("old #/s/ links still open, and the bar becomes the short link in place", async () => {
  const { c } = cacheWith({ "claude:a": "Ab3dE6gH" });
  const bar = new Bar(c, "#/s/box/claude%3Aa");
  expect(bar.route()).toEqual({ page: "session", runnerId: "box", sessionId: "claude:a" });
  await tick();
  expect(bar.entries).toEqual(["#/l/Ab3dE6gH"]);
});

test("a runner without linkFor (or offline) keeps the long form, asked again only after a while", async () => {
  const { c, asks, clock } = cacheWith({});
  const bar = new Bar(c, "#/s/old/claude%3Aa");
  await tick();
  expect(bar.hash).toBe("#/s/old/claude%3Aa");
  bar.push("#/");
  bar.back();
  await tick();
  expect(asks).toHaveLength(1);
  clock.t += RETRY_MS;
  bar.forward();
  bar.back();
  await tick();
  expect(asks).toHaveLength(2);
  // A runner coming online clears the wait.
  c.retrySoon();
  bar.push("#/");
  bar.back();
  await tick();
  expect(asks).toHaveLength(3);
  expect(bar.route()).toEqual({ page: "session", runnerId: "old", sessionId: "claude:a" });
});

test("reload on a short URL shows the session from what this browser kept", async () => {
  const store = memStore();
  const first = cacheWith({ "claude:a": "Ab3dE6gH" }, undefined, store);
  first.c.want("box", "claude:a");
  await tick();
  const { c, asks } = cacheWith({ "claude:a": "Ab3dE6gH" }, undefined, store);
  const bar = new Bar(c, "#/l/Ab3dE6gH");
  expect(bar.route()).toEqual({ page: "session", runnerId: "box", sessionId: "claude:a", code: "Ab3dE6gH" });
  expect(bar.hash).toBe("#/l/Ab3dE6gH");
  expect(asks).toEqual([]);
});

test("a short link this browser doesn't know is the link page until a runner resolves it; the URL stays short", async () => {
  const { c, asks } = cacheWith({ "claude:a": "Ab3dE6gH" });
  const bar = new Bar(c, "#/l/Ab3dE6gH");
  expect(bar.route()).toEqual({ page: "link", code: "Ab3dE6gH" });
  // ShortLink.tsx's resolveLink hit:
  c.remember("Ab3dE6gH", "box", "claude:a", false);
  expect(bar.route()).toEqual({ page: "session", runnerId: "box", sessionId: "claude:a", code: "Ab3dE6gH" });
  expect(bar.entries).toEqual(["#/l/Ab3dE6gH"]);
  // A code only resolved is renewed on the runner.
  await tick();
  expect(asks).toEqual(["box/claude:a"]);
  expect(bar.entries).toEqual(["#/l/Ab3dE6gH"]);
});

test("back and forward between sessions keep short URLs", async () => {
  const { c } = cacheWith({ "claude:a": "AAAAaaaa", "codex:b": "BBBBbbbb" });
  const bar = new Bar(c, "#/");
  bar.open("box", "claude:a");
  await tick();
  bar.open("laptop", "codex:b");
  await tick();
  expect(bar.entries).toEqual(["#/", "#/l/AAAAaaaa", "#/l/BBBBbbbb"]);
  bar.back();
  expect(bar.route()).toMatchObject({ runnerId: "box", sessionId: "claude:a" });
  bar.back();
  expect(bar.route()).toEqual({ page: "home" });
  bar.forward();
  bar.forward();
  expect(bar.route()).toMatchObject({ runnerId: "laptop", sessionId: "codex:b" });
  expect(bar.entries).toEqual(["#/", "#/l/AAAAaaaa", "#/l/BBBBbbbb"]);
});

test("codes are renewed once a day while in use, and dropped when the runner's would have expired", async () => {
  const { c, asks, clock } = cacheWith({ "claude:a": "Ab3dE6gH" });
  c.want("box", "claude:a");
  await tick();
  c.want("box", "claude:a");
  await tick();
  expect(asks).toHaveLength(1);
  clock.t += RENEW_MS;
  c.want("box", "claude:a");
  await tick();
  expect(asks).toHaveLength(2);
  clock.t += LINK_TTL_MS - 1;
  expect(c.session("Ab3dE6gH")).toEqual({ runnerId: "box", sessionId: "claude:a" });
  clock.t += 1;
  expect(c.session("Ab3dE6gH")).toBeUndefined();
  expect(c.code("box", "claude:a")).toBeUndefined();
});

test("a session's new code replaces its old one", async () => {
  const codes: Record<string, string> = { "claude:a": "OLDcode1" };
  const { c } = cacheWith(codes);
  c.want("box", "claude:a");
  await tick();
  codes["claude:a"] = "NEWcode1";
  c.remember("NEWcode1", "box", "claude:a", true);
  expect(c.session("OLDcode1")).toBeUndefined();
  expect(c.code("box", "claude:a")).toBe("NEWcode1");
});

test("presence follows a short URL's session", async () => {
  const { c } = cacheWith({ "claude:x": "Ab3dE6gH" });
  c.want("r1", "claude:x");
  await tick();
  expect(presenceFor("#/l/Ab3dE6gH", true, c)).toEqual({ runnerId: "r1", sessionId: "claude:x" });
  expect(presenceFor("#/l/Ab3dE6gH", false, c)).toEqual({});
  expect(presenceFor("#/l/Unknown1", true, c)).toEqual({});
});
