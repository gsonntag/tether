// Moving between harnesses through the neutral format: three harnesses in every direction, with
// nothing pairwise anywhere, and the real adapters' export and import against recorded fixtures.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEVELS, type PortableItem } from "../../../../shared/move";
import { HARNESS_LABELS, type HarnessId, type Msg } from "../../../../shared/transcript";
import { claudeAdapter } from "../../adapters/claude";
import { entriesOf, withSummaries } from "../../adapters/claude/move";
import { chainMessages } from "../../adapters/claude/history";
import { StoreFile } from "../../adapters/claude/jsonl";
import { codexAdapter } from "../../adapters/codex";
import { historyMsgs } from "../../adapters/codex/items";
import { batches, importedFrom, itemOf } from "../../adapters/codex/move";
import { saveConfig } from "../../config";
import type { Adapter, ImportRequest } from "../../core/adapter";
import { FakeAdapter } from "../../core/fakeAdapter";
import { movedDir } from "../../core/moved";
import { createRunner } from "../../core/runner";
import { levelOf, Mover, refusal, targetMode } from ".";

(HARNESS_LABELS as Record<string, string>).pi = "Pi";
(HARNESS_LABELS as Record<string, string>).omp = "Omp";

/** A harness only by what it declares: `native` imports through the neutral format, else the file route. */
class Neutral extends FakeAdapter {
  imports: ImportRequest[] = [];
  failImport = false;
  constructor(id: string, native: boolean, window?: number) {
    super();
    Object.assign(this, { id });
    this.capabilities = { ...this.capabilities, move: { import: native ? "native" : "context" } };
    this.move = {
      modes: [
        { mode: "ro", level: LEVELS.readOnly },
        { mode: "ask", level: LEVELS.ask },
        { mode: "all", level: LEVELS.full },
      ],
      ...(native
        ? {
            importHistory: async (r: ImportRequest) => {
              if (this.failImport) throw new Error("no");
              this.imports.push(r);
              this.addStored(r.nativeId, r.items.map((i, n) => ({ id: `i${n}`, role: i.role, ts: n, parts: [{ type: "text" as const, text: i.text }] })), { id: `${id}:${r.nativeId}`, harness: id as HarnessId, title: r.title, projectPath: r.projectPath });
            },
          }
        : {}),
      contextWindow: async () => window,
    };
  }
  move: Adapter["move"];
  override billing: NonNullable<Adapter["billing"]> = { keys: ["anthropic"], label: (source) => (source === "subscription" ? { kind: "plan", label: "Plan" } : { kind: "apiKey", label: "Key" }), loggedIn: async () => true };
  newId(): string {
    return `n${this.drivers.length}-${Math.random().toString(36).slice(2, 8)}`;
  }
  stored_(native: string, msgs: Msg[]) {
    return this.addStored(native, msgs, { id: `${this.id}:${native}`, harness: this.id as HarnessId, projectPath: tmp });
  }
}

const tmp = mkdtempSync(join(tmpdir(), "tether-move-"));
const stops: (() => void)[] = [];
afterEach(() => stops.splice(0).forEach((f) => f()));

function setup(adapters: Adapter[]) {
  const dir = mkdtempSync(join(tmpdir(), "tether-move-run-"));
  const prefsFile = join(dir, "runner.json");
  saveConfig({ runnerId: "t" }, prefsFile);
  const runner = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters, prefsFile, core: { evictMs: 60_000 } });
  stops.push(() => runner.core.stop());
  const logs: string[] = [];
  const mover = new Mover({ sessions: runner.look.sessions as any, dataDir: join(dir, "modules/move"), log: (l) => logs.push(l) });
  return { runner, mover, dir, logs };
}

