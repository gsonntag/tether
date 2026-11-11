import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpRegistry } from "../../core/ops";
import { Texter } from "../texting";
import type { OpenLink } from "../texting/link";
import { TextingStore } from "../texting/store";
import { linksModule } from ".";
import { CODE_LENGTH, LINK_TTL_MS, randomCode, ShortLinks } from "./store";

const DAY = 24 * 60 * 60_000;

function tmp() {
  return mkdtempSync(join(tmpdir(), "tether-links-"));
}

describe("codes", () => {
  test("8 URL-safe base62 characters", () => {
    for (let i = 0; i < 200; i++) {
      const c = randomCode();
      expect(c).toHaveLength(CODE_LENGTH);
      expect(c).toMatch(/^[0-9A-Za-z]{8}$/);
      expect(encodeURIComponent(c)).toBe(c);
    }
  });

  test("random: 5000 codes, no repeats", () => {
    const seen = new Set(Array.from({ length: 5000 }, () => randomCode()));
    expect(seen.size).toBe(5000);
  });

  test("bytes past 247 are skipped, so no character is favoured", () => {
    const feed = [255, 250, 248, 0, 61, 62, 247, 1, 2, 3, 4, 5, 6, 7];
    let i = 0;
    const c = randomCode(8, (n) => Uint8Array.from({ length: n }, () => feed[i++ % feed.length]!));
    expect(c).toBe("0z0z1234");
  });

  test("a code already in use is drawn again", () => {
    const draws = ["AAAAAAAA", "AAAAAAAA", "BBBBBBBB"];
    const links = new ShortLinks(undefined, () => 1, () => draws.shift()!);
    expect(links.codeFor("claude:a")).toBe("AAAAAAAA");
    expect(links.codeFor("claude:b")).toBe("BBBBBBBB");
  });
});

describe("short links", () => {
  test("resolve to their session; unknown or malformed codes don't", () => {
    const links = new ShortLinks(undefined, () => 1000);
    const c = links.codeFor("claude:a");
    expect(links.resolve(c)).toEqual({ sessionId: "claude:a" });
    expect(links.resolve("zzzzzzzz")).toBeUndefined();
    expect(links.resolve("../../x")).toBeUndefined();
    expect(links.resolve(42)).toBeUndefined();
    expect(links.resolve(undefined)).toBeUndefined();
  });

  test("the url is the app's #/l/<code>", () => {
    const links = new ShortLinks(undefined, () => 1, () => "Ab3dE6gH");
    expect(links.url("https://tether.example/", "claude:a")).toBe("https://tether.example/#/l/Ab3dE6gH");
    expect(links.url("https://tether.example", "claude:a")).toBe("https://tether.example/#/l/Ab3dE6gH");
  });

  test("expire 7 days after they were last handed out", () => {
    const clock = { t: 1_000_000 };
    const links = new ShortLinks(undefined, () => clock.t);
    const c = links.codeFor("claude:a");
    clock.t += LINK_TTL_MS - 1;
    expect(links.resolve(c)).toEqual({ sessionId: "claude:a" });
    clock.t += 1;
    expect(links.resolve(c)).toBeUndefined();
  });

  test("the same session gets its code again, good for 7 days from the new send", () => {
    const clock = { t: 0 };
    const links = new ShortLinks(undefined, () => clock.t);
    const c = links.codeFor("claude:a");
    clock.t = 6 * DAY;
    expect(links.codeFor("claude:a")).toBe(c);
    clock.t = 12 * DAY;
    expect(links.resolve(c)).toEqual({ sessionId: "claude:a" });
    clock.t = 13 * DAY;
    expect(links.resolve(c)).toBeUndefined();
    // Once expired, a new send makes a new code.
    const d = links.codeFor("claude:a");
    expect(d).not.toBe(c);
    expect(links.resolve(d)).toEqual({ sessionId: "claude:a" });
    expect(links.codeFor("codex:b")).not.toBe(d);
  });

  test("kept across a restart, in a private file; expired ones pruned on load", () => {
    const dir = tmp();
    try {
      const file = join(dir, "links", "links.json");
      const clock = { t: 5_000 };
      const a = new ShortLinks(file, () => clock.t);
      const old = a.codeFor("claude:old");
      clock.t += 3 * DAY;
      const c = a.codeFor("claude:a");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);

      const b = new ShortLinks(file, () => clock.t);
      expect(b.resolve(c)).toEqual({ sessionId: "claude:a" });
      expect(b.resolve(old)).toEqual({ sessionId: "claude:old" });
      expect(b.codeFor("claude:a")).toBe(c);

      clock.t += 5 * DAY;
      const d = new ShortLinks(file, () => clock.t);
      expect(d.size).toBe(1);
      expect(d.resolve(old)).toBeUndefined();
      expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).links)).toEqual([c]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a broken file starts empty", () => {
    const dir = tmp();
    try {
      const file = join(dir, "links.json");
      writeFileSync(file, "{not json");
      expect(new ShortLinks(file).size).toBe(0);
      writeFileSync(file, JSON.stringify({ links: { "bad code!": { sessionId: "x", createdAt: 0, expiresAt: Infinity }, Ab3dE6gH: { sessionId: 5 } } }));
      expect(new ShortLinks(file).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveLink op", () => {
  test("answers with this runner and the session, or null", async () => {
    const ops = new OpRegistry();
    const links = new ShortLinks(undefined, () => 1);
    const c = links.codeFor("claude:a");
    await linksModule.start({ ops, links, runnerId: "box" } as any);
    expect(await ops.handle("resolveLink", { code: c })).toEqual({ ok: true, data: { runnerId: "box", sessionId: "claude:a" } });
    expect(await ops.handle("resolveLink", { code: "nope1234" })).toEqual({ ok: true, data: null });
    expect(await ops.handle("resolveLink", {})).toEqual({ ok: true, data: null });
  });
});

describe("texting", () => {
  test("a text's link is the short one", async () => {
    const texts: string[] = [];
    const open: OpenLink = async () => ({ send: async (t) => (texts.push(t), "m1"), closed: new Promise(() => {}), stop: async () => {} });
    const links = new ShortLinks(undefined, () => 1, () => "Ab3dE6gH");
    const t = new Texter(
      {
        log: () => {},
        runnerId: "box",
        appUrl: "https://tether.example/",
        links,
        session: () => ({ summary: { id: "claude:a", projectPath: "/p" }, status: "idle", requests: [], state: { requests: [] } }) as any,
        viewersOf: () => [],
        sessions: { tell: async () => {}, answer: async () => {} },
      },
      new TextingStore(undefined, { TETHER_PHOTON_PROJECT_ID: "p", TETHER_PHOTON_PROJECT_SECRET: "s-0123456789", TETHER_TEXT_PHONE: "+13105551234" }),
      open,
      () => 1_000_000,
    );
    await t.start();
    await t.turnEnded("claude:a", "boom");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toEndWith("\nhttps://tether.example/#/l/Ab3dE6gH");
    expect(links.resolve("Ab3dE6gH")).toEqual({ sessionId: "claude:a" });
  });
});
