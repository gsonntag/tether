import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../../credentials";
import type { Request, RequestAnswer } from "../../../../shared/transcript";
import { REQUEST_MAX } from "./describe";
import { commandWords } from "./summary";
import { AGENT_TEXT_MAX, AGENT_TEXT_MS, asksQuestion, LINK_EVERY_MS, Texter } from ".";
import { casualText, OK, TEXTS } from "./texts";
import { inboundOf, type Inbound, type OpenLink } from "./link";
import { normalPhone, TextingStore } from "./store";
import { HomeLine, PERSON_TEXT_MAX } from "../homeLine";

const ENV = { TETHER_PHOTON_PROJECT_ID: "proj", TETHER_PHOTON_PROJECT_SECRET: "sec-0123456789", TETHER_TEXT_PHONE: "+13105551234" };

const LINK = "https://tether.example/#/s/box/";

function setup(viewers: Record<string, string[]> = {}, homeLine?: HomeLine) {
  const clock = { t: 1_000_000 };
  const texts: string[] = [];
  let n = 0;
  const open: OpenLink = async () => {
    return { send: async (t) => (texts.push(t), `m${++n}`), closed: new Promise(() => {}), stop: async () => {} };
  };
  const sessions: Record<string, any> = {
    "claude:a": { summary: { id: "claude:a", title: "secret plans", projectPath: "/home/me/web" }, status: "idle", requests: [], state: { requests: [] } },
    "codex:b": { summary: { id: "codex:b", projectPath: "/home/me/api" }, status: "idle", requests: [], state: { requests: [] } },
  };
  const told: [string, string][] = [];
  const answered: [string, string, RequestAnswer][] = [];
  const t = new Texter(
    {
      log: () => {},
      runnerId: "box",
      appUrl: "https://tether.example/",
      homeLine,
      session: (id) => sessions[id],
      viewersOf: (id) => viewers[id] ?? [],
      sessions: { tell: async (id, text) => void told.push([id, text]), answer: async (id, r, a) => void answered.push([id, r, a]) },
    },
    new TextingStore(undefined, ENV),
    open,
    () => clock.t,
  );
  const say = (id: string, text: string) => t.said(id, { id: "x", role: "assistant", ts: 1, parts: [{ type: "text", text }] });
  const open1 = (id: string, r: Request) => {
    sessions[id].requests = [r.id];
    sessions[id].state.requests = [r];
    return t.request(r);
  };
  return { t, texts, told, answered, sessions, say, open: open1, hear: (m: Inbound) => t.heard(m), clock };
}

const bash = (id = "r1"): Request => ({ id, sessionId: "claude:a", kind: "approval", tool: "Bash", toolKind: "shell", command: "npm test -- --watch=false", openedAt: 1 });