const convo: Msg[] = [
  { id: "u1", role: "user", ts: 10, parts: [{ type: "text", text: "Run ls" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] },
  { id: "a1", role: "assistant", ts: 11, parts: [{ type: "tool", id: "call_native_1", name: "bash", kind: "shell", input: { command: "ls" }, command: "ls", status: "done", output: "vault-4417.txt" }, { type: "text", text: "One file." }] },
];

describe("a source change (Mover.carry)", () => {
  test("the same harness, settings and history, unlisted and marked as taking over", async () => {
    const pi = new Neutral("pi", true);
    const carried: [string, string][] = [];
    pi.move!.carried = (n, from) => void carried.push([n, from]);
    const { mover, runner } = setup([pi]);
    pi.stored_("s1", convo);
    const s = await runner.core.open("pi:s1");
    s.setState({ model: "m1", effort: "low", permissionMode: "ro" });
    const id = await mover.carry("pi:s1", "subscription");
    expect(id.startsWith("pi:")).toBe(true);
    expect(pi.imports[0]!.items.map((i) => i.text).join("\n")).toContain("vault-4417.txt");
    expect(carried).toEqual([[id.slice(3), "s1"]]);
    expect(pi.drivers.at(-1)!.opts).toMatchObject({ model: "m1", effort: "low", permissionMode: "ro" });
    expect(runner.core.book.all().sessions.map((r) => r.id)).not.toContain(id);
  });

  test("a failed import leaves no thread and uses no file route, where a move would", async () => {
    const pi = new Neutral("pi", true);
    pi.failImport = true;
    const dropped: string[] = [];
    pi.move!.discard = async (n) => void dropped.push(n);
    const { mover, runner } = setup([pi]);
    pi.stored_("s1", convo);
    await runner.core.open("pi:s1");
    await expect(mover.carry("pi:s1", "subscription")).rejects.toThrow("no");
    expect(dropped).toHaveLength(1);
    expect(pi.drivers).toHaveLength(0);
  });

  test("cut to fit, the notice says so in the move's own words; and nothing else", async () => {
    const pi = new Neutral("pi", true, 4_000);
    const { mover, runner } = setup([pi]);
    pi.stored_("s1", Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? ("assistant" as const) : ("user" as const), ts: i, parts: [{ type: "text" as const, text: `word `.repeat(4000) }] })));
    await runner.core.open("pi:s1");
    const id = await mover.carry("pi:s1", "subscription");
    await runner.core.subscribe(id);
    const notices = runner.core.sessions.get(id)!.transcript!.messages.filter((m) => m.role === "notice").map((m) => (m.parts[0] as any).text);
    expect(notices).toEqual(["40 messages in a file the agent can read."]);
  });
});

describe("N-way: three harnesses, every direction, one code path", () => {
  const a = () => new Neutral("pi", true);
  const b = () => new Neutral("omp", true);
  const c = () => new Neutral("codex", false);
  for (const [fromI, toI] of [[0, 1], [1, 0], [0, 2], [2, 0], [1, 2], [2, 1]] as const) {
    test(`${fromI} to ${toI}`, async () => {
      const all = [a(), b(), c()];
      const from = all[fromI]!;
      const to = all[toI]!;
      const { mover, runner, dir } = setup(all);
      from.stored_("s1", convo);
      await runner.core.open(`${from.id}:s1`);
      const before = JSON.stringify(from.stored.get("s1")!.msgs);
      const r = await mover.move(`${from.id}:s1`, to.id, { model: "m" });
      expect(r.sessionId.startsWith(`${to.id}:`)).toBe(true);
      // The source's own store isn't touched.
      expect(JSON.stringify(from.stored.get("s1")!.msgs)).toBe(before);
      expect(from.stored.size).toBe(1);
      const file = join(movedDir(r.sessionId, join(dir, "modules/move")), "history.md");
      expect(readFileSync(file, "utf8")).toContain("vault-4417.txt");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      if (to.capabilities.move!.import === "native") {
        const text = to.imports[0]!.items.map((i) => i.text).join("\n");
        expect(text).toContain("vault-4417.txt");
        expect(text).not.toContain("call_native_1");
      } else expect(to.drivers[0]!.sent[0]).toContain(file);
    });
  }

  test("it is linked both ways, and neither session loses its transcript", async () => {
    const pi = a();
    const omp = b();
    const { mover, runner } = setup([pi, omp]);
    pi.stored_("s1", convo);
    await runner.core.subscribe("pi:s1");
    const r = await mover.move("pi:s1", "omp", {});
    const old = runner.core.sessions.get("pi:s1")!.transcript!.messages.at(-1)!;
    expect((old.parts[0] as any).text).toBe("Moved to Omp.");
    expect(old.link?.sessionId).toBe(r.sessionId);
    await runner.core.subscribe(r.sessionId);
    const first = runner.core.sessions.get(r.sessionId)!.transcript!.messages.at(-1)!;
    expect((first.parts[0] as any).text).toBe("Moved from Pi.");
    expect(first.link?.sessionId).toBe("pi:s1");
  });

  test("a native import that fails falls back to the file; the agent still gets it all", async () => {
    const pi = a();
    const omp = b();
    omp.failImport = true;
    const { mover, runner, logs } = setup([pi, omp]);
    pi.stored_("s1", convo);
    await runner.core.open("pi:s1");
    const r = await mover.move("pi:s1", "omp", {});
    expect(logs.join()).toContain("using the file");
    expect(omp.drivers[0]!.sent[0]).toContain("history.md");
    expect(r.sessionId.startsWith("omp:")).toBe(true);
  });

  test("the options list every other harness that declares a route, with the mode it would get", async () => {
    const pi = a();
    const { mover, runner } = setup([pi, b(), c(), new FakeAdapter() /* no capability */]);
    pi.stored_("s1", convo);
    await runner.core.open("pi:s1");
    runner.core.sessions.get("pi:s1")!.setState({ permissionMode: "ask" });
    const o = await mover.options("pi:s1");
    expect(o.targets.map((t) => t.harness as string).sort()).toEqual(["codex", "omp"]);
    expect(o.targets.every((t) => t.permissionMode === "ask")).toBe(true);
    expect(o.blocked).toBeUndefined();
  });
});

