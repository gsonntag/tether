import { describe, expect, test } from "bun:test";
import { HELD_MS, HOME, NOTHING_OPEN, OPEN_MS, Router, emptyState } from "./router";
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

describe("sharing the thread with textme", () => {
  const waiter = (sentAt: number, id?: string) => ({ pid: 1, sentAt, until: sentAt + 5 * 60_000, ...(id ? { id } : {}) });

  test("plain text after a newer textme text: none; numbers for open sessions still Tether's", () => {
    const { r, clock } = setup();
    r.stamp("a", "finished", ".");
    r.stamp("b", "finished", ".");
    r.noteOut();
    clock.tick(1000);
    const w = [waiter(clock.now())];
    expect(r.route("no", undefined, w)).toEqual({ kind: "none" });
    expect(r.route("20 more files", undefined, w)).toEqual({ kind: "none" });
    expect(r.route("7 do it", undefined, w)).toEqual({ kind: "none" });
    expect(r.route("2 do it", undefined, w)).toMatchObject({ kind: "deliver", sessionId: "b", text: "do it" });
    expect(r.state.held).toBeUndefined();
  });

  test("Tether texted after the textme: plain text is Tether's", () => {
    const { r, clock } = setup();
    const w = [waiter(clock.now())];
    clock.tick(1000);
    r.stamp("a", "finished", ".");
    r.noteOut();
    expect(r.route("go on", undefined, w)).toMatchObject({ kind: "deliver", sessionId: "a" });
  });

  test("a threaded reply goes to whoever sent the message it answers", () => {
    const { r, clock } = setup();
    r.stamp("a", "finished", ".");
    r.noteSent("t1", "a");
    r.noteOut();
    clock.tick(1000);
    const w = [waiter(clock.now(), "tm1")];
    expect(r.route("yes", "t1", w)).toMatchObject({ kind: "deliver", sessionId: "a" });
    clock.tick(1000);
    r.noteOut();
    expect(r.route("yes", "tm1", w)).toEqual({ kind: "none" });
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

  test("note: last text, open numbers with their deadline, sent ids", () => {
    const { r, clock } = setup();
    r.stamp("a", "finished", ".");
    r.noteSent("t1", "a");
    r.noteOut();
    expect(r.note()).toEqual({ lastOut: clock.now(), open: [{ n: 1, until: clock.now() + OPEN_MS }], sent: ["t1"] });
  });
});

describe("a textme's tag", () => {
  test("a reply starting with a waiting textme's tag is its, even when Tether texted last", () => {
    const { r, clock } = setup();
    const w = [{ pid: 1, sentAt: clock.now(), until: clock.now() + 60_000, tag: "foliation" }];
    clock.tick(1000);
    r.stamp("a", "finished", ".");
    r.noteOut();
    expect(r.route("[foliation] no", undefined, w)).toEqual({ kind: "none" });
    expect(r.route("Foliation: no", undefined, w)).toEqual({ kind: "none" });
    expect(r.route("foliations are cool", undefined, w)).toMatchObject({ kind: "deliver" });
  });
});

describe("the Home agent", () => {
  const waiter = (sentAt: number, id?: string, tag?: string) => ({ pid: 1, sentAt, until: sentAt + 5 * 60_000, ...(id ? { id } : {}), ...(tag ? { tag } : {}) });
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
      expect([text, r.route(text, undefined, [], true)]).toEqual([text, { kind: "home", text: "start the login fix" }]);
    }
    // Words that only start with "home" aren't addressed to it.
    const { r } = busy();
    expect(r.route("homework is done", undefined, [], true)).toMatchObject({ kind: "reply" });
    expect(r.route("home is where the tests are", undefined, [], true)).toMatchObject({ kind: "reply" });
    expect(r.route("@homer hi", undefined, [], true)).toMatchObject({ kind: "reply" });
  });

  test("just \"home\": sends the held text there, or aims the next one", () => {
    const { r } = busy();
    expect(r.route("deploy it", undefined, [], true)).toMatchObject({ kind: "reply" });
    expect(r.route("home", undefined, [], true)).toEqual({ kind: "home", text: "deploy it" });
    expect(r.route("@home", undefined, [], true)).toEqual({ kind: "reply", text: TEXTS.whatToSendHome });
    expect(r.route("start the docs fix", undefined, [], true)).toEqual({ kind: "home", text: "start the docs fix" });
    // Aimed once: the next plain text is back to the usual rules.
    expect(r.route("go on", undefined, [], true)).toMatchObject({ kind: "reply" });
  });

  test("the picker offers it", () => {
    const { r } = busy();
    const d = r.route("go on", undefined, [], true);
    expect(d).toMatchObject({ kind: "reply" });
    expect((d as { text: string }).text.split("\n").at(-1)).toBe(TEXTS.homeRow);
    // Not without a Home agent.
    const { r: r2 } = busy();
    expect((r2.route("go on") as { text: string }).text).not.toContain(TEXTS.homeRow);
  });

  test("a threaded reply to a Home text goes to it, even with a session open and a textme texting later", () => {
    const { r, clock } = setup();
    expect(r.stampHome("started the login fix in web")).toBe("[home] started the login fix in web");
    r.noteSent("h1", HOME);
    r.noteOut();
    r.stamp("a", "wants to run a command", ".", "req1");
    r.noteSent("s1", "a", "req1");
    r.noteOut();
    clock.tick(1000);
    const w = [waiter(clock.now(), "tm1")];
    expect(r.route("also do the docs", "h1", w, true)).toEqual({ kind: "home", text: "also do the docs" });
    expect(r.route("y", "s1", w, true)).toMatchObject({ kind: "deliver", sessionId: "a", requestId: "req1" });
    // The Home text's id is published: textme leaves a threaded reply to it alone.
    expect(r.note().sent).toEqual(["h1", "s1"]);
    // Without a Home agent (a runner without one now) it says so instead.
    expect(r.route("also", "h1", [], false)).toEqual({ kind: "reply", text: TEXTS.noHome });
  });

  test("plain text: to it when Tether's last text was the Home agent's, or nothing is open", () => {
    const { r, clock } = setup();
    // Nothing open: the Home agent takes it (without one, the old answer).
    expect(r.route("start a session to fix the login", undefined, [], true)).toEqual({ kind: "home", text: "start a session to fix the login" });
    expect(r.route("hi", undefined, [], false)).toEqual({ kind: "reply", text: NOTHING_OPEN });
    // A session texted, then the Home agent did: plain text answers the Home agent.
    r.stamp("a", "finished", ".");
    r.noteOut();
    clock.tick(1000);
    r.stampHome("PR, merge + deploy, or just local changes?");
    r.noteOut();
    expect(r.route("just a PR", undefined, [], true)).toEqual({ kind: "home", text: "just a PR" });
    // Then a session texts: plain text is that session's again.
    clock.tick(1000);
    r.stamp("a", "asked you something", ".");
    r.noteOut();
    expect(r.route("yes", undefined, [], true)).toMatchObject({ kind: "deliver", sessionId: "a" });
  });

  test("a textme that texted after Tether: plain and prefixed texts are its (as textme reads them), so nothing is taken twice", () => {
    const { r, clock } = setup();
    r.stampHome("ok, on it");
    r.noteOut();
    clock.tick(1000);
    const w = [waiter(clock.now(), "tm1")];
    expect(r.route("sure", undefined, w, true)).toEqual({ kind: "none" });
    expect(r.route("home: start x", undefined, w, true)).toEqual({ kind: "none" });
    // Tether texts again: it's Tether's, and so the Home agent's.
    clock.tick(1000);
    r.stampHome("started x in web");
    r.noteOut();
    expect(r.route("home: and y", undefined, w, true)).toEqual({ kind: "home", text: "and y" });
    expect(r.route("thanks", undefined, w, true)).toEqual({ kind: "home", text: "thanks" });
  });

  test("a textme's tag wins over the Home agent, even when Tether texted last", () => {
    const { r, clock } = setup();
    const w = [waiter(clock.now(), "tm1", "home")];
    clock.tick(1000);
    r.stampHome("ok");
    r.noteOut();
    expect(r.route("[home] that's mine", undefined, w, true)).toEqual({ kind: "none" });
  });

  test("each text has exactly one owner: Tether (a session or the Home agent), or textme", () => {
    // textme's own rule (github.com/gsonntag/text-me scripts/thread.ts `owns`), restated: a
    // threaded reply is its sender's; a waiting textme's tag is that textme's; a number for an open
    // Tether session is Tether's; anything else is whoever texted last.
    const textmeOwns = (r: Router, w: ReturnType<typeof waiter>, text: string, replyTo: string | undefined, now: number) => {
      if (replyTo) {
        if (replyTo === w.id) return true;
        if (r.state.sent.some((x) => x.id === replyTo)) return false;
      }
      const t = text.trim().toLowerCase().replace(/^\[\s*/, "");
      if (w.tag && t.startsWith(w.tag) && /^($|[\s\]:,.-])/.test(t.slice(w.tag.length))) return true;
      const n = /^[[(]?\s*([1-9])\s*[\])]?(?=$|[\s:.,)\]-])/.exec(text.trim());
      if (n && r.note().open.some((o) => o.n === Number(n[1]) && o.until > now)) return false;
      return w.sentAt >= (r.state.lastOut ?? 0);
    };
    const texts: [string, string | undefined][] = [
      ["home: start x", undefined],
      ["thanks", undefined],
      ["1 y", undefined],
      ["y", "s1"],
      ["more", "h1"],
      ["mine", "tm1"],
      ["[app] mine", undefined],
    ];
    for (const textmeLast of [false, true]) {
      for (const [text, replyTo] of texts) {
        const { r, clock } = setup();
        const early = clock.now();
        clock.tick(1000);
        r.stamp("a", "wants to run a command", ".", "req1");
        r.noteSent("s1", "a", "req1");
        r.stampHome("ok, on it");
        r.noteSent("h1", HOME);
        r.noteOut();
        clock.tick(1000);
        const w = waiter(textmeLast ? clock.now() : early, "tm1", "app");
        const tether = r.route(text, replyTo, [w], true).kind !== "none";
        const textme = textmeOwns(r, w, text, replyTo, clock.now());
        expect([textmeLast, text, tether, textme]).toEqual([textmeLast, text, !textme, textme]);
      }
    }
  });
});
