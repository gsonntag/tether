import { describe, expect, test } from "bun:test";
import { HELD_MS, NOTHING_OPEN, OPEN_MS, Router, emptyState, type Ticked } from "./router";
import { casualText, TEXTS } from "./texts";

/** Two sessions that may text ("Session can text me"), most recent first: the picker offers them when none is open. */
const T: Ticked[] = [{ sessionId: "a", label: "login fix" }, { sessionId: "b", label: "docs" }];

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, tick: (ms: number) => (t += ms) };
  const r = new Router(emptyState(), clock.now);
  return { r, clock };
}

describe("numbers", () => {
  test("lowest free, kept per session, freed after OPEN_MS", () => {
    const { r, clock } = setup();
    expect(r.stamp("a", "finished", "Finished.")).toEqual({ n: 1, text: "[1] Finished." });
    expect(r.stamp("b", "finished", "Finished.").n).toBe(2);
    expect(r.stamp("a", "failed", "Failed.").n).toBe(1);
    clock.tick(OPEN_MS - 1);
    r.stamp("b", "finished", "Finished.");
    clock.tick(2);
    // a expired, b was texted again; a new session takes 1
    expect(r.open().map((s) => s.sessionId)).toEqual(["b"]);
    expect(r.stamp("c", "finished", "Finished.").n).toBe(1);
  });

  test("nine at most: the oldest gives its number up", () => {
    const { r, clock } = setup();
    for (let i = 1; i <= 9; i++) (r.stamp(`s${i}`, "finished", "."), clock.tick(1000));
    expect(r.stamp("s10", "finished", ".").n).toBe(1);
    expect(r.open().map((s) => s.sessionId)).not.toContain("s1");
  });
});

describe("replies", () => {
  test("nothing open", () => {
    const { r } = setup();
    expect(r.route("hi")).toEqual({ kind: "reply", text: NOTHING_OPEN });
    expect(r.route("   ")).toEqual({ kind: "none" });
  });

  test("one open session takes plain text", () => {
    const { r } = setup();
    r.stamp("a", "finished", "Finished.");
    expect(r.route("also run the tests")).toMatchObject({ kind: "deliver", sessionId: "a", n: 1, text: "also run the tests" });
  });

  test("number forms", () => {
    const { r } = setup();
    r.stamp("a", "finished", ".");
    r.stamp("b", "finished", ".");
    for (const [msg, text] of [["2 do it", "do it"], ["[2] do it", "do it"], ["2: do it", "do it"], ["(2) do it", "do it"], ["2. do it", "do it"]])
      expect(r.route(msg!)).toMatchObject({ kind: "deliver", sessionId: "b", text });
    // a number that's part of the message isn't one: plain text, to the session last texted or answered
    expect(r.route("20 more files")).toMatchObject({ kind: "deliver", sessionId: "b", text: "20 more files" });
  });

  test("several open: plain text goes to the one last texted or answered", () => {
    const { r, clock } = setup();
    r.stamp("a", "finished", ".");
    clock.tick(3 * 60_000);
    r.stamp("b", "wants to run a command", ".");
    expect(r.route("ship it")).toMatchObject({ kind: "deliver", sessionId: "b", text: "ship it" });
    clock.tick(1000);
    // Answering a by number makes it the one plain text goes to.
    expect(r.route("1 and the docs")).toMatchObject({ kind: "deliver", sessionId: "a" });
    clock.tick(1000);
    expect(r.route("thanks")).toMatchObject({ kind: "deliver", sessionId: "a", text: "thanks" });
  });

  test("none open: held, a picker of the sessions that may text, then a number sends it", () => {
    const { r } = setup();
    const d = r.route("ship it", undefined, undefined, T);
    expect(d).toEqual({ kind: "reply", text: "Which session, by number?\n[1] login fix\n[2] docs" });
    // Offered numbers aren't texts: plain text again asks again (the newer words held).
    expect(r.route("ship it now", undefined, undefined, T)).toMatchObject({ kind: "reply", text: expect.stringContaining(TEXTS.which) });
    expect(r.route("1")).toMatchObject({ kind: "deliver", sessionId: "a", text: "ship it now" });
    // used up; picked, it's the one plain text goes to now
    expect(r.route("1")).toEqual({ kind: "reply", text: "What should I send to [1]?" });
    expect(r.route("go on", undefined, undefined, T)).toMatchObject({ kind: "deliver", sessionId: "a", text: "go on" });
  });

  test("none open and none may text: says so", () => {
    const { r } = setup();
    expect(r.route("hi", undefined, undefined, [])).toEqual({ kind: "reply", text: TEXTS.noTexters });
    expect(casualText(TEXTS.noTexters)).toBe(true);
    expect(r.route("hi", undefined, undefined, T)).toMatchObject({ kind: "reply", text: expect.stringContaining(TEXTS.which) });
  });

  test("a new plain text replaces the held one; a held one expires", () => {
    const { r, clock } = setup();
    r.route("first", undefined, undefined, T);
    r.route("second", undefined, undefined, T);
    expect(r.route("2")).toMatchObject({ text: "second" });
    r.route("5 third");
    expect(r.state.held?.text).toBe("third");
    clock.tick(HELD_MS);
    expect(r.route("2")).toMatchObject({ kind: "reply", text: "What should I send to [2]?" });
  });

  test("just a number aims the next text", () => {
    const { r } = setup();
    r.stamp("a", "finished", ".");
    r.stamp("b", "finished", ".");
    r.route("1");
    expect(r.route("rebase on main")).toMatchObject({ kind: "deliver", sessionId: "a", text: "rebase on main" });
    // Aimed once: then plain text goes to the one last answered (a, just now).
    expect(r.route("again")).toMatchObject({ kind: "deliver", sessionId: "a", text: "again" });
  });

  test("a number that isn't open: says so, holds the text, shows the picker", () => {
    const { r } = setup();
    r.stamp("a", "finished", ".");
    r.stamp("b", "finished", ".");
    expect((r.route("7 do it") as any).text).toStartWith("[7] isn't waiting on a reply, which one did you mean?\n[");
    expect(r.route("1")).toMatchObject({ sessionId: "a", text: "do it" });
  });

  test("a threaded reply goes to its text's session", () => {
    const { r } = setup();
    r.stamp("a", "finished", ".");
    r.noteSent("m1", "a");
    r.stamp("b", "finished", ".");
    r.noteSent("m2", "b");
    expect(r.route("yes", "m1")).toMatchObject({ kind: "deliver", sessionId: "a" });
    // unknown target: never plain routing (a "y" mustn't approve the wrong request): the picker
    expect(r.route("yes", "zzz")).toMatchObject({ kind: "reply", text: expect.stringContaining(TEXTS.threadNotWaiting) });
    expect(r.route("1")).toMatchObject({ kind: "deliver", sessionId: "a", text: "yes" });
  });

  test("state is plain data: a new router on it goes on", () => {
    const { r, clock } = setup();
    r.route("held text", undefined, undefined, T);
    const again = new Router(JSON.parse(JSON.stringify(r.state)), clock.now);
    expect(again.route("2")).toMatchObject({ sessionId: "b", text: "held text" });
  });
});