describe("the source a move goes to", () => {
  function keyed(adapters: Adapter[], source: "subscription" | "anthropic", deployment?: string) {
    const dir = mkdtempSync(join(tmpdir(), "tether-move-keys-"));
    const prefsFile = join(dir, "runner.json");
    saveConfig({ runnerId: "t" }, prefsFile);
    const snapshot = (asked: string) => (asked === "subscription" ? { source: asked, revision: "subscription" } : { source: asked, revision: "r1", key: "never-in-prefs-000", ...(deployment ? { deployment } : {}) });
    const credentials = { snapshot, status: () => ({ anthropic: { set: source === "anthropic", ...(deployment ? { deployment } : {}) }, openai: { set: false }, azure: { set: false } }) };
    const runner = createRunner({ url: "http://x", token: "t", runnerId: "t", name: "t", version: "0", detectHarnesses: async () => [], adapters, prefsFile, credentials: credentials as any } as any);
    stops.push(() => runner.core.stop());
    return { runner, prefsFile, mover: new Mover({ sessions: runner.look.sessions as any, dataDir: join(dir, "m"), log: () => {} }) };
  }
  test("the dialog lists what exists, and the session gets the one chosen; prefs never hold a key", async () => {
    const pi = new Neutral("pi", true);
    const omp = new Neutral("omp", true);
    const seen: any[] = [];
    const newId = omp.newId.bind(omp);
    omp.newId = ((_p: string, o: any) => (seen.push(o), newId())) as any;
    const { mover, runner, prefsFile } = keyed([pi, omp], "anthropic");
    pi.stored_("s1", convo);
    await runner.core.open("pi:s1");
    const options = await mover.options("pi:s1");
    const omps = options.targets.find((t) => (t.harness as string) === "omp")!;
    expect(omps.sources?.options.map((o) => o.billing.label)).toEqual(["Plan", "Key"]);
    expect(omps.sources?.default).toBe("subscription");
    const r = await mover.move("pi:s1", "omp", { source: "anthropic" });
    expect(seen[0].credential.revision).toBe("r1");
    expect(runner.core.sessions.get(r.sessionId)!.driver).toBeDefined();
    expect(runner.core.o.prefs.get(r.sessionId).source).toBe("anthropic");
    expect((await runner.look.sessions.sources("omp" as any)).default).toBe("subscription");
    runner.core.o.prefs.flush();
    expect(readFileSync(prefsFile, "utf8")).not.toContain("never-in-prefs");
  });
  test("no source asked for is the subscription, whatever keys are set", async () => {
    const pi = new Neutral("pi", true);
    const omp = new Neutral("omp", true);
    const { mover, runner } = keyed([pi, omp], "anthropic");
    pi.stored_("s1", convo);
    await runner.core.open("pi:s1");
    const r = await mover.move("pi:s1", "omp", {});
    expect((omp.drivers[0]!.opts as any).credential.source).toBe("subscription");
    expect(runner.core.o.prefs.get(r.sessionId).source).toBe("subscription");
  });
  test("the same harness offers only another source, keeps the mode, and leaves the old session", async () => {
    const pi = new Neutral("pi", true);
    const omp = new Neutral("omp", true);
    const { mover, runner } = keyed([pi, omp], "anthropic");
    pi.stored_("s1", convo);
    const look = await runner.core.open("pi:s1");
    look.setState({ permissionMode: pi.move!.modes.at(-1)!.mode });
    const same = (await mover.options("pi:s1")).targets.find((t) => (t.harness as string) === "pi")!;
    expect(same.sameHarness).toBe(true);
    expect(same.sources?.options.map((o) => o.source)).toEqual(["anthropic"]);
    expect(same.sources?.default).toBe("anthropic");
    expect(same.permissionMode).toBe(pi.move!.modes.at(-1)!.mode);
    await expect(mover.move("pi:s1", "pi", {})).rejects.toThrow("already");
    await expect(mover.move("pi:s1", "pi", { source: "subscription" })).rejects.toThrow("already");
    const r = await mover.move("pi:s1", "pi", { source: "anthropic" });
    expect(r.sessionId).not.toBe("pi:s1");
    expect(pi.imports).toHaveLength(1);
    expect(runner.core.o.prefs.get(r.sessionId).source).toBe("anthropic");
    expect(runner.core.o.prefs.get("pi:s1").source).toBe("subscription");
    // A new session on the key: what came across was spent in the old one, so its cost starts whole.
    expect(runner.core.o.costs!.get(r.sessionId)).toEqual({ usd: 0, estimated: false, complete: true });
    expect(runner.core.o.prefs.get(r.sessionId).metered).toBe(true);
    expect(runner.core.o.costs!.has("pi:s1")).toBe(false);
    const old = await runner.core.open("pi:s1");
    await runner.core.load(old);
    expect(JSON.stringify(old.transcript!.messages)).toContain("Moved to Key.");
  });
  test("the same harness isn't offered when it has no other source", async () => {
    const pi = new Neutral("pi", true);
    const omp = new Neutral("omp", true);
    const { mover, runner } = keyed([pi, omp], "subscription");
    pi.stored_("s1", convo);
    await runner.core.open("pi:s1");
    expect((await mover.options("pi:s1")).targets.map((t) => t.harness as string)).toEqual(["omp"]);
  });
  test("the moved session starts with a fresh snapshot, so the harness confirms the source now", async () => {
    const pi = new Neutral("pi", true);
    const omp = new Neutral("omp", true);
    const { mover, runner } = keyed([pi, omp], "subscription");
    pi.stored_("s1", convo);
    await runner.core.open("pi:s1");
    const r = await mover.move("pi:s1", "omp", {});
    expect((omp.drivers[0]!.opts as any).credential.source).toBe("subscription");
    expect(runner.core.sessions.get(r.sessionId)!.state.mode).toBe("live");
  });
  test("a source that won't start stays an error on the session: no other source, no file route", async () => {
    const pi = new Neutral("pi", true);
    const omp = new Neutral("omp", true);
    omp.startError = "Anthropic API key failed.";
    const { mover, runner } = keyed([pi, omp], "anthropic");
    pi.stored_("s1", convo);
    await runner.core.open("pi:s1");
    const r = await mover.move("pi:s1", "omp", { source: "anthropic" });
    expect(omp.imports.length).toBe(1);
    expect(runner.core.sessions.get(r.sessionId)!.state.error).toContain("key failed");
  });
  test("an Azure deployment fixes the model", async () => {
    const pi = new Neutral("pi", true);
    const omp = new Neutral("omp", true);
    const { mover, runner } = keyed([pi, omp], "anthropic", "my-deploy");
    pi.stored_("s1", convo);
    await runner.core.open("pi:s1");
    expect((await mover.options("pi:s1")).targets[0]!.sources?.options.find((o) => o.source === "anthropic")?.deployment).toBe("my-deploy");
    const r = await mover.move("pi:s1", "omp", { model: "picked", source: "anthropic" });
    expect(runner.core.o.prefs.get(r.sessionId).model).toBeUndefined();
  });
  test("what a source is called, on the real adapters", () => {
    expect(claudeAdapter.billing!.label("anthropic")).toEqual({ kind: "apiKey", label: "Anthropic API key" });
    expect(claudeAdapter.billing!.label("subscription")).toEqual({ kind: "plan", label: "Claude plan" });
    expect(codexAdapter.billing!.label("azure")).toEqual({ kind: "provider", label: "Azure" });
    expect(codexAdapter.billing!.label("openai").label).toBe("OpenAI API key");
    expect(codexAdapter.billing!.label("subscription")).toEqual({ kind: "plan", label: "ChatGPT plan" });
  });
});

