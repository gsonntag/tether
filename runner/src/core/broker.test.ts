import { describe, expect, test } from "bun:test";
import type { Request } from "../../../shared/transcript";
import { RESOLVED_ELSEWHERE } from "./adapter";
import { ALREADY_ANSWERED, CHECKING_MS, DENIED, DISMISSED, NOT_OPEN, RequestBroker, requestKey, type BrokerHooks, type PolicyStep, type SavedRequest } from "./broker";

const req = (id: string, over: Partial<Request> = {}): Request => ({ id, sessionId: "claude:s1", kind: "approval", tool: "Write", input: { file_path: "/p/a.txt", content: "hi" }, openedAt: 1, ...over });
const ctx = { projectPath: "/p" };

function recorder() {
  const log: string[] = [];
  const hooks: BrokerHooks = {
    changed: (ids) => log.push(`changed ${ids.join(",")}`),
    opened: (r) => log.push(`opened ${r.id}`),
    closed: (r, outcome, how) => log.push(`closed ${r.id} ${outcome} ${how.source}${how.restored ? " restored" : ""}`),
  };
  return { log, hooks };
}

describe("the request broker", () => {
  test("with no policy steps every request waits for a person; the first answer wins", async () => {
    const b = new RequestBroker();
    const { log, hooks } = recorder();
    b.hooks = hooks;
    const p = b.decide(req("r1"), ["claude:s1"], ctx);
    await Bun.sleep(0);
    expect(b.forSession("claude:s1").map((r) => r.id)).toEqual(["r1"]);
    b.answer("r1", { allow: true });
    expect(await p).toEqual({ allow: true, source: "person", requestId: "r1" });
    expect(() => b.answer("r1", { allow: false })).toThrow(ALREADY_ANSWERED);
    expect(() => b.answer("nope", { allow: true })).toThrow(NOT_OPEN);
    expect(b.forSession("claude:s1")).toEqual([]);
    expect(log).toEqual(["opened r1", "changed claude:s1", "changed claude:s1", "closed r1 allowed person"]);
  });

  test("policy steps run in order; the first that decides wins, with its source and reason", async () => {
    const seen: string[] = [];
    const pass: PolicyStep = () => (seen.push("pass"), { verdict: "undecided" });
    const broken: PolicyStep = () => {
      seen.push("broken");
      throw new Error("boom");
    };
    const judge: PolicyStep = (r, c) => (seen.push(`judge ${c.rootSessionId}`), r.tool === "Write" ? { verdict: "deny", source: "judge", reason: "Writes outside src/" } : { verdict: "undecided" });
    const reads: PolicyStep = (r) => (seen.push("reads"), r.tool === "Read" ? { verdict: "allow", source: "rule" } : { verdict: "undecided" });
    const { log, hooks } = recorder();
    const b = new RequestBroker([pass, broken, judge, reads], { log: () => {} });
    b.hooks = hooks;
    expect(await b.decide(req("r1"), ["claude:s1/a", "claude:s1"], ctx)).toEqual({ allow: false, reason: "Writes outside src/", source: "judge", requestId: "r1" });
    expect(seen).toEqual(["pass", "broken", "judge claude:s1"]);
    expect(log).toEqual(["opened r1", "closed r1 denied judge"]);
    // A request a step decided is never shown, and can't be answered.
    expect(b.forSession("claude:s1")).toEqual([]);
    expect(() => b.answer("r1", { allow: true })).toThrow(ALREADY_ANSWERED);
    expect(await b.decide(req("r0", { tool: "Read" }), ["claude:s1"], ctx)).toMatchObject({ allow: true, source: "rule" });
    // Undecided by every step: a person decides.
    const p = b.decide(req("r2", { tool: "Bash", input: { command: "ls" } }), ["claude:s1"], ctx);
    await Bun.sleep(0);
    expect(b.forSession("claude:s1").map((r) => r.id)).toEqual(["r2"]);
    b.answer("r2", { allow: false, reason: "not now" });
    expect(await p).toMatchObject({ allow: false, reason: "The user denied this request and said: not now", source: "person" });
  });

  test("answers: a plain deny stops the turn, a question carries its answers, approving may switch the mode", async () => {
    const b = new RequestBroker();
    const deny = b.decide(req("a"), ["s"], ctx);
    const q = b.decide(req("b", { kind: "question", tool: "AskUserQuestion", questions: [{ question: "Color?", options: [{ label: "Red" }] }] }), ["s"], ctx);
    const skip = b.decide(req("c", { kind: "question", tool: "AskUserQuestion", input: { x: 1 } }), ["s"], ctx);
    const plan = b.decide(req("d", { tool: "ExitPlanMode", input: { plan: "do it" }, approveAs: [{ id: "acceptEdits", label: "Approve and accept edits" }] }), ["s"], ctx);
    await Bun.sleep(0);
    b.answer("a", { allow: false });
    expect(() => b.answer("b", { allow: true, answers: [" "] })).toThrow("Pick or type");
    b.answer("b", { allow: true, answers: ["Blue, Red"] });
    b.answer("c", { allow: false });
    expect(() => b.answer("d", { allow: true, mode: "bypassPermissions" })).toThrow("ways to approve");
    b.answer("d", { allow: true, mode: "acceptEdits" });
    expect(await deny).toMatchObject({ allow: false, reason: DENIED, interrupt: true });
    expect(await q).toMatchObject({ allow: true, answers: ["Blue, Red"] });
    expect(await skip).toMatchObject({ allow: false, reason: DISMISSED });
    expect((await skip as any).interrupt).toBeUndefined();
    expect(await plan).toMatchObject({ allow: true, mode: "acceptEdits" });
  });

  test("a harness that stops waiting closes the request: cancelled, or resolved elsewhere", async () => {
    const b = new RequestBroker();
    const { log, hooks } = recorder();
    b.hooks = hooks;
    const a = new AbortController();
    const e = new AbortController();
    const p1 = b.decide(req("r1"), ["s"], ctx, a.signal);
    const p2 = b.decide(req("r2", { input: { other: 1 } }), ["s"], ctx, e.signal);
    await Bun.sleep(0);
    a.abort();
    e.abort(RESOLVED_ELSEWHERE);
    expect(await p1).toMatchObject({ allow: false, source: "tether" });
    expect(await p2).toMatchObject({ allow: false, source: "tether" });
    expect(log.filter((l) => l.startsWith("closed"))).toEqual(["closed r1 cancelled tether", "closed r2 elsewhere tether"]);
    expect(() => b.answer("r1", { allow: true })).toThrow(NOT_OPEN);
    // Already aborted: never shown.
    const gone = new AbortController();
    gone.abort();
    expect(await b.decide(req("r3"), ["s"], ctx, gone.signal)).toMatchObject({ allow: false });
    expect(b.forSession("s")).toEqual([]);
  });

  test("a subagent's request shows in its session and every session above it", async () => {
    const b = new RequestBroker();
    void b.decide(req("r1", { sessionId: "claude:s1/a1" }), ["claude:s1/a1", "claude:s1"], ctx);
    await Bun.sleep(0);
    expect(b.forSession("claude:s1/a1").map((r) => r.id)).toEqual(["r1"]);
    expect(b.forSession("claude:s1").map((r) => r.id)).toEqual(["r1"]);
    expect(b.sessions().sort()).toEqual(["claude:s1", "claude:s1/a1"]);
    b.cancel((r) => r.sessionId === "claude:s1/a1");
    expect(b.forSession("claude:s1")).toEqual([]);
  });

  test("open requests are saved, and after a restart the harness asking again keeps the same id", async () => {
    let saved: SavedRequest[] = [];
    const a = new RequestBroker([], { persist: (l) => (saved = l) });
    const big = { file_path: "/p/a.txt", content: "x".repeat(100_000) };
    void a.decide(req("r1", { input: big }), ["claude:s1"], ctx);
    void a.decide(req("r2", { tool: "Bash", input: { command: "ls" } }), ["claude:s1"], ctx);
    await Bun.sleep(0);
    a.freeze();
    // Shutdown closes drivers; what was open stays saved.
    a.cancel(() => true);
    expect(saved.map((s) => s.request.id)).toEqual(["r1", "r2"]);
    expect(saved[0]!.request.inputTruncated).toBe(true);
    expect(saved[0]!.key).toBe(requestKey("Write", big));

    const { log, hooks } = recorder();
    const b = new RequestBroker([], { saved: JSON.parse(JSON.stringify(saved)), persist: (l) => (saved = l) });
    b.hooks = hooks;
    expect(b.forSession("claude:s1").map((r) => r.id)).toEqual(["r1", "r2"]);
    // r1 is answered before the harness asks again: the ask is decided at once, with r1's id.
    b.answer("r1", { allow: true });
    expect(log).toContain("closed r1 allowed person restored");
    expect(await b.decide(req("new-id", { input: { content: "x".repeat(100_000), file_path: "/p/a.txt" } }), ["claude:s1"], ctx)).toEqual({ allow: true, source: "person", requestId: "r1" });
    // r2 is still open: the new ask takes it over and waits on it.
    const p = b.decide(req("other-id", { tool: "Bash", input: { command: "ls" } }), ["claude:s1"], ctx);
    await Bun.sleep(0);
    expect(b.forSession("claude:s1").map((r) => r.id)).toEqual(["r2"]);
    b.answer("r2", { allow: false, reason: "no" });
    expect(await p).toMatchObject({ allow: false, requestId: "r2" });
    expect(saved).toEqual([]);
    // Another session asking the same is a different request.
    const q = b.decide(req("x", { sessionId: "claude:s2" }), ["claude:s2"], ctx);
    await Bun.sleep(0);
    expect(b.forSession("claude:s2").map((r) => r.id)).toEqual(["x"]);
    b.answer("x", { allow: true });
    await q;
  });
});