describe("threads", () => {
  test("a threaded reply goes to the session whose text it answers, a reply to anything else is Tether's too", () => {
    const { r } = setup();
    r.stamp("a", "finished", ".");
    r.noteSent("t1", "a");
    r.stamp("b", "finished", ".");
    expect(r.route("yes", "t1")).toMatchObject({ kind: "deliver", sessionId: "a" });
    // Not one of Tether's texts (gone, or never Tether's): Tether still owns it and asks which session.
    expect(r.route("yes", "tm1")).toMatchObject({ kind: "reply" });
  });

  test("answered sessions leave the picker; a number still reaches them", () => {
    const { r } = setup();
    r.stamp("a", "finished", ".");
    r.stamp("b", "asked you something", ".");
    r.stamp("c", "wants to read files", ".");
    expect(r.route("1 ok")).toMatchObject({ kind: "deliver", sessionId: "a" });
    r.settle("b");
    expect(r.route("7 hm")).toEqual({ kind: "reply", text: "[7] isn't waiting on a reply, which one did you mean?\n[3] wants to read files, just now" });
    expect(r.route("2")).toMatchObject({ kind: "deliver", sessionId: "b", text: "hm" });
    // a new text puts it back
    r.stamp("a", "finished", ".");
    expect((r.route("7 x") as any).text).toContain("[1] finished");
  });

});

describe("no Home agent", () => {
  test("h, home and the old home commands are plain words for the sessions", () => {
    const { r } = setup();
    r.stamp("a", "finished", ".");
    for (const text of ["h do x", "home: merge it", "hn logo", "hd1", "[h] hi", "H"]) expect(r.route(text)).toMatchObject({ kind: "deliver", sessionId: "a", text });
  });

  test("a threaded reply to an old Home agent text (from before) asks which session", () => {
    const { r } = setup();
    r.stamp("a", "finished", ".");
    r.state.sent.push({ id: "old", sessionId: "home" });
    expect(r.route("yes", "old")).toMatchObject({ kind: "reply", text: expect.stringContaining(TEXTS.threadNotWaiting) });
  });

  test("a text that takes over a held one carries its id; with none held, nothing is carried", () => {
    const { r } = setup();
    expect(r.route("(image)", undefined, undefined, T)).toMatchObject({ kind: "reply" });
    const id = r.state.held!.id!;
    expect(r.route("2 what is wrong here")).toEqual({ kind: "deliver", sessionId: "b", n: 2, text: "what is wrong here", held: id });
    expect(r.route("2 again")).toEqual({ kind: "deliver", sessionId: "b", n: 2, text: "again" });
    // "5 do x" with no 5: held, with an id.
    expect(r.route("5 do x")).toMatchObject({ kind: "reply" });
    expect(r.state.held).toMatchObject({ text: "do x", id: id + 1 });
  });
});