describe("what stops a move", () => {
  const look = (o: any = {}) => ({ summary: {}, status: "idle", requests: [], busy: false, ...o, state: { queue: [], requests: [], mode: "stored", ...o.state } }) as any;
  test("idle moves", () => expect(refusal(look())).toBeUndefined());
  test("a running turn", () => expect(refusal(look({ status: "running" }))).toContain("turn"));
  test("an open request", () => expect(refusal(look({ requests: ["r"] }))).toContain("request"));
  test("a terminal", () => {
    expect(refusal(look({ state: { mode: "terminal" } }))).toContain("terminal");
    expect(refusal(look({ state: { terminal: { kind: "shared" } } }))).toContain("terminal");
  });
  test("waiting messages", () => expect(refusal(look({ state: { queue: [{}] } }))).toContain("waiting"));
  test("a subagent", () => expect(refusal(look({ summary: { parentSessionId: "x" } }))).toContain("main session"));
  test("the op says so and makes nothing", async () => {
    const pi = new Neutral("pi", true);
    const omp = new Neutral("omp", true);
    const { mover, runner } = setup([pi, omp]);
    pi.stored_("s1", convo);
    const s = await runner.core.open("pi:s1");
    s.setState({ status: "running" });
    await expect(mover.move("pi:s1", "omp", {})).rejects.toThrow("Wait for the turn");
    expect(omp.imports.length).toBe(0);
  });
  test("an empty session and an unknown target", async () => {
    const pi = new Neutral("pi", true);
    const omp = new Neutral("omp", true);
    const { mover, runner } = setup([pi, omp]);
    pi.stored_("s1", []);
    await runner.core.open("pi:s1");
    await expect(mover.move("pi:s1", "omp", {})).rejects.toThrow("Nothing to move");
    await expect(mover.move("pi:s1", "gemini", {})).rejects.toThrow("no gemini");
    await expect(mover.move("pi:s1", "pi", {})).rejects.toThrow("already");
  });
});