describe("texting", () => {
  test("a finished turn texts only when the agent asks something, with its words and a link", async () => {
    const { t, texts, say } = setup();
    await t.start();
    say("claude:a", "Done. All tests pass.");
    await t.turnEnded("claude:a");
    expect(texts).toEqual([]);
    say("claude:a", "Fixed the redirect.\n\nShould I also update the docs?");
    await t.turnEnded("claude:a");
    await t.turnEnded("codex:b", "429 rate_limit_error secret");
    expect(texts).toEqual([
      `[1] Fixed the redirect.\n\nShould I also update the docs?\n${LINK}claude%3Aa`,
      `[2] Codex stopped: rate limited.\n${LINK}codex%3Ab`,
    ]);
  });

  test("texting a session: the agent's answer comes back, whatever it is", async () => {
    const { t, texts, told, say, hear } = setup();
    await t.start();
    await t.turnEnded("codex:b", "boom");
    await hear({ text: "what did you change?" });
    expect(told).toEqual([["codex:b", "what did you change?"]]);
    // No "sent" back: the answer is what comes.
    expect(texts.length).toBe(1);
    t.turnStarted("codex:b");
    say("codex:b", "I changed the router.");
    await t.turnEnded("codex:b");
    // The back-and-forth: no link.
    expect(texts.at(-1)).toBe("[1] I changed the router.");
    // only once
    say("codex:b", "Done.");
    await t.turnEnded("codex:b");
    expect(texts.at(-1)).toBe("[1] I changed the router.");
  });

  test("a command: says what it is; y allows, n denies, words go to the agent", async () => {
    const s = setup();
    await s.t.start();
    await s.open("claude:a", bash());
    expect(s.texts[0]).toBe(`[1] Can I run the tests? y/n\n${LINK}claude%3Aa`);
    await s.hear({ text: "Y" });
    expect(s.answered.at(-1)).toEqual(["claude:a", "r1", { allow: true }]);
    expect(s.texts.length).toBe(1);
    await s.open("claude:a", bash("r2"));
    await s.hear({ text: "why do you need watch off?" });
    expect(s.answered.at(-1)).toEqual(["claude:a", "r2", { allow: false, reason: "why do you need watch off?" }]);
    // A request's text always has the link (the full command is there); nothing back on the answer.
    expect(s.texts.at(-1)).toBe(`[1] Can I run the tests? y/n\n${LINK}claude%3Aa`);
    await s.open("claude:a", bash("r3"));
    await s.hear({ text: "n" });
    expect(s.answered.at(-1)).toEqual(["claude:a", "r3", { allow: false }]);
  });

  test("a plan: its text, y approves, a question goes to the agent", async () => {
    const s = setup();
    await s.t.start();
    await s.open("claude:a", { id: "p1", sessionId: "claude:a", kind: "approval", tool: "ExitPlanMode", plan: "# Plan\n1. Add a route\n2. Test it", openedAt: 1 });
    expect(s.texts[0]).toBe(`[1] Can I go ahead with the plan to add a route? y/n\n${LINK}claude%3Aa`);
    await s.hear({ text: "1 what is the plan" });
    expect(s.answered.at(-1)).toEqual(["claude:a", "p1", { allow: false, reason: "what is the plan" }]);
    expect(s.texts.at(-1)).not.toContain("denied");
  });

  test("a question: options by letter, or your own answer", async () => {
    const s = setup();
    await s.t.start();
    const q: Request = { id: "q1", sessionId: "claude:a", kind: "question", questions: [{ question: "Which color?", options: [{ label: "Blue" }, { label: "Red" }] }], openedAt: 1 };
    await s.open("claude:a", q);
    expect(s.texts[0]).toStartWith("[1] Claude asks:\nWhich color?\na) Blue\nb) Red\n\nReply with a letter, or your own answer.");
    await s.hear({ text: "b" });
    expect(s.answered.at(-1)).toEqual(["claude:a", "q1", { allow: true, answers: ["Red"] }]);
    await s.open("claude:a", { ...q, id: "q2" });
    await s.hear({ text: "green please" });
    expect(s.answered.at(-1)).toEqual(["claude:a", "q2", { allow: true, answers: ["green please"] }]);
  });

  test("nothing while someone looks at the session; nothing without a link", async () => {
    const { t, texts } = setup({ "claude:a": ["laptop"] });
    await t.attention("claude:a");
    await t.start();
    await t.attention("claude:a");
    expect(texts).toEqual([]);
  });

  test("a failed send says why", async () => {
    const { t, texts, hear } = setup();
    await t.start();
    await t.turnEnded("claude:a", "boom");
    (t as any).ctx.sessions.tell = async () => { throw new Error("This subagent has finished."); };
    await hear({ text: "hi" });
    expect(texts.at(-1)).toBe("Couldn't send to [1]: This subagent has finished.");
    (t as any).ctx.sessions.tell = async () => { throw new Error("It's gone. Start a new one.\nstack…"); };
    await hear({ text: "hi" });
    expect(texts.at(-1)).toBe("Couldn't send to [1]: It's gone.");
  });

  test("a text passed on to its session gets a ✅; an unclear one or a failed send doesn't", async () => {
    const { t, texts, told, answered, hear, open, sessions } = setup();
    await t.start();
    await t.turnEnded("claude:a", "boom");
    const reacted: string[] = [];
    const heard = (text: string) => hear({ text, react: async (e) => void reacted.push(`${text} ${e}`) });
    await heard("hi");
    expect(told.at(-1)).toEqual(["claude:a", "hi"]);
    expect(reacted).toEqual(["hi ✅"]);
    // No text back: the reaction is the only acknowledgment.
    expect(texts.at(-1)).not.toMatch(/hi/);
    await open("claude:a", bash());
    await heard("y");
    expect(answered.at(-1)?.[2]).toMatchObject({ allow: true });
    expect(reacted.at(-1)).toBe("y ✅");
    sessions["claude:a"].requests = [];
    sessions["claude:a"].state.requests = [];
    // A failure to forward: a text says why, and no ✅.
    (t as any).ctx.sessions.tell = async () => { throw new Error("It's gone."); };
    await heard("still there?");
    expect(reacted).not.toContain("still there? ✅");
    // A reaction that fails doesn't turn into a failed send.
    (t as any).ctx.sessions.tell = async (id: string, text: string) => void told.push([id, text]);
    const n = texts.length;
    await hear({ text: "again", react: async () => { throw new Error("no tapbacks"); } });
    expect(told.at(-1)).toEqual(["claude:a", "again"]);
    expect(texts.length).toBe(n);
  });

  test("the link: at most every few minutes per session, never on the back-and-forth", async () => {
    const { t, texts, say, hear, clock } = setup();
    await t.start();
    const asks = async (id: string) => (say(id, "Want me to commit?"), t.turnEnded(id));
    await asks("claude:a");
    expect(texts.at(-1)).toBe(`[1] Want me to commit?\n${LINK}claude%3Aa`);
    clock.t += 60_000;
    await asks("claude:a");
    expect(texts.at(-1)).toBe("[1] Want me to commit?");
    // Another session gets its own.
    await asks("codex:b");
    expect(texts.at(-1)).toContain(`${LINK}codex%3Ab`);
    // Talking back and forth: never, even once the time has passed.
    clock.t += LINK_EVERY_MS;
    await hear({ text: "1 ok" });
    t.turnStarted("claude:a");
    say("claude:a", "Committed.");
    await t.turnEnded("claude:a");
    expect(texts.at(-1)).toBe("[1] Committed.");
    // Not talking, and the time has passed: the link again.
    await asks("claude:a");
    expect(texts.at(-1)).toBe(`[1] Want me to commit?\n${LINK}claude%3Aa`);
  });

  test("Tether's own words: one casual sentence, never that something works, no acks", async () => {
    const { t, texts, hear } = setup();
    await t.start();
    await t.test();
    await t.attention("claude:a");
    await t.turnEnded("codex:b", "overloaded 529");
    await hear({ text: "ok" });
    await hear({ text: "8 what?" });
    await hear({ text: "1" });
    await hear({ text: "go" });
    expect(texts.length).toBeGreaterThan(5);
    for (const text of texts) expect([text, casualText(text)]).toEqual([text, true]);
    // Just the number and the message: no folder, no agent label.
    for (const text of texts.filter((x) => x.startsWith("["))) expect(text).toMatch(/^\[\d\] (?!web\b|api\b)[^·]*$/m);
    const all = [TEXTS.test, TEXTS.attention("Codex"), TEXTS.failed("Claude", "the conversation is too long"), TEXTS.couldNotSend("[1]", "a. b. c."), TEXTS.nothingOpen, TEXTS.which, TEXTS.notWaiting(3), TEXTS.whatToSend(1)];
    for (const text of all) expect([text, casualText(text)]).toEqual([text, true]);
    // The check itself.
    expect(casualText("Done. Tests pass.")).toBe(false);
    expect(casualText("[1] It works")).toBe(false);
    expect(casualText("Fixed it. Opened a PR.")).toBe(false);
    expect(casualText("Opened a PR, e.g. #12.")).toBe(true);
    expect(casualText(OK)).toBe(true);
    for (const ack of ["Sent", "→ [1]", "Got it, the session is fixing the tests.", "Forwarded to web."]) expect(casualText(ack)).toBe(false);
  });

  test("what counts as asking", () => {
    expect(asksQuestion("Want me to commit?")).toBe(true);
    expect(asksQuestion("Fixed it.\n\nShould I open a PR (or wait)?")).toBe(true);
    expect(asksQuestion("Anything else? Let me know.\n\nDone.")).toBe(false);
    expect(asksQuestion("Done.\n\n```\nfoo?bar ?x\n```")).toBe(false);
    expect(asksQuestion("See https://x.dev/a?b=1 for details.")).toBe(false);
  });
});