describe("slow policy steps", () => {
  test("a step slower than CHECKING_MS shows the request as being checked, unanswerable, and gets the signal", async () => {
    let seen: AbortSignal | undefined;
    let release!: (v: any) => void;
    const slow: PolicyStep = (_r, c) => ((seen = c.signal), new Promise((r) => (release = r)));
    const saved: unknown[] = [];
    const b = new RequestBroker([slow], { persist: (open) => saved.push(open) });
    const ac = new AbortController();
    const p = b.decide(req("r1"), ["s"], ctx, ac.signal);
    await Bun.sleep(CHECKING_MS + 50);
    expect(b.forSession("s")).toMatchObject([{ id: "r1", checking: true }]);
    expect(() => b.answer("r1", { allow: true })).toThrow("still checking");
    expect(seen).toBe(ac.signal);
    release({ verdict: "undecided" });
    await Bun.sleep(0);
    // Undecided: now a person's to answer.
    expect(b.forSession("s")[0]!.checking).toBeUndefined();
    expect(saved.flat().length).toBeGreaterThan(0);
    b.answer("r1", { allow: true });
    expect(await p).toMatchObject({ allow: true });
  });

  test("a step that decides after showing Checking… removes it", async () => {
    let release!: (v: any) => void;
    const b = new RequestBroker([() => new Promise((r) => (release = r))]);
    const p = b.decide(req("r1"), ["s"], ctx);
    await Bun.sleep(CHECKING_MS + 50);
    expect(b.forSession("s")).toHaveLength(1);
    release({ verdict: "allow", source: "judge" });
    expect(await p).toMatchObject({ allow: true, source: "judge" });
    expect(b.forSession("s")).toEqual([]);
  });

  test("a failing save never leaves the driver waiting", async () => {
    const b = new RequestBroker([], {
      persist: () => {
        throw new Error("disk full");
      },
      log: () => {},
    });
    const p = b.decide(req("r1"), ["s"], ctx);
    await Bun.sleep(0);
    b.answer("r1", { allow: true });
    expect(await p).toMatchObject({ allow: true });
  });
});

describe("review round 2", () => {
  test("a restored subagent request is taken over only by the same session asking", async () => {
    const key = requestKey("Write", { file_path: "/p/a.txt", content: "hi" });
    const b = new RequestBroker([], { saved: [{ request: req("old", { sessionId: "claude:s1/a1" }), key, chain: ["claude:s1/a1", "claude:s1"] }] });
    // Another subagent of the same session asks the same: a request of its own.
    const p = b.decide(req("new", { sessionId: "claude:s1/a2" }), ["claude:s1/a2", "claude:s1"], ctx);
    await Bun.sleep(0);
    expect(b.forSession("claude:s1").map((r) => r.id).sort()).toEqual(["new", "old"]);
    b.answer("new", { allow: true });
    expect(await p).toMatchObject({ requestId: "new" });
  });

  test("after freeze (shutting down) answers are refused, so nothing is acted on twice", async () => {
    const b = new RequestBroker();
    void b.decide(req("r1"), ["s"], ctx);
    await Bun.sleep(0);
    b.freeze();
    expect(() => b.answer("r1", { allow: true })).toThrow("restarting");
  });
});