test("background work moves on: it's told to the agent and shown", async () => {
  const pi = new Neutral("pi", true);
  const omp = new Neutral("omp", true);
  pi.backgroundRuns = async () => true;
  const { mover, runner } = setup([pi, omp]);
  pi.stored_("s1", convo);
  await runner.core.open("pi:s1");
  expect((await mover.options("pi:s1")).background).toBe(true);
  const r = await mover.move("pi:s1", "omp", {});
  expect(omp.imports[0]!.items[0]!.text).toContain("Background work keeps running");
  await runner.core.subscribe(r.sessionId);
  expect((runner.core.sessions.get(r.sessionId)!.transcript!.messages.at(-1)!.parts[0] as any).text).toContain("Background work stayed there.");
});

test("a history over the window: the rest stays readable, and the notice says what happened", async () => {
  const pi = new Neutral("pi", true);
  const omp = new Neutral("omp", true, 16_000);
  const { mover, runner, dir } = setup([pi, omp]);
  pi.stored_("s1", Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? ("assistant" as const) : ("user" as const), ts: i, parts: [{ type: "text" as const, text: `line ${i} ${"x".repeat(1000)}` }] })));
  await runner.core.open("pi:s1");
  const r = await mover.move("pi:s1", "omp", {});
  expect(omp.imports[0]!.items.length).toBeLessThan(100);
  expect(readFileSync(join(movedDir(r.sessionId, join(dir, "modules/move")), "history.md"), "utf8")).toContain("line 0 ");
  await runner.core.subscribe(r.sessionId);
  expect((runner.core.sessions.get(r.sessionId)!.transcript!.messages.at(-1)!.parts[0] as any).text).toMatch(/\d+ of 200 messages in context/);
});

