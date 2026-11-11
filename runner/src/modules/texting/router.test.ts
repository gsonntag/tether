import { describe, expect, test } from "bun:test";
import { HELD_MS, HOME, NOTHING_OPEN, OPEN_MS, REPLY_MS, Router, emptyState, toHomeWords } from "./router";
import { TEXTS } from "./texts";

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
    // a number that's part of the message isn't one
    expect(r.route("20 more files")).toMatchObject({ kind: "reply" });
  });

  test("ambiguous plain text: held, picker, then a number sends it", () => {
    const { r, clock } = setup();
    r.stamp("a", "finished", ".");
    clock.tick(3 * 60_000);
    r.stamp("b", "wants to run a command", ".");
    const d = r.route("ship it");
    expect(d).toEqual({ kind: "reply", text: "Which session, by number?\n[1] finished, 3m ago\n[2] wants to run a command, just now" });
    expect(r.route("1")).toMatchObject({ kind: "deliver", sessionId: "a", text: "ship it" });
    // used up
    expect(r.route("1")).toEqual({ kind: "reply", text: "What should I send to [1]?" });
  });

  test("a new plain text replaces the held one; a held one expires", () => {
    const { r, clock } = setup();
    r.stamp("a", "finished", ".");
    r.stamp("b", "finished", ".");
    r.route("first");
    r.route("second");
    expect(r.route("2")).toMatchObject({ text: "second" });
    r.route("third");
    clock.tick(HELD_MS);
    expect(r.route("2")).toMatchObject({ kind: "reply", text: "What should I send to [2]?" });
  });

  test("just a number aims the next text", () => {
    const { r } = setup();
    r.stamp("a", "finished", ".");
    r.stamp("b", "finished", ".");
    r.route("2");
    expect(r.route("rebase on main")).toMatchObject({ kind: "deliver", sessionId: "b", text: "rebase on main" });
    expect(r.route("again")).toMatchObject({ kind: "reply" });
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
    // unknown target: like plain text
    expect(r.route("yes", "zzz")).toMatchObject({ kind: "reply" });
  });

  test("state is plain data: a new router on it goes on", () => {
    const { r, clock } = setup();
    r.stamp("a", "finished", ".");
    r.stamp("b", "finished", ".");
    r.route("held text");
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
    expect(r.route("hm")).toEqual({ kind: "reply", text: "Which session, by number?\n[3] wants to read files, just now" });
    expect(r.route("2")).toMatchObject({ kind: "deliver", sessionId: "b", text: "hm" });
    // a new text puts it back
    r.stamp("a", "finished", ".");
    expect((r.route("x") as any).text).toContain("[1] finished");
  });

});

