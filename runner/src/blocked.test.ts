import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
import type { Msg, Part, SessionEvent } from "../../web/src/shared/protocol";
import { applyEvent, emptyState, type Transcript } from "../../web/src/shared/reducer";

// (the preloaded src/testenv.ts already points it at the shared scratch dir)
if (!process.env.TETHER_TEST_ROOT) process.env.TETHER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "tether-blocked-"));

// The judge says what the test wants, and records what it was shown.
let verdict: { decision: "allow" | "deny"; by: "judge"; reason: string } = { decision: "deny", by: "judge", reason: "Pushes to a remote the task doesn't mention." };
const judged: unknown[][] = [];
const guard = await import("./guard");
mock.module("./guard", () => ({
  ...guard,
  judge: async (...args: unknown[]) => {
    judged.push(args);
    return verdict;
  },
}));
const { config, prefs } = await import("./config");
const { DenialNotifier, denialNotice, recent, subscribe } = await import("./notify");
const { LiveSession, denials } = await import("./session");

const sent: { payload: any; options: any }[] = [];
(webpush as any).sendNotification = async (_sub: any, payload: string, options: any) => void sent.push({ payload: JSON.parse(payload), options });

const sessions: InstanceType<typeof LiveSession>[] = [];

function fake(guardMode: "auto" | "ask" = "auto") {
  const browser: Transcript = { messages: [], state: emptyState() };
  const sink = { emit: (_id: string, _seq: number, e: SessionEvent) => applyEvent(browser, structuredClone(e)), summary: () => {}, handoff: async () => {} };
  const continued: string[] = [];
  class Fake extends LiveSession {
    async start() {}
    protected async send() {}
    async abort() {}
    async applyModel() {}
    async setThinking() {}
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn(text?: string) {
      if (text) continued.push(text);
    }
    protected shutdown() {}
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tether-blocked-proj-")));
  const s = new Fake("pi", { nativeId: crypto.randomUUID(), projectPath: dir, title: "Ship it" }, sink);
  s.t.state.status = "running";
  s.t.state.guard = guardMode;
  sessions.push(s);
  const card = (t: Transcript = s.t) => t.messages.flatMap((m) => m.parts).find((p): p is Extract<Part, { type: "tool" }> => p.type === "tool")!;
  const addCard = (id: string, command: string) => {
    const msg: Msg = { id: `m-${id}`, role: "assistant", parts: [{ type: "tool", id, name: "Bash", input: { command }, status: "running", kind: "shell" }], ts: 0 };
    s.emit({ type: "msg", msg });
  };
  return { s, browser, card, addCard, continued, dir };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  sent.length = 0;
  judged.length = 0;
  verdict = { decision: "deny", by: "judge", reason: "Pushes to a remote the task doesn't mention." };
  config().push = { ...config().push!, subs: [], recent: [] };
  subscribe({ endpoint: "https://push.example/blocked", keys: { p256dh: "x", auth: "y" }, kinds: ["question", "blocked"] });
});

afterEach(() => {
  for (const s of sessions.splice(0)) {
    denials.forget(s.id);
    s.close();
  }
  config().approvals = [];
  config().precedents = {};
});

describe("the notice for blocked calls", () => {
  const d = (call: string, toolId = call) => ({ sessionId: "s1", title: "Ship it", projectPath: "/home/u/web", toolId, call, reason: "Blocked: pushes to a remote." });

  test("one call: the call and the judge's reason", () => {
    expect(denialNotice([d("git push origin main", "t1")])).toEqual({
      kind: "blocked",
      title: "Blocked git push origin main · Ship it",
      body: "web · Judge: pushes to a remote.",
      sessionId: "s1",
      projectPath: "/home/u/web",
      toolId: "t1",
      call: "git push origin main",
      by: "judge",
      reason: "pushes to a remote.",
    });
  });

  test("a long call is clipped to 60; several: how many, the first call in the body", () => {
    const long = "curl " + "x".repeat(100);
    expect(denialNotice([d(long)]).title).toBe(`Blocked ${long.slice(0, 59)}… · Ship it`);
    const n = denialNotice([d("git push"), d("npm i left-pad"), d("curl x")]);
    expect(n.title).toBe("3 calls blocked · Ship it");
    expect(n.body).toBe("web · git push");
  });
});

