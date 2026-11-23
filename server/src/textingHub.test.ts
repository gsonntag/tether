// The texting hub through the relay (SPEC §11 Texting): which runner each one texts through, and
// frames passed only between a runner and its hub.

import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, type RunnerInfo } from "../../shared/protocol";
import { Relay, type Socket } from "./relay";

class FakeSocket implements Socket {
  sent: any[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
    return 1;
  }
  close() {}
  take(t: string) {
    const out = this.sent.filter((m) => m.t === t);
    this.sent = [];
    return out;
  }
}

const info = (id: string, hub?: { up: boolean; images?: boolean; lines?: string[] }): Omit<RunnerInfo, "connectedAt"> => ({ id, name: id, hostname: "h", version: "0", protocol: PROTOCOL_VERSION, harnesses: [], ...(hub ? { textingHub: { up: hub.up, images: !!hub.images, ...(hub.lines ? { lines: hub.lines } : {}) } } : {}) });

function setup(owners?: Map<string, Set<string>>) {
  let now = 1000;
  const relay = new Relay({ now: () => now++, owners: owners ?? null });
  const socks = new Map<string, FakeSocket>();
  const join = (id: string, hub?: { up: boolean; images?: boolean; lines?: string[] }, token = "runner") => {
    const s = socks.get(id) ?? new FakeSocket();
    if (!socks.has(id)) relay.addRunner(s, token);
    socks.set(id, s);
    relay.onRunnerMessage(s, { t: "hello", runner: info(id, hub) });
    return s;
  };
  return { relay, socks, join };
}

describe("the texting hub", () => {
  test("each runner is told its hub when one connects, changes or goes; the hub itself is told none", () => {
    const { relay, join } = setup();
    const aws = join("aws");
    expect(aws.take("textHub")).toEqual([]);
    const dev = join("dev", { up: true, images: true });
    expect(aws.take("textHub")).toEqual([{ t: "textHub", hub: { id: "dev", name: "dev", up: true, images: true } }]);
    expect(dev.take("textHub")).toEqual([]);
    // Can't text now: the spoke hears so; the same again says nothing.
    join("dev", { up: false });
    expect(aws.take("textHub")).toEqual([{ t: "textHub", hub: { id: "dev", name: "dev", up: false, images: false } }]);
    join("dev", { up: false });
    expect(aws.take("textHub")).toEqual([]);
    // A runner that connects later is told at once.
    const box = join("box");
    expect(box.take("textHub")).toEqual([{ t: "textHub", hub: { id: "dev", name: "dev", up: false, images: false } }]);
    relay.removeRunner(dev);
    expect(aws.take("textHub")).toEqual([{ t: "textHub", hub: null }]);
  });

  test("of two hubs, the one that can text wins, then the longest connected", () => {
    const { join } = setup();
    const aws = join("aws");
    join("a", { up: false });
    join("b", { up: true });
    expect(aws.take("textHub").at(-1).hub.id).toBe("b");
    join("c", { up: true });
    expect(aws.take("textHub")).toEqual([]);
  });

  test("frames pass only between a runner and its hub; a call to anyone else is answered offline", () => {
    const { relay, join } = setup();
    const aws = join("aws");
    const dev = join("dev", { up: true });
    const other = join("other");
    for (const s of [aws, dev, other]) s.sent = [];
    relay.onRunnerMessage(aws, { t: "texting", to: "dev", m: { k: "req", rid: "1", op: "send", args: { text: "hi" } } });
    expect(dev.take("texting")).toEqual([{ t: "texting", from: "aws", m: { k: "req", rid: "1", op: "send", args: { text: "hi" } } }]);
    relay.onRunnerMessage(dev, { t: "texting", to: "aws", m: { k: "res", rid: "1", ok: true } });
    expect(aws.take("texting")).toEqual([{ t: "texting", from: "dev", m: { k: "res", rid: "1", ok: true } }]);
    // A spoke can't reach another spoke, nor a runner that isn't there.
    relay.onRunnerMessage(aws, { t: "texting", to: "other", m: { k: "req", rid: "2", op: "deliver", args: {} } });
    relay.onRunnerMessage(aws, { t: "texting", to: "gone", m: { k: "chunk", x: "x", i: 0, data: "" } });
    expect(other.take("texting")).toEqual([]);
    expect(aws.take("texting")).toEqual([{ t: "texting", from: "other", m: { k: "res", rid: "2", ok: false, error: "That computer is offline." } }]);
  });

  test("with an owner map, only the same person's runners share a hub", () => {
    const owners = new Map([
      ["runner-a", new Set(["a@x"])],
      ["runner-a2", new Set(["a@x"])],
      ["runner-b", new Set(["b@x"])],
    ]);
    const { join } = setup(owners);
    const mine = join("runner-a2", undefined, "runner-a2");
    const theirs = join("runner-b", undefined, "runner-b");
    join("runner-a", { up: true }, "runner-a");
    expect(mine.take("textHub").at(-1).hub.id).toBe("runner-a");
    expect(theirs.take("textHub")).toEqual([]);
  });

  test("a hub's lines go to its spokes; of two hubs holding one line, the lower id texts for the other", () => {
    const { join } = setup();
    const L = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const aws = join("aws");
    const b = join("b", { up: true, lines: [L] });
    expect(aws.take("textHub")).toEqual([{ t: "textHub", hub: { id: "b", name: "b", up: true, images: false, lines: [L] } }]);
    // Another hub on another line: each stays its own.
    const c = join("c", { up: true, lines: ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] });
    expect(b.take("textHub")).toEqual([]);
    expect(c.take("textHub")).toEqual([]);
    // One on the same line, with a lower id: it texts for the other, whichever can text now.
    const a = join("a", { up: false, lines: [L] });
    expect(a.take("textHub")).toEqual([]);
    expect(b.take("textHub")).toEqual([{ t: "textHub", hub: { id: "a", name: "a", up: false, images: false, lines: [L] } }]);
    join("a", { up: true, lines: [L] });
    expect(b.take("textHub").at(-1).hub).toMatchObject({ id: "a", up: true });
    // It let the line go (another project now): the other is its own hub again.
    join("a", { up: true, lines: ["cccccccccccccccccccccccccccccccc"] });
    expect(b.take("textHub")).toEqual([{ t: "textHub", hub: null }]);
  });
});