describe("settings", () => {
  test("saved mode 600, secret redacted, env wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "texting-"));
    const file = join(dir, "texting.json");
    const s = new TextingStore(file, {});
    expect(s.config()).toBeUndefined();
    s.update({ enabled: true, phone: "(310) 555-1234", projectId: "p1", projectSecret: "saved-secret-xyz" });
    expect(s.config()).toEqual({ phone: "+13105551234", projectId: "p1", projectSecret: "saved-secret-xyz" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(redact("key saved-secret-xyz")).toBe("key [redacted]");
    expect(new TextingStore(file, {}).status({ connected: false })).toMatchObject({ enabled: true, phoneLast4: "1234", keysSet: true, fromEnv: { phone: false, keys: false } });
    expect(new TextingStore(file, ENV).config()).toEqual({ phone: "+13105551234", projectId: "proj", projectSecret: "sec-0123456789" });
    expect(() => s.update({ phone: "call me" })).toThrow("isn't a phone number");
    expect(JSON.parse(readFileSync(file, "utf8")).settings.phone).toBe("+13105551234");
  });

  test("env alone turns it on; off stays off", () => {
    expect(new TextingStore(undefined, ENV).enabled()).toBe(true);
    const s = new TextingStore(undefined, ENV);
    s.update({ enabled: false });
    expect(s.config()).toBeUndefined();
  });

  test("phones and inbound content", () => {
    expect(normalPhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalPhone("abc")).toBeUndefined();
    expect(inboundOf({ type: "text", text: "hi" })).toEqual({ text: "hi" });
    expect(inboundOf({ type: "reply", content: { type: "text", text: "yes" }, target: { id: "m9" } })).toEqual({ text: "yes", replyTo: "m9" });
    expect(inboundOf({ type: "reaction" })).toBeUndefined();
  });
});

describe("the picker", () => {
  test("the picker leaves out sessions already answered", async () => {
    const { t, texts, hear } = setup();
    await t.start();
    await t.turnEnded("claude:a", "boom");
    await t.turnEnded("codex:b", "boom");
    t.turnStarted("claude:a"); // answered in Tether
    await hear({ text: "hm" });
    expect(texts.at(-1)).toBe("Which session, by number?\n[2] failed: an error, just now");
  });
});

describe("a reply to a request has exactly one effect", () => {
  /** A setup whose answers close the request, as the broker does, and with the Home agent's tabs as sessions. */
  function real() {
    const s = setup();
    for (const id of ["claude:home1", "claude:home2"]) s.sessions[id] = { summary: { id, projectPath: "/home/me/.local/share/tether/modules/homeAgent/workspace" }, status: "running", requests: [], state: { requests: [] } };
    const close = (id: string) => {
      s.sessions[id].requests = [];
      s.sessions[id].state.requests = [];
    };
    (s.t as any).ctx.sessions.answer = async (id: string, r: string, a: RequestAnswer) => {
      s.answered.push([id, r, a]);
      close(id);
    };
    const read = (id = "r1", sessionId = "claude:a"): Request => ({ id, sessionId, kind: "approval", tool: "Read", toolKind: "read", path: "/home/ubuntu/tether-prod/web/src", reason: "Path is outside allowed working directories", openedAt: 1 });
    const reacted: string[] = [];
    const heard = (text: string, replyTo?: string) => s.hear({ text, ...(replyTo ? { replyTo } : {}), react: async (e) => void reacted.push(`${text} ${e}`) });
    return { ...s, close, read, reacted, heard };
  }

  for (const [reply, answer] of [
    ["y", { allow: true }],
    ["n", { allow: false }],
    ["use the copy in web-coder instead", { allow: false, reason: "use the copy in web-coder instead" }],
  ] as const) {
    test(`"${reply}" answers the request and nothing else, even heard twice`, async () => {
      const s = real();
      await s.t.start();
      await s.open("claude:a", s.read());
      await s.heard(reply);
      expect(s.answered).toEqual([["claude:a", "r1", answer]]);
      expect(s.told).toEqual([]);
      expect(s.reacted).toEqual([`${reply} ✅`]);
      // The same reply heard again (Photon delivering it twice): never a message to the agent.
      await s.heard(reply);
      expect(s.answered.length).toBe(1);
      expect(s.told).toEqual([]);
      expect(s.reacted.length).toBe(1);
    });
  }

  test(`"[2] y" with two sessions waiting answers [2]'s request only`, async () => {
    const s = real();
    await s.t.start();
    await s.t.turnEnded("codex:b", "boom");
    await s.open("claude:a", s.read());
    expect(s.texts.at(-1)).toStartWith("[2] Can I read web/src");
    await s.heard("[2] y");
    expect(s.answered).toEqual([["claude:a", "r1", { allow: true }]]);
    expect(s.told).toEqual([]);
  });

  test("a threaded reply to the request's text answers that request", async () => {
    const s = real();
    await s.t.start();
    await s.t.turnEnded("codex:b", "boom");
    await s.open("claude:a", s.read());
    const id = s.t.router.state.sent.at(-1)!.id;
    await s.heard("y", id);
    expect(s.answered).toEqual([["claude:a", "r1", { allow: true }]]);
    expect(s.told).toEqual([]);
    // Again on the same text, once it's answered: nothing to the agent.
    await s.heard("y", id);
    expect(s.answered.length).toBe(1);
    expect(s.told).toEqual([]);
  });

  test("Home agent tab: a y after the request was answered in Tether goes nowhere", async () => {
    const s = real();
    await s.t.start();
    await s.t.turnEnded("codex:b", "boom");
    await s.open("claude:home2", s.read("r9", "claude:home2"));
    expect(s.texts.at(-1)).toStartWith("[2] Can I read");
    // Answered in Tether: the request closes, the session goes on.
    s.close("claude:home2");
    s.t.settled("claude:home2");
    s.clock.t += 28 * 60_000;
    // Two open: the picker holds it; picking [2] gives it to [2]'s closed request.
    await s.heard("y");
    expect(s.texts.at(-1)).toStartWith(TEXTS.which);
    await s.heard("2");
    expect(s.told).toEqual([]);
    expect(s.answered).toEqual([]);
    expect(s.reacted).toEqual([]);
    expect(s.texts.at(-1)).toBe(TEXTS.alreadyAnswered(2));
    // A numbered one too.
    await s.open("claude:home2", s.read("r10", "claude:home2"));
    s.close("claude:home2");
    await s.heard("[2] y");
    expect(s.told).toEqual([]);
    expect(s.texts.at(-1)).toBe(TEXTS.alreadyAnswered(2));
    // Told so, the person's next text to it is words to the agent.
    await s.heard("2 what are you reading that for?");
    expect(s.told).toEqual([["claude:home2", "what are you reading that for?"]]);
  });

  test("a y to a closed request never answers a newer one the person hasn't seen", async () => {
    const s = real();
    await s.t.start();
    await s.open("claude:a", s.read());
    s.close("claude:a");
    // A new request opened; its text hasn't gone out yet (REQUEST_DELAY_MS).
    s.sessions["claude:a"].requests = ["r2"];
    s.sessions["claude:a"].state.requests = [bash("r2")];
    await s.heard("y");
    expect(s.answered).toEqual([]);
    expect(s.told).toEqual([]);
    // Its text goes out: now y answers it.
    await s.t.request(bash("r2"));
    await s.heard("y");
    expect(s.answered).toEqual([["claude:a", "r2", { allow: true }]]);
  });

  test("the request closing while the reply waits in the inbox", async () => {
    const s = real();
    await s.t.start();
    await s.open("claude:a", s.read());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // A reply still being handled holds the inbox.
    const first = s.hear({ text: "y", react: () => gate });
    const second = s.heard("y");
    release();
    await Promise.all([first, second]);
    expect(s.answered).toEqual([["claude:a", "r1", { allow: true }]]);
    expect(s.told).toEqual([]);
  });

  test("the already-answered text is casual", () => {
    expect(casualText(TEXTS.alreadyAnswered(2))).toBe(true);
  });
});

describe("texting the Home agent", () => {
  function withHome() {
    const line = new HomeLine();
    const took: string[] = [];
    let textsChat = "claude:home";
    line.home = { take: async (text) => void took.push(text), isTextsChat: (id) => id === textsChat };
    const s = setup({}, line);
    line.phone = { send: (text) => s.t.homeText(text), text: (from, body) => s.t.personText(from, body) };
    return { ...s, line, took, setTextsChat: (id: string) => (textsChat = id) };
  }

  test("a text with nothing open goes to it with a ✅, and its reply comes back as a [home] text", async () => {
    const { t, texts, took, told, hear, line } = withHome();
    await t.start();
    const reacted: string[] = [];
    await hear({ text: "start a session to fix the login in web", react: async (e) => void reacted.push(e) });
    expect(took).toEqual(["start a session to fix the login in web"]);
    expect(told).toEqual([]);
    expect(reacted).toEqual(["✅"]);
    // No ack from Tether itself: the Home agent answers.
    expect(texts).toEqual([]);
    expect(await line.phone!.send("ok, on it")).toBe(true);
    expect(texts).toEqual(["[home] ok, on it"]);
    expect(casualText(texts[0]!)).toBe(true);
    // A threaded reply to it goes back to the Home agent.
    await hear({ text: "also the docs", replyTo: "m1" });
    expect(took.at(-1)).toBe("also the docs");
  });

  test("a prefixed text goes to it even while a session waits on a reply; plain text still goes to the session", async () => {
    const { t, took, told, hear, say } = withHome();
    await t.start();
    say("claude:a", "Should I deploy?");
    await t.turnEnded("claude:a");
    await hear({ text: "home: what's running?" });
    expect(took).toEqual(["what's running?"]);
    await hear({ text: "yes deploy" });
    expect(told).toEqual([["claude:a", "yes deploy"]]);
    expect(took).toEqual(["what's running?"]);
  });

  test("after a Home text, plain text answers the Home agent, not the open session", async () => {
    const { t, took, told, hear, say, line } = withHome();
    await t.start();
    say("claude:a", "Should I deploy?");
    await t.turnEnded("claude:a");
    await line.phone!.send("PR, merge + deploy, or just local changes?");
    await hear({ text: "just a PR" });
    expect(took).toEqual(["just a PR"]);
    expect(told).toEqual([]);
  });

  test("the same text heard twice goes to the Home agent once", async () => {
    const { t, took, hear } = withHome();
    await t.start();
    await hear({ id: "in1", text: "home: start x" });
    await hear({ id: "in1", text: "home: start x" });
    await hear({ id: "in2", text: "home: start x" });
    expect(took).toEqual(["start x", "start x"]);
  });

  test("a failure to hand it over says so; no Home agent says so", async () => {
    const { t, texts, hear, line } = withHome();
    await t.start();
    line.home!.take = async () => {
      throw new Error("The chat is gone.\nstack");
    };
    await hear({ text: "home: start x" });
    expect(texts).toEqual(["Couldn't send to the Home agent: The chat is gone."]);
    line.home = undefined;
    await hear({ text: "home: start x" });
    expect(texts.at(-1)).toBe(TEXTS.noHome);
    for (const text of [TEXTS.noHome, TEXTS.whatToSendHome, TEXTS.homeFailed("rate limited")]) expect([text, casualText(text)]).toEqual([text, true]);
  });

  test("the Texts chat's own turn ends aren't texted as a session's, and nothing goes without a link", async () => {
    const { t, texts, say, setTextsChat, line } = withHome();
    setTextsChat("claude:a");
    await t.start();
    say("claude:a", "Which project, web or api?");
    await t.turnEnded("claude:a");
    await t.turnEnded("claude:a", "overloaded 529");
    expect(texts).toEqual([]);
    await t.stop();
    expect(await line.phone!.send("ok")).toBe(false);
  });
});

describe("an agent texting the person (text_person)", () => {
  test("goes out under the session's number, even while it's open in Tether, and a reply comes back to it", async () => {
    const { t, texts, told, hear } = setup({ "claude:a": ["phone"] });
    await t.start();
    const r = await t.personText("claude:a", "PR is up: https://github.com/x/y/pull/1");
    expect(r.isError).toBeUndefined();
    expect(texts).toEqual([`[1] PR is up: https://github.com/x/y/pull/1\n${LINK}claude%3Aa`]);
    // A threaded reply, and a plain one, go back to that session as the person's words.
    await hear({ text: "merge it", replyTo: "m1" });
    await hear({ text: "and deploy" });
    expect(told).toEqual([["claude:a", "merge it"], ["claude:a", "and deploy"]]);
  });

  test("the session's answer to the reply comes back by text", async () => {
    const { t, texts, hear, say } = setup();
    await t.start();
    await t.personText("codex:b", "blocked: which database?");
    await hear({ text: "postgres", replyTo: "m1" });
    say("codex:b", "ok, using postgres");
    await t.turnEnded("codex:b");
    expect(texts.at(-1)).toBe("[1] ok, using postgres");
  });

  test(`cut at ${PERSON_TEXT_MAX} characters`, async () => {
    const { t, texts } = setup();
    await t.start();
    const r = await t.personText("claude:a", "x".repeat(1000));
    expect(r.text).toContain("cut");
    expect(texts[0]!.split("\n")[0]!.length).toBeLessThanOrEqual(PERSON_TEXT_MAX + 4);
  });

  test("rate-capped per session; the cap frees up after a while", async () => {
    const { t, texts, clock } = setup();
    await t.start();
    for (let i = 0; i < AGENT_TEXT_MAX; i++) expect((await t.personText("claude:a", `n${i}`)).isError).toBeUndefined();
    const over = await t.personText("claude:a", "one more");
    expect(over.isError).toBe(true);
    expect(texts.length).toBe(AGENT_TEXT_MAX);
    // Another session isn't held back by it.
    expect((await t.personText("codex:b", "hi")).isError).toBeUndefined();
    clock.t += AGENT_TEXT_MS;
    expect((await t.personText("claude:a", "later")).isError).toBeUndefined();
  });

  test("texting off or empty: an error, nothing sent", async () => {
    const { t, texts } = setup();
    expect((await t.personText("claude:a", "hi")).isError).toBe(true);
    await t.start();
    expect((await t.personText("claude:a", "   ")).isError).toBe(true);
    expect(texts).toEqual([]);
  });

  test("the Home agent's goes out as [home], and a reply goes back to it", async () => {
    const line = new HomeLine();
    const took: string[] = [];
    line.home = { take: async (text) => void took.push(text), isTextsChat: () => false };
    const s = setup({}, line);
    await s.t.start();
    const r = await s.t.personText("home", "PR #12 is merged and live");
    expect(r.isError).toBeUndefined();
    expect(s.texts).toEqual(["[home] PR #12 is merged and live"]);
    await s.hear({ text: "thanks", replyTo: "m1" });
    expect(took).toEqual(["thanks"]);
  });
});

describe("request texts a person can read", () => {
  const LONG_RM =
    "W=/home/ubuntu/web-coder/.claude/worktrees/hide-checkin; git -C $W status --short; for d in server shared; do [ -d $W/$d/node_modules ] && rm -rf $W/$d/node_modules; done; git worktree remove --force $W";
  const DANGER = "Dangerous rm operation on possibly-empty variable path $W/$d/node_modules. This command requires approval.";
  const req = (o: Partial<Request>): Request => ({ id: "r1", sessionId: "claude:a", kind: "approval", tool: "Bash", toolKind: "shell", openedAt: 1, ...o });
  const body = async (r: Request) => {
    const s = setup();
    await s.t.start();
    await s.open("claude:a", r);
    return s.texts[0]!;
  };

  /** The text without its link line. */
  const line = (t: string) => t.split("\n")[0]!;

  test("the incident: one plain question in the agent's voice, no command, no warning; the link on its own line", async () => {
    const text = await body(req({ command: LONG_RM, reason: DANGER }));
    expect(text).toBe(`[1] Can I clean up the hide-checkin worktree? y/n\n${LINK}claude%3Aa`);
    for (const raw of ["rm -rf", "$W", "Dangerous", "possibly-empty", "git -C", "flagged"]) expect(text).not.toContain(raw);
  });

  test("Claude's Bash description is the question", async () => {
    const text = await body(req({ command: LONG_RM, reason: DANGER, input: { command: LONG_RM, description: "Run the jungle test suite" } }));
    expect(line(text)).toBe("[1] Can I run the jungle test suite? y/n");
  });

  test(`at most ${REQUEST_MAX} characters`, async () => {
    const text = await body(req({ command: "ls", input: { command: "ls", description: "Look ".repeat(100) } }));
    expect(line(text).length).toBeLessThanOrEqual(REQUEST_MAX + 4);
    expect(line(text)).toEndWith("…? y/n");
  });

  test("other tools and plans ask the same way", async () => {
    expect(line(await body(req({ command: "bun install && bun test" })))).toBe("[1] Can I install packages and run the tests? y/n");
    expect(line(await body(req({ tool: "Edit", toolKind: "edit", command: undefined, path: "/home/me/web/src/app.css" })))).toBe("[1] Can I edit src/app.css? y/n");
    expect(line(await body(req({ tool: "WebFetch", toolKind: "fetch", input: { url: "https://docs.example.com/a/b?c" } })))).toBe("[1] Can I open docs.example.com? y/n");
    expect(line(await body(req({ tool: "mcp__github__create_issue", toolKind: "other", input: { title: "x" } })))).toBe("[1] Can I use create issue (github)? y/n");
    expect(line(await body(req({ network: true, toolKind: undefined, tool: undefined })))).toBe("[1] Can I use the internet? y/n");
    expect(line(await body(req({ tool: "ExitPlanMode", toolKind: undefined, plan: "# Plan\n1. Add a login route\n2. Test it" })))).toBe("[1] Can I go ahead with the plan to add a login route? y/n");
  });
});

describe("summary.ts", () => {
  test("commandWords: the riskiest first, at most three, unknown programs named", () => {
    expect(commandWords("cd /x && git push --force origin main")).toBe("force-push code");
    expect(commandWords("bun install && bun test")).toBe("install packages and run the tests");
    expect(commandWords("git reset --hard && git clean -fd && ls")).toBe("throw away uncommitted changes and delete untracked files");
    expect(commandWords("FOO=1 mytool --x")).toBe("run mytool");
    expect(commandWords("echo 'rm -rf /' | cat")).toBe("look at files");
    expect(commandWords("sudo systemctl restart nginx")).toBe("run something as admin and restart a service");
  });
});
