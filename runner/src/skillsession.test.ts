// `/skill` through a live session: joined waiting messages, the typed text a handoff gets, and a
// steer whose resolution waits on a slow harness.

import { HOME, resetHome } from "./testenv";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LiveSession } from "./session";
import type { NativeSkill } from "./skillcmd";

const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
const sessions: LiveSession[] = [];
let repo: string;

beforeAll(() => {
  LiveSession.STEER_GRACE_MS = 20;
});
beforeEach(() => {
  resetHome();
  repo = join(HOME, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  for (const n of ["haiku", "limerick"]) {
    mkdirSync(join(repo, ".agents/skills", n), { recursive: true });
    writeFileSync(join(repo, ".agents/skills", n, "SKILL.md"), `---\ndescription: ${n}\n---\nWrite a ${n}.\n`);
  }
});
afterEach(() => sessions.splice(0).forEach((s) => s.close()));

/** A pi-like harness: runs its skills as `/skill:name`, only at the start of a message. */
function fake(o: { native?: () => Promise<NativeSkill[] | undefined> } = {}) {
  const log: string[] = [];
  const typed: (string | undefined)[] = [];
  class Fake extends LiveSession {
    async start() {}
    protected async send(text: string) {
      typed.push((this as any).outgoing?.typed);
      log.push(`turn: ${text}`);
      this.setState({ status: "running" });
    }
    protected async steer(text: string) {
      log.push(`steer: ${text}`);
      return true;
    }
    async endTurn() {
      if (!(await this.drainPending())) this.setState({ status: "idle" });
    }
    async abort() {}
    async applyModel() {}
    async setThinking() {}
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn() {}
    protected shutdown() {}
    protected async nativeSkills() {
      return o.native ? o.native() : [{ name: "haiku" }, { name: "limerick" }];
    }
    protected nativeSkillText(name: string, args: string) {
      return args ? `/skill:${name} ${args}` : `/skill:${name}`;
    }
  }
  const s = new Fake("pi", { nativeId: crypto.randomUUID(), projectPath: repo }, sink);
  s.t.state.status = "idle";
  sessions.push(s);
  return { s, log, typed };
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe("/skill in a live session", () => {
  test("native at the start of a message; send() knows what was typed", async () => {
    const { s, log, typed } = fake();
    await s.prompt("/haiku the sea");
    expect(log).toEqual(["turn: /skill:haiku the sea"]);
    expect(typed).toEqual(["/haiku the sea"]);
  });

  test("joined waiting messages: only the first can be native, the rest are expanded", async () => {
    const { s, log } = fake();
    await s.prompt("go");
    await s.prompt("/haiku a", "followUp");
    await s.prompt("/limerick b", "followUp");
    s.t.state.pending = s.t.state.pending!.map((p) => ({ ...p, mode: "followUp" }));
    await (s as any).endTurn();
    const turns = log.filter((l) => l.startsWith("turn:"));
    expect(turns[1]).toBe("turn: /skill:haiku a");
    // one queued message per turn
    await (s as any).endTurn();
    expect(log.filter((l) => l.startsWith("turn:"))[2]).toBe("turn: /skill:limerick b");
  });

  test("steers joined into one: the second skill is expanded, not left as a dead /skill:name", async () => {
    const { s, log } = fake();
    await s.prompt("go");
    const now = Date.now();
    s.t.state.pending = ["/haiku a", "/limerick b"].map((text, i) => ({ id: `p${i}`, text, mode: "steer", ts: now, readyAt: now }));
    await (s as any).deliverSteers();
    const steer = log.find((l) => l.startsWith("steer:"))!;
    expect(steer.startsWith("steer: /skill:haiku a\n\n<skill name=\"limerick\"")).toBe(true);
  });

  test("a slow harness: the turn ending while a steer is resolved keeps the order", async () => {
    const waiting: (() => void)[] = [];
    const release = () => waiting.splice(0).forEach((f) => f());
    const slow = () => new Promise<NativeSkill[]>((r) => waiting.push(() => r([{ name: "haiku" }])));
    const { s, log } = fake({ native: slow });
    // the first answer is quick so the turn starts
    LiveSession.NATIVE_TIMEOUT_MS = 5_000;
    (s as any).nativeCache = { at: 0, skills: [] };
    await s.prompt("go");
    await s.prompt("/haiku a", "steer");
    await s.prompt("after", "followUp");
    await tick(); // steer delivery is now waiting on the harness
    const ended = (s as any).endTurn(); // the turn ends meanwhile: the steer starts the next turn
    await tick(10);
    release();
    await ended;
    await tick();
    const turns = log.filter((l) => l.startsWith("turn:"));
    expect(log.some((l) => l.startsWith("steer:"))).toBe(false);
    expect(turns[1]).toBe("turn: /skill:haiku a");
    expect(s.t.state.pending?.map((p) => p.text)).toEqual(["after"]);
  });
});