describe("the Home agent", () => {
  /** Several sessions open, so plain text would otherwise get a picker. */
  const busy = () => {
    const s = setup();
    s.r.stamp("a", "wants to run a command", ".");
    s.r.stamp("b", "finished", ".");
    s.r.noteOut();
    return s;
  };

  test("a prefixed text goes to it, whatever is open, in every form", () => {
    for (const text of ["home: start the login fix", "Home, start the login fix", "@home start the login fix", "[home] start the login fix", "  HOME:start the login fix"]) {
      const { r } = busy();
      expect([text, r.route(text, undefined, true)]).toEqual([text, { kind: "home", text: "start the login fix" }]);
    }
    // Words that only start with "home" aren't addressed to it.
    const { r } = busy();
    expect(r.route("homework is done", undefined, true)).toMatchObject({ kind: "reply" });
    // "home" as its own first word is addressed to it, whatever follows.
    expect(r.route("home is where the tests are", undefined, true)).toEqual({ kind: "home", text: "is where the tests are" });
    expect(r.route("@homer hi", undefined, true)).toMatchObject({ kind: "reply" });
  });

  test("just \"home\": sends the held text there, or aims the next one", () => {
    const { r } = busy();
    expect(r.route("deploy it", undefined, true)).toMatchObject({ kind: "reply" });
    expect(r.route("home", undefined, true)).toEqual({ kind: "home", text: "deploy it" });
    expect(r.route("@home", undefined, true)).toEqual({ kind: "reply", text: TEXTS.whatToSendHome });
    expect(r.route("start the docs fix", undefined, true)).toEqual({ kind: "home", text: "start the docs fix" });
    // Aimed once: the next plain text is back to the usual rules.
    expect(r.route("go on", undefined, true)).toMatchObject({ kind: "reply" });
  });

  test("the picker offers it", () => {
    const { r } = busy();
    const d = r.route("go on", undefined, true);
    expect(d).toMatchObject({ kind: "reply" });
    expect((d as { text: string }).text.split("\n").at(-1)).toBe(TEXTS.homeRow);
    // Not without a Home agent.
    const { r: r2 } = busy();
    expect((r2.route("go on") as { text: string }).text).not.toContain(TEXTS.homeRow);
  });

  test("a threaded reply to a Home text goes to it, even with a session open", () => {
    const { r, clock } = setup();
    expect(r.stampHome("started the login fix in web")).toBe("[home] started the login fix in web");
    r.noteSent("h1", HOME);
    r.noteOut();
    r.stamp("a", "wants to run a command", ".", "req1");
    r.noteSent("s1", "a", "req1");
    r.noteOut();
    clock.tick(1000);
    expect(r.route("also do the docs", "h1", true)).toEqual({ kind: "home", text: "also do the docs" });
    expect(r.route("y", "s1", true)).toMatchObject({ kind: "deliver", sessionId: "a", requestId: "req1" });
    // Without a Home agent (a runner without one now) it says so instead.
    expect(r.route("also", "h1", false)).toEqual({ kind: "reply", text: TEXTS.noHome });
  });

  test("plain text: to it when Tether's last text was the Home agent's, or nothing is open", () => {
    const { r, clock } = setup();
    // Nothing open: the Home agent takes it (without one, the old answer).
    expect(r.route("start a session to fix the login", undefined, true)).toEqual({ kind: "home", text: "start a session to fix the login" });
    expect(r.route("hi", undefined, false)).toEqual({ kind: "reply", text: NOTHING_OPEN });
    // A session texted, then the Home agent did: plain text answers the Home agent.
    r.stamp("a", "finished", ".");
    r.noteOut();
    clock.tick(1000);
    r.stampHome("PR, merge + deploy, or just local changes?");
    r.noteOut();
    expect(r.route("just a PR", undefined, true)).toEqual({ kind: "home", text: "just a PR" });
    // Then a session texts: plain text is that session's again.
    clock.tick(1000);
    r.stamp("a", "asked you something", ".");
    r.noteOut();
    expect(r.route("yes", undefined, true)).toMatchObject({ kind: "deliver", sessionId: "a" });
  });

});

describe("Home/H prefix", () => {
  test("home or h, in any case, as its own first word", () => {
    const yes: [string, string][] = [
      ["home do x", "do x"],
      ["Home do x", "do x"],
      ["HOME do x", "do x"],
      ["hOmE do x", "do x"],
      ["home: do x", "do x"],
      ["Home, do x", "do x"],
      ["home:do x", "do x"],
      ["home , do x", "do x"],
      ["h do x", "do x"],
      ["H do x", "do x"],
      ["H: do x", "do x"],
      ["h:do x", "do x"],
      ["H, do x", "do x"],
      ["h\ndo x", "do x"],
      ["  H   do x", "do x"],
      ["@h do x", "do x"],
      ["[H] do x", "do x"],
      ["@home do x", "do x"],
      ["[home] do x", "do x"],
      ["Home", ""],
      ["home", ""],
      ["HOME", ""],
      ["H", ""],
      ["h", ""],
      ["h:", ""],
      ["Home,", ""],
      [" home ", ""],
    ];
    for (const [text, words] of yes) expect([text, toHomeWords(text)]).toEqual([text, words]);
    const no = ["hey", "hello there", "how's it going", "Homer", "homework is done", "homes", "Hi", "hmm", "h-bomb", "h.", "h/w", "hh do x", "@homer hi", "@hey", "the home page", "oh home", "2 home", "Home-made", "home's fine", "Homepage broke"];
    for (const text of no) expect([text, toHomeWords(text)]).toEqual([text, undefined]);
  });

  test("routes to the Home agent with the prefix and separator taken off", () => {
    for (const [text, words] of [["H: merge it", "merge it"], ["h merge it", "merge it"], ["HOME, merge it", "merge it"]]) {
      const s = setup();
      s.r.stamp("a", "finished", ".");
      s.r.stamp("b", "finished", ".");
      expect(s.r.route(text!, undefined, true)).toEqual({ kind: "home", text: words! });
    }
    // Words that only start with h are plain text: the one open session takes them.
    const { r } = setup();
    r.stamp("a", "finished", ".");
    for (const text of ["hey are you done", "how's it going", "Homer says hi"]) expect(r.route(text, undefined, true)).toMatchObject({ kind: "deliver", sessionId: "a", text });
  });

  test("just H aims the next text at the Home agent; without one it says so", () => {
    const s = setup();
    s.r.stamp("a", "finished", ".");
    s.r.stamp("b", "finished", ".");
    expect(s.r.route("H", undefined, true)).toEqual({ kind: "reply", text: TEXTS.whatToSendHome });
    expect(s.r.route("start the docs fix", undefined, true)).toEqual({ kind: "home", text: "start the docs fix" });
    expect(s.r.route("h do x", undefined, false)).toEqual({ kind: "reply", text: TEXTS.noHome });
  });
});