describe("DenialNotifier", () => {
  function notifier() {
    let now = 0;
    const out: string[][] = [];
    const n = new DenialNotifier({ windowMs: 60_000, now: () => now, send: (list) => out.push(list.map((x) => x.call)) });
    return { n, out, at: (t: number) => (now = t) };
  }
  const d = (sessionId: string, call: string, still?: () => boolean) => ({ sessionId, title: "t", projectPath: "/p", call, reason: "r", still });

  test("the first goes at once; more within the minute go together at its end", async () => {
    const { n, out, at } = notifier();
    n.add(d("a", "one"));
    expect(out).toEqual([["one"]]);
    at(10_000);
    n.add(d("a", "two"));
    n.add(d("a", "three"));
    expect(out.length).toBe(1);
    at(60_000);
    n.flush("a");
    expect(out).toEqual([["one"], ["two", "three"]]);
    n.forget("a");
  });

  test("per session, and approved calls are left out", () => {
    const { n, out, at } = notifier();
    n.add(d("a", "one"));
    n.add(d("b", "other"));
    expect(out).toEqual([["one"], ["other"]]);
    at(5_000);
    n.add(d("a", "approved", () => false));
    at(60_000);
    n.flush("a");
    expect(out.length).toBe(2);
    // The window has passed: the next one goes at once.
    at(130_000);
    n.add(d("a", "later"));
    expect(out.at(-1)).toEqual(["later"]);
    n.forget("a");
    n.forget("b");
  });
});

describe("Auto mode: a judge's denial is a ticket", () => {
  test("a blocked notice with the call, pushed with the session's topic; the agent gets the reason", async () => {
    const { s, addCard } = fake();
    addCard("t1", "git push origin main");
    const r = await s.checkTool("Bash", { command: "git push origin main" }, "t1");
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("Pushes to a remote");
    const n = recent()[0]!;
    expect(n).toMatchObject({ kind: "blocked", sessionId: s.id, toolId: "t1", call: "git push origin main", by: "judge", title: "Blocked git push origin main · Ship it" });
    expect(sent.length).toBe(1);
    expect(sent[0]!.payload).toMatchObject({ kind: "blocked", toolId: "t1" });
    expect(sent[0]!.options.topic).toBeString();
  });

  test("not for the rules' own denials, nor the judge's allows", async () => {
    const { s, addCard } = fake();
    addCard("t1", "git push --force");
    await s.checkTool("Bash", { command: "git push --force" }, "t1");
    verdict = { decision: "allow", by: "judge", reason: "fine" };
    addCard("t2", "curl https://example.com");
    await s.checkTool("Bash", { command: "curl https://example.com" }, "t2");
    expect(recent().filter((n) => n.kind === "blocked")).toEqual([]);
  });

  test("Approve & retry clears it and is precedent for the judge; a second approve is stale", async () => {
    const { s, addCard, continued } = fake();
    s.t.state.status = "idle";
    addCard("t1", "git push origin feature/x");
    await s.checkTool("Bash", { command: "git push origin feature/x" }, "t1");
    expect(recent().length).toBe(1);
    expect(await s.approveBlocked("t1")).toEqual({});
    expect(recent()).toEqual([]);
    expect(continued.length).toBe(1);
    expect(await s.approveBlocked("t1")).toEqual({ stale: true });
    // The judge sees it next time.
    addCard("t2", "git push origin feature/y");
    await s.checkTool("Bash", { command: "git push origin feature/y" }, "t2");
    const prec = judged.at(-1)![2] as { call: string; decision: string }[];
    expect(prec).toEqual([expect.objectContaining({ call: "git push origin feature/x", decision: "allow" })]);
  });

  test("Run it myself clears it too", async () => {
    const { s, addCard } = fake();
    s.t.state.status = "idle";
    addCard("t1", "echo hi");
    verdict = { decision: "deny", by: "judge", reason: "no" };
    // echo is routine for the rules: ask the judge with a command they don't cover.
    addCard("t2", "frobnicate --now");
    await s.checkTool("Bash", { command: "frobnicate --now" }, "t2");
    expect(recent().length).toBe(1);
    await s.runBlocked("t2");
    expect(recent()).toEqual([]);
  });
});