test("attachments are copied with the history, images are files", async () => {
  const pi = new Neutral("pi", true);
  const omp = new Neutral("omp", true);
  const { dir, runner } = setup([pi, omp]);
  const att = join(dir, "attachments/pi_s1");
  mkdirSync(att, { recursive: true });
  writeFileSync(join(att, "spec.pdf"), "pdf");
  const mover = new Mover({ sessions: runner.look.sessions as any, dataDir: join(dir, "m"), log: () => {}, attachmentsDir: join(dir, "attachments") });
  pi.stored_("s1", [{ id: "u", role: "user", ts: 1, parts: [{ type: "text", text: `Look\n- ${att}/spec.pdf (application/pdf, 3 B)` }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] }, { id: "a", role: "assistant", ts: 2, parts: [{ type: "text", text: "ok" }] }]);
  await runner.core.open("pi:s1");
  const r = await mover.move("pi:s1", "omp", {});
  const d = movedDir(r.sessionId, join(dir, "m"));
  expect(readFileSync(join(d, "attachments/0-spec.pdf"), "utf8")).toBe("pdf");
  expect(existsSync(join(d, "images/u-0.png"))).toBe(true);
  expect(readFileSync(join(d, "history.md"), "utf8")).toContain(`${d}/attachments/0-spec.pdf`);
});

test("a session moved twice keeps what didn't fit the first time in its file", async () => {
  const pi = new Neutral("pi", true);
  const omp = new Neutral("omp", true);
  const { dir, mover, runner } = setup([pi, omp]);
  pi.stored_("s1", convo);
  await runner.core.open("pi:s1");
  const r1 = await mover.move("pi:s1", "omp", {});
  const r2 = await mover.move(r1.sessionId, "pi", {});
  const md = readFileSync(join(movedDir(r2.sessionId, join(dir, "modules/move")), "history.md"), "utf8");
  expect(md).toContain("# Before that");
  expect(md).toContain("vault-4417.txt");
});

describe("permissions never loosen (the table in SPEC §15)", () => {
  const go = (from: Adapter, mode: string | undefined, to: Adapter) => targetMode(from, mode, to);
  test.each([
    ["plan", "read-only"],
    ["default", "untrusted"],
    ["dontAsk", "untrusted"],
    ["acceptEdits", "untrusted"],
    ["auto", "auto"],
    ["bypassPermissions", "full-access"],
    ["somethingNew", "read-only"],
  ])("Claude %s to Codex %s", (m, want) => expect(go(claudeAdapter, m, codexAdapter)).toBe(want));
  test.each([
    ["read-only", "plan"],
    ["untrusted", "default"],
    ["auto", "acceptEdits"],
    ["full-access", "bypassPermissions"],
    ["auto@codex-reviews", "acceptEdits"],
    ["never+read-only", "plan"],
    ["untrusted+danger-full-access", "default"],
    ["on-request+danger-full-access", "acceptEdits"],
    ["custom", "plan"],
    ["unknown", "plan"],
  ])("Codex %s to Claude %s", (m, want) => expect(go(codexAdapter, m, claudeAdapter)).toBe(want));
  test("no mode set at all is the safest", () => {
    expect(go(codexAdapter, undefined, claudeAdapter)).toBe("plan");
    expect(go(claudeAdapter, undefined, codexAdapter)).toBe("read-only");
  });
  test("a target's level is never over its source's, for every mode either has", () => {
    for (const [a, b] of [[claudeAdapter, codexAdapter], [codexAdapter, claudeAdapter]] as const)
      for (const { mode } of a.move!.modes) expect(levelOf(b, go(a, mode, b))!).toBeLessThanOrEqual(levelOf(a, mode)!);
  });
});