describe("replying to what was just texted", () => {
  test("a reply soon after a Home text about a session carries that session", () => {
    const { r, clock } = setup();
    r.stampHome("PR #4 is up, merge it?", "claude:x");
    clock.tick(5 * 60_000);
    expect(r.route("yes merge it", undefined, true)).toEqual({ kind: "home", text: "yes merge it", about: { sessionId: "claude:x", byHome: true } });
    // Addressed to the Home agent explicitly: still its text being answered.
    expect(r.route("h and deploy", undefined, true)).toEqual({ kind: "home", text: "and deploy", about: { sessionId: "claude:x", byHome: true } });
  });

  test("outside the window: no session goes with it", () => {
    const { r, clock } = setup();
    r.stampHome("PR #4 is up, merge it?", "claude:x");
    clock.tick(REPLY_MS);
    expect(r.route("yes merge it", undefined, true)).toEqual({ kind: "home", text: "yes merge it" });
  });

  test("no earlier text, or a Home text about nothing in particular: as before", () => {
    const { r } = setup();
    expect(r.route("start a fix", undefined, true)).toEqual({ kind: "home", text: "start a fix" });
    r.stampHome("PR #4 is up", "claude:x");
    r.stampHome("ok, on it");
    expect(r.route("thanks", undefined, true)).toEqual({ kind: "home", text: "thanks" });
  });

  test("a number names its own target: the session text goes straight there, nothing carried", () => {
    const { r, clock } = setup();
    r.stamp("a", "finished", ".");
    clock.tick(1000);
    r.stampHome("PR #4 is up, merge it?", "claude:x");
    expect(r.route("1 run the tests too", undefined, true)).toEqual({ kind: "deliver", sessionId: "a", n: 1, text: "run the tests too" });
  });

  test("a session texting since turns the reply to it; Home addressed after that carries nothing", () => {
    const { r, clock } = setup();
    r.stampHome("PR #4 is up, merge it?", "claude:x");
    clock.tick(1000);
    r.stamp("a", "wants to run a command", ".", "r1");
    expect(r.route("y", undefined, true)).toMatchObject({ kind: "deliver", sessionId: "a" });
    expect(r.route("home: what's running?", undefined, true)).toEqual({ kind: "home", text: "what's running?" });
  });

  test("a threaded reply to a Home text carries its session however old it is", () => {
    const { r, clock } = setup();
    r.stampHome("PR #4 is up, merge it?", "claude:x");
    r.noteSent("h1", HOME, undefined, "claude:x");
    clock.tick(REPLY_MS * 3);
    r.stampHome("ok, on it");
    r.noteSent("h2", HOME);
    expect(r.route("merge it", "h1", true)).toEqual({ kind: "home", text: "merge it", about: { sessionId: "claude:x", byHome: true } });
    expect(r.route("thanks", "h2", true)).toEqual({ kind: "home", text: "thanks" });
  });

  test("the held text goes to the Home agent with the session it answers", () => {
    const { r } = setup();
    r.stamp("a", "finished", ".");
    r.stamp("b", "finished", ".");
    r.stampHome("PR #4 is up, merge it?", "claude:x");
    // Plain text after a Home text answers the Home agent anyway.
    expect(r.route("go", undefined, true)).toEqual({ kind: "home", text: "go", about: { sessionId: "claude:x", byHome: true } });
  });

  test("kept in the state, so it outlives a restart", () => {
    const { r, clock } = setup();
    r.stampHome("PR #4 is up, merge it?", "claude:x");
    const again = new Router(JSON.parse(JSON.stringify(r.state)), () => clock.now() + 60_000);
    expect(again.route("merge", undefined, true)).toEqual({ kind: "home", text: "merge", about: { sessionId: "claude:x", byHome: true } });
  });
});