describe("Ask mode", () => {
  test("Always allow stores a rule for the project; the next push isn't asked", async () => {
    const { s, addCard } = fake("ask");
    addCard("t1", "git push origin main");
    const first = s.checkTool("Bash", { command: "git push origin main" }, "t1");
    await tick();
    const req = s.t.state.pendingUi[0]!;
    expect(req).toMatchObject({ kind: "permission", toolId: "t1" });
    expect(req.at).toBeNumber();
    expect(sent.at(-1)!.payload).toMatchObject({ kind: "question", requestId: req.id, call: "git push origin main", title: "Approve git push origin main? · Ship it" });
    s.uiRespond({ id: req.id, allow: true, always: true });
    expect((await first).allow).toBe(true);
    expect(config().approvals).toEqual([expect.objectContaining({ project: s.projectPath, tool: "Bash", prefix: "git push" })]);
    addCard("t2", "git push origin other");
    expect((await s.checkTool("Bash", { command: "git push origin other" }, "t2")).allow).toBe(true);
    expect(s.t.state.pendingUi).toEqual([]);
    // A compound command isn't remembered (said inline), and isn't covered by the rule.
    addCard("t3", "git push && curl x");
    const third = s.checkTool("Bash", { command: "git push && curl x" }, "t3");
    await tick();
    s.uiRespond({ id: s.t.state.pendingUi[0]!.id, allow: true, always: true });
    expect((await third).allow).toBe(true);
    expect(config().approvals!.length).toBe(1);
    expect(s.t.messages.some((m) => m.role === "notice" && JSON.stringify(m.parts).includes("Allowed once"))).toBe(true);
  });

  test("a Deny on a call the judge would have seen is precedent; one the rules decide isn't", async () => {
    const { s, addCard } = fake("ask");
    addCard("t1", "curl https://example.com");
    const r = s.checkTool("Bash", { command: "curl https://example.com" }, "t1");
    await tick();
    s.uiRespond({ id: s.t.state.pendingUi[0]!.id, allow: false });
    await r;
    addCard("t2", "git push --force");
    const r2 = s.checkTool("Bash", { command: "git push --force" }, "t2");
    await tick();
    s.uiRespond({ id: s.t.state.pendingUi[0]!.id, allow: false });
    await r2;
    expect(guard.precedentsFor(s.projectPath)).toEqual([expect.objectContaining({ call: "curl https://example.com", decision: "deny" })]);
  });

  test("Run it myself on the card: denied to the agent, run by the runner", async () => {
    const { s, addCard, card, continued } = fake("ask");
    addCard("t1", "printf from-runner; exit 1");
    const r = s.checkTool("Bash", { command: "printf from-runner; exit 1" }, "t1");
    await tick();
    s.uiRespond({ id: s.t.state.pendingUi[0]!.id, allow: false, runMyself: true });
    expect((await r).allow).toBe(false);
    for (let i = 0; i < 200 && card().userRun?.status !== "done"; i++) await Bun.sleep(5);
    expect(card().userRun).toMatchObject({ status: "done", exitCode: 1, output: "from-runner" });
    await tick();
    // The turn is running: it goes in as a message the agent takes next.
    expect(JSON.stringify([s.t.state.pending, continued])).toContain("<bash-stdout>from-runner");
  });
});

describe("timed full access", () => {
  test("sets guardUntil, remembers the mode, and goes back to it with one notice", async () => {
    const { s, browser } = fake("ask");
    (s as any).prefsLoaded = true;
    s.setGuard("full", 15);
    expect(browser.state.guard).toBe("full");
    expect(browser.state.guardUntil! - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(prefs(s.id)).toMatchObject({ guard: "full", guardBefore: "ask" });
    // Extending it keeps the mode it goes back to.
    s.setGuard("full", 30);
    expect(prefs(s.id).guardBefore).toBe("ask");
    (s as any).endTimedAccess();
    expect(browser.state.guard).toBe("ask");
    expect(browser.state.guardUntil ?? undefined).toBeUndefined();
    expect(prefs(s.id).guardUntil).toBeUndefined();
    const notices = browser.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text);
    expect(notices).toEqual(["Full access ended · back to Ask"]);
  });

  test("setting any mode ends the timer", () => {
    const { s, browser } = fake("auto");
    s.setGuard("full", 15);
    s.setGuard("edits");
    expect(browser.state).toMatchObject({ guard: "edits" });
    expect(browser.state.guardUntil ?? undefined).toBeUndefined();
    expect((s as any).guardTimer).toBeUndefined();
  });

  test("survives a restart; ended while the runner was down: back, with the notice", () => {
    const { s } = fake("auto");
    Object.assign(prefs(s.id), { guard: "full", guardUntil: Date.now() + 60_000, guardBefore: "edits" });
    s.loadPrefs();
    expect(s.t.state).toMatchObject({ guard: "full" });
    expect(s.t.state.guardUntil).toBe(prefs(s.id).guardUntil!);
    expect((s as any).guardTimer).toBeDefined();
    const { s: t } = fake("auto");
    Object.assign(prefs(t.id), { guard: "full", guardUntil: Date.now() - 1, guardBefore: "edits" });
    t.loadPrefs();
    expect(t.t.state.guard).toBe("edits");
    expect(t.t.messages.at(-1)!.parts[0]).toEqual({ type: "text", text: "Full access ended · back to Accept edits" });
  });
});
