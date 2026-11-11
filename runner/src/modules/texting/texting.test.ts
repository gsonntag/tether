import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../../credentials";
import { asksQuestion, Texter } from ".";
import { inboundOf, type Inbound, type OpenLink } from "./link";
import { normalPhone, TextingStore } from "./store";

const ENV = { TETHER_PHOTON_PROJECT_ID: "proj", TETHER_PHOTON_PROJECT_SECRET: "sec-0123456789", TETHER_TEXT_PHONE: "+13105551234" };

function setup(viewers: Record<string, string[]> = {}) {
  const texts: string[] = [];
  let n = 0;
  const open: OpenLink = async () => {
    return { send: async (t) => (texts.push(t), `m${++n}`), closed: new Promise(() => {}), stop: async () => {} };
  };
  const sessions: Record<string, any> = {
    "claude:a": { summary: { id: "claude:a", title: "secret plans", projectPath: "/home/me/web" }, status: "idle", requests: [] },
    "codex:b": { summary: { id: "codex:b", projectPath: "/home/me/api" }, status: "idle", requests: [] },
  };
  const told: [string, string][] = [];
  const denied: [string, string, string?][] = [];
  const t = new Texter(
    {
      log: () => {},
      session: (id) => sessions[id],
      viewersOf: (id) => viewers[id] ?? [],
      sessions: { tell: async (id, text) => void told.push([id, text]), deny: async (id, r, why) => void denied.push([id, r, why]) },
    },
    new TextingStore(undefined, ENV),
    open,
  );
  return { t, texts, told, denied, sessions, hear: (m: Inbound) => t.heard(m) };
}

describe("texting", () => {
  test("a finished turn texts only when the agent asked something; replies route", async () => {
    const { t, texts, told, hear } = setup();
    await t.start();
    const say = (id: string, text: string) => t.said(id, { id: "x", role: "assistant", ts: 1, parts: [{ type: "text", text }] });
    say("claude:a", "Done. All tests pass.");
    await t.turnEnded("claude:a");
    expect(texts).toEqual([]);
    say("claude:a", "Should I also update the docs?");
    await t.turnEnded("claude:a");
    await t.turnEnded("codex:b", "429 rate_limit_error secret");
    expect(texts).toEqual(["[1] web · Claude: Claude has a question for you.", "[2] api · Codex: Failed: rate limited."]);
    // never the agent's words
    expect(texts.join()).not.toContain("docs");
    await hear({ text: "keep going" });
    expect(texts.at(-1)).toStartWith("Which session?\n[1] web · Claude: asked you something");
    await hear({ text: "2" });
    expect(told).toEqual([["codex:b", "keep going"]]);
    expect(texts.at(-1)).toBe("→ [2] api · Codex");
    await hear({ text: "again", replyTo: "m1" });
    expect(told.at(-1)).toEqual(["claude:a", "again"]);
  });

  test("what counts as asking", () => {
    expect(asksQuestion("Want me to commit?")).toBe(true);
    expect(asksQuestion("Fixed it.\n\nShould I open a PR (or wait)?")).toBe(true);
    expect(asksQuestion("Anything else? Let me know.\n\nDone.")).toBe(false);
    expect(asksQuestion("Done.\n\n```\nfoo?bar ?x\n```")).toBe(false);
    expect(asksQuestion("See https://x.dev/a?b=1 for details.")).toBe(false);
  });

  test("nothing while someone looks at the session; nothing without a link", async () => {
    const { t, texts } = setup({ "claude:a": ["laptop"] });
    await t.attention("claude:a");
    await t.start();
    await t.attention("claude:a");
    expect(texts).toEqual([]);
  });

  test("a reply to a session with an open request denies it with the note", async () => {
    const { t, texts, denied, told, sessions, hear } = setup();
    await t.start();
    sessions["claude:a"].requests = ["r1"];
    await t.request({ id: "r1", sessionId: "claude:a", kind: "approval", tool: "Bash", input: { command: "rm -rf /" }, openedAt: 1 });
    expect(texts[0]).toBe("[1] web · Claude: Claude wants to run a command. Open Tether to approve, or reply to deny with a note.");
    await hear({ text: "no, use the build dir" });
    expect(denied).toEqual([["claude:a", "r1", "no, use the build dir"]]);
    expect(told).toEqual([]);
    expect(texts.at(-1)).toBe("→ [1] web · Claude: denied, with your note.");
  });

  test("a failed send says why", async () => {
    const { t, texts, hear } = setup();
    await t.start();
    await t.turnEnded("claude:a", "boom");
    (t as any).ctx.sessions.tell = async () => { throw new Error("This subagent has finished."); };
    await hear({ text: "hi" });
    expect(texts.at(-1)).toBe("Couldn't send to [1] web · Claude: This subagent has finished.");
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