describe("real stores", () => {
  const items: PortableItem[] = [
    { role: "user", text: "[From Tether] This session moved here from Codex (\"T\"), in /p.", ts: 5 },
    { role: "user", text: "look", images: [{ mimeType: "image/png", data: "iVBORw0KGgo=" }], ts: 6 },
    { role: "assistant", text: "**Tool: bash** ...", ts: 7 },
  ];
  test("Claude: lines chain, and Tether's own reader shows them as sent", () => {
    const lines = entriesOf({ nativeId: "s", projectPath: "/p", items });
    const f = new StoreFile("/x/s.jsonl");
    lines.forEach((l) => (f as any).add(l));
    const m = chainMessages(f.chain());
    expect(m.map((x) => x.role)).toEqual(["user", "user", "assistant"]);
    expect(m[0]!.origin?.kind).toBe("tether");
    expect(m[1]!.parts[1]!.type).toBe("image");
    expect(m[2]!.model).toBeUndefined();
    expect(f.settings.model).toBeUndefined();
  });
  test("Claude: a compaction's summary is exported, from a real store", () => {
    const lines = readFileSync(join(import.meta.dir, "../../adapters/claude/fixtures/store/context.jsonl"), "utf8").trim().split("\n");
    const f = new StoreFile("/x/s.jsonl");
    lines.forEach((l) => (f as any).add(l));
    const msgs = chainMessages(f.chain());
    expect(withSummaries(msgs, f.chain()).length).toBe(msgs.length);
    const summary = { uuid: "s", type: "user", isCompactSummary: true, message: { content: "They chose Postgres." }, order: 1 } as any;
    expect(withSummaries([{ id: "c", role: "notice", ts: 1, parts: [{ type: "text", text: "Context compacted." }] }], [summary])[0]!.compactSummary).toBe("They chose Postgres.");
  });
  test("Codex: real turns export with tool calls and outputs", () => {
    const turns = JSON.parse(readFileSync(join(import.meta.dir, "../../adapters/codex/fixtures/approval-steer-turns.json"), "utf8"));
    const msgs = historyMsgs(turns.data ?? turns, "/p");
    expect(msgs.some((m) => m.parts.some((p) => p.type === "tool"))).toBe(true);
  });
  test("Codex: only plain messages are injected", () => {
    const [u, , a] = items.map(itemOf);
    expect(u!.content[0]).toMatchObject({ type: "input_text" });
    expect(a).toEqual({ type: "message", role: "assistant", content: [{ type: "output_text", text: items[2]!.text }] } as any);
    expect(itemOf(items[1]!).content[1]).toEqual({ type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" } as any);
  });
  test("Codex: the imported history reads back from a rollout, not what came before or after", () => {
    const line = (o: any) => JSON.stringify({ timestamp: "2026-11-01T00:00:00Z", ...o });
    const msg = (role: string, type: string, text: string, id: string) => line({ type: "response_item", payload: { type: "message", id, role, content: [{ type, text }] } });
    const rollout = [
      msg("developer", "input_text", "You are Codex", "d"),
      msg("user", "input_text", "<environment_context>", "e"),
      msg("user", "input_text", '[From Tether] This session moved here from Claude Code ("T")', "1"),
      msg("assistant", "output_text", "old reply", "2"),
      line({ type: "event_msg", payload: { type: "task_started" } }),
      msg("user", "input_text", "new turn", "3"),
    ].join("\n");
    const m = importedFrom(rollout);
    expect(m.map((x) => x.id)).toEqual(["m-1", "m-2"]);
    expect(m[0]!.origin?.kind).toBe("tether");
  });
  test("Codex: big imports go in batches, in order", () => {
    expect(batches([3, 3, 3, 1], (n) => n, 6)).toEqual([[3, 3], [3, 1]]);
  });
});