describe("the \"Session can text me\" box", () => {
  test("the picker offers only the sessions that may text, as many as there are free numbers, next to open ones", () => {
    const { r } = setup();
    const many: Ticked[] = Array.from({ length: 12 }, (_, i) => ({ sessionId: `s${i}`, label: `S${i}` }));
    expect((r.route("hi", undefined, undefined, many) as { text: string }).text.split("\n").length).toBe(1 + 9);
    // A number that isn't open, with sessions open: just the open ones.
    const { r: r2 } = setup();
    r2.stamp("a", "finished", ".");
    r2.settle("a");
    expect(r2.route("5 hi", undefined, undefined, T)).toEqual({ kind: "reply", text: "[5] isn't waiting on a reply, which one did you mean?\n[1] finished, just now" });
    // Nothing open: the number's text is held, and the ones that may text are offered.
    const { r: r3 } = setup();
    expect(r3.route("5 hi", undefined, undefined, T)).toEqual({ kind: "reply", text: "Which session, by number?\n[1] login fix\n[2] docs" });
    expect(r3.route("2")).toMatchObject({ kind: "deliver", sessionId: "b", text: "hi" });
  });

  test("unticking drops its number: a text to it says it can't text, plain text goes to another, the number is free again", () => {
    const { r, clock } = setup();
    r.stamp("a", "finished", ".");
    r.noteSent("m1", "a");
    clock.tick(1000);
    r.stamp("b", "asked you something", ".");
    r.noteSent("m2", "b");
    r.route("2");
    expect(r.drop("b")).toBe(true);
    expect(r.drop("b")).toBe(false);
    expect(r.open().map((s) => s.sessionId)).toEqual(["a"]);
    // Aimed at it: no more.
    expect(r.state.aimed).toBeUndefined();
    expect(r.route("2 go on")).toEqual({ kind: "reply", text: TEXTS.cantText(2) });
    expect(r.route("go on", "m2")).toEqual({ kind: "reply", text: TEXTS.cantText(2) });
    expect(casualText(TEXTS.cantText(2))).toBe(true);
    expect(r.route("go on")).toMatchObject({ kind: "deliver", sessionId: "a" });
    // Its number is the next new one's: then it's that session's, not "can't text".
    expect(r.stamp("c", "finished", ".").n).toBe(2);
    expect(r.route("2 hi")).toMatchObject({ kind: "deliver", sessionId: "c", text: "hi" });
  });

  test("ticked again, its old number is just a free number; the muted list expires", () => {
    const { r, clock } = setup();
    r.stamp("a", "finished", ".");
    r.stamp("b", "finished", ".");
    r.drop("b");
    r.allow("b");
    expect((r.route("2 hi") as { text: string }).text).toStartWith(TEXTS.notWaiting(2).split(",")[0]!);
    r.drop("a");
    clock.tick(OPEN_MS);
    expect(r.route("1 hi")).toMatchObject({ kind: "reply", text: NOTHING_OPEN });
  });
});

describe("a \"y\" mustn't approve the wrong request", () => {
  test("a threaded y on an expired session's text never goes to the session texted last, nor carries its request", () => {
    const { r, clock } = setup();
    r.stamp("a", "wants to run a command", ".", "reqA");
    r.noteSent("tA", "a", "reqA");
    clock.tick(OPEN_MS - 1000);
    r.stamp("b", "wants to run a command", ".", "reqB");
    r.noteSent("tB", "b", "reqB");
    clock.tick(2000);
    // a's slot expired; b's request is open.
    expect(r.open().map((s) => s.sessionId)).toEqual(["b"]);
    const d = r.route("y", "tA");
    expect(d).toEqual({ kind: "reply", text: `${TEXTS.threadNotWaiting}\n[2] wants to run a command, just now` });
    // Plain y still goes to b (its own request); a thread on b's text too.
    expect(r.route("y", "tB")).toMatchObject({ kind: "deliver", sessionId: "b", requestId: "reqB" });
    expect(casualText(TEXTS.threadNotWaiting)).toBe(true);
  });

  test("a plain y with two requests open asks which, instead of approving the latest", () => {
    const { r, clock } = setup();
    r.stamp("a", "wants to run a command", ".", "reqA");
    clock.tick(1000);
    r.stamp("b", "wants to edit a file", ".", "reqB");
    const d = r.route("y");
    expect(d.kind).toBe("reply");
    expect((d as { text: string }).text).toContain("[1] wants to run a command");
    expect((d as { text: string }).text).toContain("[2] wants to edit a file");
    // The pick then carries the held y to that session's own request.
    expect(r.route("1")).toMatchObject({ kind: "deliver", sessionId: "a", requestId: "reqA", text: "y" });
  });
});
