import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../../credentials";
import type { Request, RequestAnswer } from "../../../../shared/transcript";
import { asksQuestion, LINK_EVERY_MS, Texter } from ".";
import { casualText, OK, TEXTS } from "./texts";
import { inboundOf, type Inbound, type OpenLink } from "./link";
import { normalPhone, TextingStore } from "./store";

const ENV = { TETHER_PHOTON_PROJECT_ID: "proj", TETHER_PHOTON_PROJECT_SECRET: "sec-0123456789", TETHER_TEXT_PHONE: "+13105551234" };

const LINK = "https://tether.example/#/s/box/";

function setup(viewers: Record<string, string[]> = {}) {
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
      `[1] Fixed the redirect.\n\nShould I also update the docs?\n\n${LINK}claude%3Aa`,
      `[2] Codex stopped: rate limited.\n\n${LINK}codex%3Ab`,
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
    expect(s.texts[0]).toBe(`[1] Claude wants to run:\nnpm test -- --watch=false\n\nReply y to allow, n to deny, or tell it what to do instead.\n\n${LINK}claude%3Aa`);
    await s.hear({ text: "Y" });
    expect(s.answered.at(-1)).toEqual(["claude:a", "r1", { allow: true }]);
    expect(s.texts.length).toBe(1);
    await s.open("claude:a", bash("r2"));
    await s.hear({ text: "why do you need watch off?" });
    expect(s.answered.at(-1)).toEqual(["claude:a", "r2", { allow: false, reason: "why do you need watch off?" }]);
    // The second request within LINK_EVERY_MS: no link again; and nothing back on the answer.
    expect(s.texts.at(-1)).toBe("[1] Claude wants to run:\nnpm test -- --watch=false\n\nReply y to allow, n to deny, or tell it what to do instead.");
    await s.open("claude:a", bash("r3"));
    await s.hear({ text: "n" });
    expect(s.answered.at(-1)).toEqual(["claude:a", "r3", { allow: false }]);
  });

  test("a plan: its text, y approves, a question goes to the agent", async () => {
    const s = setup();
    await s.t.start();
    await s.open("claude:a", { id: "p1", sessionId: "claude:a", kind: "approval", tool: "ExitPlanMode", plan: "# Plan\n1. Add a route\n2. Test it", openedAt: 1 });
    expect(s.texts[0]).toStartWith("[1] Claude has a plan:\n\n# Plan\n1. Add a route\n2. Test it\n\nReply y to approve, or say what to change.");
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

  test("the link: at most every few minutes per session, never on the back-and-forth", async () => {
    const { t, texts, say, hear, clock } = setup();
    await t.start();
    const asks = async (id: string) => (say(id, "Want me to commit?"), t.turnEnded(id));
    await asks("claude:a");
    expect(texts.at(-1)).toBe(`[1] Want me to commit?\n\n${LINK}claude%3Aa`);
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
    expect(texts.at(-1)).toBe(`[1] Want me to commit?\n\n${LINK}claude%3Aa`);
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
