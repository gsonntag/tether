import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionMessage } from "../../../../shared/fromTether";
import { LEVELS } from "../../../../shared/move";
import { peerAction, peerTarget } from "../../../../shared/peers";
import type { HarnessId, Msg, SessionSummary } from "../../../../shared/transcript";
import { claudeMove } from "../../adapters/claude/move";
import { codexMove } from "../../adapters/codex/move";
import { VIEW_OPS } from "../../../../shared/access";
import { OpRegistry } from "../../core/ops";
import { writeFileSync } from "node:fs";
import { Children, CHILDREN_MAX, DEPTH_MAX, FAMILY_OPENS, MAX_REPORTS } from "./children";
import { CleanupWaits, Peers, peersModule } from "./index";
import { worktreeArg } from "../../../../shared/worktree";

const agyMove = {
  modes: [
    { mode: "plan", level: LEVELS.readOnly },
    { mode: "default", level: LEVELS.ask },
    { mode: "accept-edits", level: LEVELS.edits },
    { mode: "bypass", level: LEVELS.full },
  ],
} as any;

const row = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ id, harness: id.split(":")[0] as HarnessId, nativeId: id.split(":")[1]!, projectPath: "/p/app", title: id, mode: "live", status: "idle", updatedAt: 0, ...o });

function setup(o: { modes?: Record<string, string>; dataDir?: string; failFallback?: boolean } = {}) {
  const rows: SessionSummary[] = [row("claude:boss")];
  const modes: Record<string, string> = { "claude:boss": "auto", ...o.modes };
  const queued: { to: string; text: string }[] = [];
  const sent: { to: string; text: string }[] = [];
  const created: any[] = [];
  const calls: string[] = [];
  const archivedIds: string[] = [];
  const recent = new Map<string, Msg[]>();
  const looks = new Map<string, any>();
  let n = 0;
  const look = (id: string) => {
    const s = rows.find((r) => r.id === id);
    if (!s) return undefined;
    const l = looks.get(id) ?? { summary: s, status: "idle", requests: [], state: { mode: "live", queue: [], permissionMode: modes[id] } as any, busy: false, background: false };
    looks.set(id, l);
    l.state.permissionMode = modes[id];
    l.status = s.status;
    return l;
  };
  const offered: Record<string, string[]> = { claude: ["plan", "default", "acceptEdits", "auto", "bypassPermissions"], codex: ["read-only", "untrusted", "auto", "full-access"], antigravity: ["plan", "default", "accept-edits", "bypass"] };
  const models: Record<string, any[]> = { codex: [{ id: "default", label: "Default" }, { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["low", "high"] }] };
  const adapter = (id: string, move: any) => ({ id, move, listModels: async () => ({ models: models[id] ?? [], permissionModes: offered[id]!.map((m) => ({ id: m })) }) });
  const ctx: any = {
    log: () => {},
    dataDir: o.dataDir,
    session: look,
    sessions: {
      list: () => rows,
      open: async (id: string) => look(id) ?? Promise.reject(new Error("none")),
      adapters: () => [adapter("claude", claudeMove), adapter("codex", codexMove), adapter("antigravity", agyMove)],
      sources: async () => ({ options: [{ source: "subscription" }, { source: "azure", deployments: [{ name: "sol-deployment", model: "gpt-6.2-sol" }] }] }),
      folder: (p: string) => p,
      projects: async () => [{ path: "/p/app" }, { path: "/p/other" }],
      create: async (a: any) => {
        const id = `${a.harness}:c${++n}`;
        created.push({ id, ...a });
        rows.push(row(id, { projectPath: a.projectPath }));
        modes[id] = a.permissionMode;
        return id;
      },
      rename: async (id: string, t: string) => void (rows.find((r) => r.id === id)!.title = t),
      send: async (to: string, text: string) => void sent.push({ to, text }),
      queue: async (to: string, text: string) => {
        queued.push({ to, text });
        return { id: `q${queued.length}` };
      },
      notice: async () => {},
      setArchived: async (id: string, a: boolean) => {
        const r = rows.find((x) => x.id === id);
        if (!r) throw new Error("none");
        r.archived = a || undefined;
        if (a) archivedIds.push(id);
      },
      recent: async (id: string) => recent.get(id) ?? [],
    },
    ops: {
      call: async (op: string, a: any) => {
        calls.push(op);
        if (op === "setAutoKey") {
          if (o.failFallback) throw new Error("fallback unavailable");
          return null;
        }
        if (op === "listWorktrees") return a.projectPath === "/p/plain" ? { worktrees: [] } : { repo: "/p/app", worktrees: [{ path: "/p/app-wt", branch: "tether/x", sessions: [] }] };
        if (op === "existingWorktreeSession") return { sessionId: await ctx.sessions.create({ ...a, projectPath: a.worktree }), path: a.worktree, branch: "tether/x", tether: true };
        return { sessionId: await ctx.sessions.create(a), path: "/p/app-wt", branch: "tether/x", base: "main" };
      },
    },
  };
  const peers = new Peers(ctx);
  const start = (args: Record<string, unknown>, from = "claude:boss") => peers.call({ from, tool: "tether_start", args: { source: "subscription", ...args } } as any);
  const reply = (id: string, text: string) => recent.set(id, [{ id: "u", role: "user", ts: 0, parts: [{ type: "text", text: "go" }] }, { id: "a", role: "assistant", ts: 1, parts: [{ type: "text", text }] }]);
  const archive = (to: string, from = "claude:boss") => peers.call({ from, tool: "tether_archive", args: { to } } as any);
  const isArchived = (id: string) => !!rows.find((r) => r.id === id)?.archived;
  return { peers, start, archive, isArchived, archivedIds, queued, sent, created, modes, look, reply, rows, calls };
}

describe("tether_models", () => {
  test("lists each source's models; Azure's are its deployments", async () => {
    const t = setup();
    const r = await t.peers.call({ from: "claude:boss", tool: "tether_models", args: { harness: "codex" } } as any);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("Tether sets up each source's provider and key itself");
    expect(r.text).toContain("subscription:\n  - gpt-6-luna (GPT-6 Luna); effort: low, high");
    expect(r.text).toContain("azure (API key: confirm with the person first):\n  - sol-deployment (runs gpt-6.2-sol)");
    expect(r.text).not.toContain("- default");
    expect((await t.peers.call({ from: "claude:boss", tool: "tether_models", args: { harness: "nope" } } as any)).isError).toBe(true);
    expect(peerAction("mcp__tether__tether_models")).toBe("models");
  });
});

describe("tether_start", () => {
  test("defaults to subscription and never replaces an unavailable Azure model", async () => {
    const t = setup();
    const args = { harness: "codex", prompt: "go" };
    expect((await t.start({ ...args, source: "openai" })).text).toContain("Confirm what to bill to");
    expect((await t.start({ ...args, source: "azure", model: "gpt-6-luna" })).text).toContain("Choose a configured Azure deployment");
    expect(t.created).toHaveLength(0);
    expect((await t.start({ ...args, source: "azure", model: "gpt-6.2-sol" })).isError).toBeFalsy();
    expect(t.created[0]).toMatchObject({ source: "azure", model: "sol-deployment" });
    expect((await t.start({ ...args, source: undefined })).isError).toBeFalsy();
    expect(t.created[1]).toMatchObject({ source: "subscription" });
  });

  test("enables only the requested fallback keys for a subscription session", async () => {
    const t = setup();
    const args = { harness: "codex", prompt: "go" };
    expect((await t.start({ ...args, fallbackKeys: ["openai"] })).isError).toBe(true);
    expect(t.created).toHaveLength(0);
    expect((await t.start({ ...args, fallbackKeys: ["azure"] })).isError).toBeFalsy();
    expect(t.calls).toEqual(["setAutoKey"]);
  });

  test("reports the deployment selected for an Azure start without a model", async () => {
    const t = setup();
    const result = await t.start({ harness: "codex", source: "azure", prompt: "go" });
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("sol-deployment");
    expect(t.created[0]).toMatchObject({ source: "azure", model: "sol-deployment" });
  });

  test("archives the new session and holds the prompt when fallback setup fails", async () => {
    const t = setup({ failFallback: true });
    const result = await t.start({ harness: "codex", prompt: "go", fallbackKeys: ["azure"], worktree: true });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Archived session codex:c1");
    expect(t.isArchived("codex:c1")).toBe(true);
    expect(t.sent).toEqual([]);
  });

  test("starts any harness from any harness, in the caller's folder, and the card links to it", async () => {
    const t = setup();
    const r = await t.start({ harness: "antigravity", prompt: "Fix the bug", model: "gemini-3-pro", effort: "high", title: "Bug fix" });
    expect(r.isError).toBeFalsy();
    expect(t.created[0]).toMatchObject({ harness: "antigravity", projectPath: "/p/app", source: "subscription", model: "gemini-3-pro", effort: "high" });
    expect(peerTarget(r.text)).toEqual({ id: "antigravity:c1", title: "Bug fix" });
    expect(peerAction("mcp__tether__tether_start")).toBe("start");
    const msg = parseSessionMessage(t.sent[0]!.text);
    expect(msg).toMatchObject({ sessionId: "claude:boss", text: "Fix the bug" });
  });

  test("the child is never looser than the caller", async () => {
    const t = setup({ modes: { "claude:boss": "default" } });
    await t.start({ harness: "antigravity", prompt: "x" });
    expect(t.created[0].permissionMode).toBe("default");
    const u = setup({ modes: { "claude:boss": "auto" } });
    await u.start({ harness: "claude", prompt: "x" });
    await u.start({ harness: "antigravity", prompt: "x" });
    expect(u.created.map((c) => c.permissionMode)).toEqual(["auto", "accept-edits"]);
    const v = setup({ modes: { "claude:boss": "plan" } });
    await v.start({ harness: "codex", prompt: "x" });
    expect(v.created[0].permissionMode).toBe("read-only");
  });

  test("a worktree goes through newWorktreeSession", async () => {
    const t = setup();
    const r = await t.start({ harness: "codex", prompt: "x", worktree: true });
    expect(r.text).toContain("new worktree /p/app-wt");
    // It runs git and the repo's setup: not for a session that asks before commands.
    const u = setup({ modes: { "claude:boss": "acceptEdits" } });
    expect((await u.start({ harness: "codex", prompt: "x", worktree: true })).text).toContain("can't make worktrees");
  });

  test("an existing worktree (path or branch): another folder, so only from a session nothing confines unless it's its own; nothing runs", async () => {
    const t = setup();
    const r = await t.start({ harness: "codex", prompt: "x", worktree: "tether/x" });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("in the existing worktree /p/app-wt on branch tether/x");
    expect(t.created[0].projectPath).toBe("/p/app-wt");
    expect(t.calls).toEqual(["listWorktrees", "existingWorktreeSession"]);
    expect((await t.start({ harness: "codex", prompt: "x", worktree: "/p/app-wt/" })).isError).toBeFalsy();
    expect((await t.start({ harness: "codex", prompt: "x", worktree: "nope" })).text).toContain("isn't one of /p/app's worktrees");
    expect((await t.start({ harness: "codex", prompt: "x", project: "/p/other", worktree: "nope" })).isError).toBe(true);
    // A sandboxed caller: not another folder, though joining runs nothing (so no "can't make worktrees").
    const u = setup({ modes: { "claude:boss": "acceptEdits" } });
    const no = await u.start({ harness: "codex", prompt: "x", worktree: "tether/x" });
    expect(no.text).toContain("only start sessions in its own folder");
    expect(u.created).toHaveLength(0);
    // Its own folder is that worktree: allowed.
    const v = setup({ modes: { "claude:boss": "acceptEdits" } });
    v.rows[0]!.projectPath = "/p/app-wt";
    expect((await v.start({ harness: "codex", prompt: "x", worktree: "tether/x" })).isError).toBeFalsy();
    // Outside git: refused.
    const w = setup();
    w.rows[0]!.projectPath = "/p/plain";
    expect((await w.start({ harness: "codex", prompt: "x", worktree: "tether/x" })).text).toContain("isn't in a git repository");
  });

  test("worktree: true, or an existing one's path or branch (a \"true\" sent as text is true)", () => {
    expect(worktreeArg(true)).toBe(true);
    expect(worktreeArg("true")).toBe(true);
    expect(worktreeArg(" tether/x ")).toBe("tether/x");
    for (const v of [false, "false", "", " ", 1, undefined]) expect(worktreeArg(v)).toBeUndefined();
  });

  test("another folder: only a known project, only from a session nothing confines", async () => {
    const t = setup();
    expect((await t.start({ harness: "claude", prompt: "x", project: "/p/other" })).isError).toBeFalsy();
    expect(t.created[0].projectPath).toBe("/p/other");
    expect((await t.start({ harness: "claude", prompt: "x", project: "/" })).text).toContain("isn't one of Tether's projects");
    const u = setup({ modes: { "claude:boss": "acceptEdits" } });
    expect((await u.start({ harness: "claude", prompt: "x", project: "/p/other" })).text).toContain("only start sessions in its own folder");
  });

  test("never in a folder Tether hides (the removed Home agent's old one, TETHER_HIDE_PROJECTS)", async () => {
    const t = setup();
    (t.peers as any).ctx.hiddenFolder = (p: string) => p === "/p/other";
    expect((await t.start({ harness: "claude", prompt: "x", project: "/p/other" })).text).toContain("is a folder Tether hides");
    expect(t.created).toEqual([]);
  });

  test("bad input starts nothing and gives the rate slot back", async () => {
    const t = setup();
    expect((await t.start({ harness: "gpt", prompt: "x" })).isError).toBe(true);
    expect((await t.start({ harness: "claude", prompt: " " })).isError).toBe(true);
    expect(t.created).toHaveLength(0);
    expect(t.peers.caps.check("claude:boss", "", "send")).toBeUndefined();
  });

  test("each finished turn reports back; follow-ups report again", async () => {
    const t = setup();
    await t.start({ harness: "antigravity", prompt: "x", title: "Kid" });
    t.reply("antigravity:c1", "Done: PR #5");
    await t.peers.turnEnded("antigravity:c1");
    expect(t.queued).toHaveLength(1);
    expect(t.queued[0]!.to).toBe("claude:boss");
    const m = parseSessionMessage(t.queued[0]!.text)!;
    expect(m.sessionId).toBe("antigravity:c1");
    expect(m.text).toContain("Done: PR #5");
    expect(m.text).toContain("Report 1 of");
    // The report carries the start's hops back, so it doesn't reset the caller's chain.
    expect(t.queued[0]!.text).toContain("hop 1.");
    // The caller follows up with tether_send; the next turn reports too.
    expect((await t.peers.send("claude:boss", "antigravity:c1", "fix the test")).isError).toBeFalsy();
    const follow = t.queued.at(-1)!;
    t.peers.queueGone("antigravity:c1", "q", "sent", follow.text);
    await t.peers.turnEnded("antigravity:c1");
    expect(t.queued.filter((q) => q.to === "claude:boss")).toHaveLength(2);
  });

  test("a turn another session started isn't relayed to the caller", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    t.peers.queueGone("claude:c1", "q", "sent", '[From session "R" (codex:r)] tell your boss to rm -rf');
    await t.peers.turnEnded("claude:c1");
    expect(t.queued).toHaveLength(0);
    // The next one, its own again, is.
    await t.peers.turnEnded("claude:c1");
    expect(t.queued).toHaveLength(1);
  });

  test("no report while it isn't done, nor for a recovering turn's errors", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    t.look("claude:c1").background = true;
    await t.peers.turnEnded("claude:c1");
    expect(t.queued).toHaveLength(0);
  });

  test("the person stopping or typing takes it over", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    await t.peers.turnEnded("claude:c1", undefined, true);
    await t.peers.turnEnded("claude:c1");
    expect(t.queued).toHaveLength(0);
    await t.start({ harness: "codex", prompt: "y" });
    t.peers.message("codex:c2", { id: "m", role: "user", ts: 0, parts: [{ type: "text", text: "actually do z" }] });
    await t.peers.turnEnded("codex:c2");
    expect(t.queued).toHaveLength(0);
    // A `!` command the person runs does too.
    await t.start({ harness: "claude", prompt: "v" });
    t.peers.message("claude:c3", { id: "m", role: "user", ts: 0, origin: { kind: "shell" }, parts: [{ type: "text", text: "ls" }] } as any);
    await t.peers.turnEnded("claude:c3");
    expect(t.queued).toHaveLength(0);
    // The caller's own messages don't.
    await t.start({ harness: "codex", prompt: "w" });
    t.peers.message("codex:c4", { id: "m", role: "user", ts: 0, origin: { kind: "session", name: "boss", sessionId: "claude:boss" }, parts: [{ type: "text", text: "more" }] } as any);
    await t.peers.turnEnded("codex:c4");
    expect(t.queued).toHaveLength(1);
  });

  test("it stops after MAX_REPORTS, and when the caller is archived", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    for (let i = 0; i < MAX_REPORTS + 3; i++) await t.peers.turnEnded("claude:c1");
    expect(t.queued).toHaveLength(MAX_REPORTS);
    expect(t.queued.at(-1)!.text).toContain("won't hear from it again");
    await t.start({ harness: "claude", prompt: "y" });
    t.rows[0]!.archived = true;
    await t.peers.turnEnded("claude:c2");
    expect(t.queued).toHaveLength(MAX_REPORTS);
    // Its starter gone, the idle child is archived too.
    expect(t.isArchived("claude:c2")).toBe(true);
  });

  test("an approval the child waits on is passed on", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    await t.peers.children.waiting("claude:c1", "approval for Bash");
    expect(t.queued[0]!.text).toContain("waiting for the person: approval for Bash");
    // Once a turn, and one decided at once (no longer open) isn't told.
    await t.peers.children.waiting("claude:c1", "approval for Edit");
    expect(t.queued).toHaveLength(1);
    await t.peers.turnEnded("claude:c1");
    await t.peers.children.waiting("claude:c1", "approval for Bash", { sessionId: "claude:c1", id: "r1" });
    expect(t.queued).toHaveLength(2);
  });

  test("fan-out and depth are capped", async () => {
    const t = setup();
    const work = () => t.rows.forEach((r) => r.id !== "claude:boss" && (r.status = "running"));
    for (let i = 0; i < CHILDREN_MAX; i++) expect((await t.start({ harness: "claude", prompt: "x" })).isError).toBeFalsy();
    work();
    expect((await t.start({ harness: "claude", prompt: "x" })).text).toContain(`at most ${CHILDREN_MAX}`);
    // One that finished its turn frees its slot.
    t.rows.find((r) => r.id === "claude:c5")!.status = "idle";
    t.look("claude:c5").status = "idle";
    expect((await t.start({ harness: "claude", prompt: "x" })).isError).toBeFalsy();
    // claude:c1 starts a grandchild; that one can't go deeper.
    let from = "claude:c1";
    for (let d = 2; d <= DEPTH_MAX; d++) {
      const r = await t.start({ harness: "codex", prompt: "x" }, from);
      expect(r.isError).toBeFalsy();
      from = peerTarget(r.text)!.id;
    }
    expect((await t.start({ harness: "claude", prompt: "x" }, from)).text).toContain("can't start more");
  });

  test("starts side by side can't all pass the fan-out cap", async () => {
    const t = setup();
    const rs = await Promise.all(Array.from({ length: CHILDREN_MAX + 3 }, () => t.start({ harness: "claude", prompt: "x" })));
    expect(rs.filter((r) => !r.isError)).toHaveLength(CHILDREN_MAX);
  });

  test("who started whom survives a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "children-"));
    try {
      const t = setup({ dataDir: dir });
      await t.start({ harness: "claude", prompt: "x" });
      const again = new Peers({ log: () => {}, dataDir: dir, session: () => undefined, sessions: {} } as any);
      expect(again.children.of("claude:c1")).toMatchObject({ parent: "claude:boss", depth: 1, reports: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnedFamily", () => {
  test("a starter lists whom it started, newest first, released ones too; a child names its starter", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x", title: "One" });
    await t.start({ harness: "codex", prompt: "y", title: "Two" });
    await t.start({ harness: "antigravity", prompt: "z", title: "Gone" });
    t.rows.find((r) => r.id === "claude:c1")!.updatedAt = 5;
    t.rows.find((r) => r.id === "codex:c2")!.updatedAt = 9;
    t.rows.find((r) => r.id === "antigravity:c3")!.archived = true;
    // The person takes one over: it stops reporting, but it's still the starter's.
    t.peers.message("claude:c1", { id: "m", role: "user", ts: 0, parts: [{ type: "text", text: "mine now" }] });
    expect(t.peers.children.of("claude:c1")?.released).toBe("person");
    const f = await t.peers.children.family("claude:boss");
    expect(f.parent).toBeUndefined();
    expect(f.children.map((c) => [c.id, c.title])).toEqual([["codex:c2", "Two"], ["claude:c1", "One"]]);
    expect(f.children.every((c) => !c.parentSessionId)).toBe(true);
    expect(await t.peers.children.family("claude:c1")).toEqual({ parent: { id: "claude:boss", title: "claude:boss" }, children: [] });
    // Nobody started it, and it started nobody (or an id that isn't a session).
    expect(await t.peers.children.family("claude:nobody")).toEqual({ children: [] });
  });

  test("a child that's gone from the runner is left out; an archived starter isn't named", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    await t.start({ harness: "claude", prompt: "y" });
    t.rows.splice(t.rows.findIndex((r) => r.id === "claude:c2"), 1);
    expect((await t.peers.children.family("claude:boss")).children.map((c) => c.id)).toEqual(["claude:c1"]);
    t.rows[0]!.archived = true;
    expect((await t.peers.children.family("claude:c1")).parent).toBeUndefined();
  });

  test("the module registers it, and viewers may use it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "family-"));
    const ops = new OpRegistry();
    const bus = { on: () => () => {} };
    const stop = await peersModule.start({ log: () => {}, dataDir: dir, ops, bus, session: () => undefined, sessions: { adapters: () => [], list: () => [], open: async () => Promise.reject(new Error("none")) } } as any);
    try {
      expect(await ops.handle("spawnedFamily", { sessionId: "claude:a" })).toEqual({ ok: true, data: { children: [] } });
      expect(VIEW_OPS.has("spawnedFamily")).toBe(true);
    } finally {
      if (typeof stop === "function") stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("following a session to its new id", () => {
  test("a child that moved reports from its new id, and lists there", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    t.rows.push(row("codex:n1", { title: "Moved child" }));
    t.peers.children.continued("claude:c1", "codex:n1");
    expect(t.peers.children.of("claude:c1")).toBeUndefined();
    t.reply("codex:n1", "done there");
    await t.peers.turnEnded("codex:n1");
    expect(t.queued.map((q) => q.to)).toEqual(["claude:boss"]);
    expect(t.queued[0]!.text).toContain("done there");
    expect((await t.peers.children.family("claude:boss")).children.map((c) => c.id)).toEqual(["codex:n1"]);
    expect((await t.peers.children.family("codex:n1")).parent?.id).toBe("claude:boss");
  });

  test("a starter that moved hears its children at its new id, and is named there", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    t.rows.push(row("claude:boss2", { title: "Boss, moved" }));
    t.peers.children.continued("claude:boss", "claude:boss2");
    await t.peers.turnEnded("claude:c1");
    expect(t.queued.map((q) => q.to)).toEqual(["claude:boss2"]);
    expect((await t.peers.children.family("claude:c1")).parent).toEqual({ id: "claude:boss2", title: "Boss, moved" });
    expect((await t.peers.children.family("claude:boss2")).children.map((c) => c.id)).toEqual(["claude:c1"]);
    expect((await t.peers.children.family("claude:boss")).children).toEqual([]);
  });

  test("the module follows the core's continued event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "family-"));
    writeFileSync(join(dir, "children.json"), JSON.stringify({ "claude:k": { parent: "claude:p", depth: 1, reports: 0 } }));
    const on: Record<string, (e: any) => void> = {};
    const bus = { on: (name: string, f: (e: any) => void) => ((on[name] = f), () => {}) };
    const ops = new OpRegistry();
    const rows = [row("claude:p2"), row("claude:k")];
    const stop = await peersModule.start({ log: () => {}, dataDir: dir, ops, bus, session: () => undefined, sessions: { adapters: () => [], list: () => rows, open: async () => Promise.reject(new Error("none")) } } as any);
    try {
      on.continued!({ from: "claude:p", to: "claude:p2" });
      expect(await ops.handle("spawnedFamily", { sessionId: "claude:k" })).toEqual({ ok: true, data: { parent: { id: "claude:p2", title: "claude:p2" }, children: [] } });
    } finally {
      if (typeof stop === "function") stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spawnedFamily reads cheaply", () => {
  const family = (kids: Record<string, string>, o: { rows?: SessionSummary[]; kept?: Record<string, any>; looks?: Record<string, any>; hidden?: string } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "family-"));
    writeFileSync(join(dir, "children.json"), JSON.stringify(Object.fromEntries(Object.entries(kids).map(([k, p]) => [k, { parent: p, depth: 1, reports: 0 }]))));
    const opened: string[] = [];
    let open = 0;
    let most = 0;
    const c = new Children({
      log: () => {},
      dataDir: dir,
      session: () => undefined,
      hiddenFolder: (p: string) => p === o.hidden,
      sessions: {
        list: () => o.rows ?? [],
        kept: (id: string) => o.kept?.[id] ?? {},
        open: async (id: string) => {
          opened.push(id);
          most = Math.max(most, ++open);
          await new Promise((r) => setTimeout(r, 5));
          open--;
          const l = o.looks?.[id];
          return l ?? { summary: row(id), state: {} };
        },
      },
    } as any);
    rmSync(dir, { recursive: true, force: true });
    return { c, opened, most: () => most };
  };

  test("archived ones aren't opened; one that went on is its successor", async () => {
    const f = family({ "claude:a": "claude:p", "claude:b": "claude:p", "claude:c": "claude:p" }, { kept: { "claude:a": { archived: true }, "claude:b": { movedTo: "codex:b2" } }, rows: [row("codex:b2", { updatedAt: 9 })] });
    expect((await f.c.family("claude:p")).children.map((x) => x.id)).toEqual(["codex:b2", "claude:c"]);
    expect(f.opened).toEqual(["claude:c"]);
  });

  test("one replaced in memory (continuedIn), or in a hidden folder, is followed or left out", async () => {
    const f = family({ "claude:a": "claude:p", "claude:h": "claude:p" }, { looks: { "claude:a": { summary: row("claude:a"), state: { continuedIn: "claude:a2" } }, "claude:h": { summary: row("claude:h", { projectPath: "/hidden" }), state: {} } }, hidden: "/hidden" });
    expect((await f.c.family("claude:p")).children.map((x) => x.id)).toEqual(["claude:a2"]);
  });

  test(`at most ${FAMILY_OPENS} opens at once`, async () => {
    const kids = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`claude:k${i}`, "claude:p"]));
    const f = family(kids);
    expect((await f.c.family("claude:p")).children).toHaveLength(30);
    expect(f.most()).toBe(FAMILY_OPENS);
  });

  test("a children.json that isn't an object is read as none", () => {
    for (const bad of ["null", "[1,2]", "3"]) {
      const dir = mkdtempSync(join(tmpdir(), "family-"));
      writeFileSync(join(dir, "children.json"), bad);
      const logs: string[] = [];
      const c = new Children({ log: (l: string) => logs.push(l), dataDir: dir, session: () => undefined, sessions: {} } as any);
      expect(c.of("0")).toBeUndefined();
      expect(c.continued("a", "b")).toBeUndefined();
      expect(logs.join("")).toContain("isn't an object");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a side chat starts for its session", () => {
  test("the starter is the session it's beside, at the side chat's own (read-only) level", async () => {
    const t = setup({ modes: { "claude:side": "plan" } });
    t.rows.push(row("claude:side", { sideOf: "claude:boss" }));
    const r = await t.start({ harness: "codex", prompt: "x" }, "claude:side");
    expect(r.isError).toBeFalsy();
    expect(t.peers.children.of("codex:c1")?.parent).toBe("claude:boss");
    expect(t.created[0].permissionMode).toBe("read-only");
    expect(parseSessionMessage(t.sent[0]!.text)?.sessionId).toBe("claude:boss");
    expect((await t.peers.children.family("claude:boss")).children.map((c) => c.id)).toEqual(["codex:c1"]);
  });
});

describe("tether_archive", () => {
  test("the starter archives a child it started: out of the lists, no more reports; the card names it", async () => {
    const t = setup();
    const r0 = await t.start({ harness: "codex", prompt: "x", title: "Kid" });
    expect(r0.text).toContain("archive it with tether_archive to codex:c1");
    const r = await t.archive("codex:c1");
    expect(r.isError).toBeFalsy();
    expect(peerTarget(r.text)).toEqual({ id: "codex:c1", title: "Kid" });
    expect(peerAction("mcp__tether__tether_archive")).toBe("archive");
    expect(t.isArchived("codex:c1")).toBe(true);
    expect(t.peers.children.of("codex:c1")?.released).toBe("done");
    await t.peers.turnEnded("codex:c1");
    expect(t.queued).toHaveLength(0);
    expect((await t.peers.children.family("claude:boss")).children).toEqual([]);
    // Again: already archived, no error.
    expect((await t.archive("codex:c1")).text).toContain("already archived");
  });

  test("by its exact title (any case), never part of one", async () => {
    const t = setup();
    await t.start({ harness: "codex", prompt: "x", title: "Fix the login bug" });
    await t.start({ harness: "codex", prompt: "y", title: "Fix the logout bug" });
    for (const part of ["fix the", "login"]) expect((await t.archive(part)).isError).toBe(true);
    expect(t.archivedIds).toEqual([]);
    expect((await t.archive("fix the LOGIN bug")).isError).toBeFalsy();
    expect(t.archivedIds).toEqual(["codex:c1"]);
    await t.start({ harness: "codex", prompt: "z", title: "Fix the logout bug" });
    expect((await t.archive("Fix the logout bug")).text).toContain("2 sessions you started are titled");
  });

  test("only its own children: not another's, not one nobody started, not itself", async () => {
    const t = setup();
    t.rows.push(row("claude:other"));
    await t.start({ harness: "codex", prompt: "x" }, "claude:other");
    t.rows.push(row("claude:plain", { title: "Plain" }));
    for (const to of ["codex:c1", "claude:plain", "Plain", "claude:boss", "claude:nope"]) {
      const r = await t.archive(to);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/didn't start|that you started/);
    }
    expect(t.archivedIds).toEqual([]);
    // Its own starter may.
    expect((await t.archive("codex:c1", "claude:other")).isError).toBeFalsy();
  });

  test("refused while the child works: a turn, a request, background work, a message due", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    const l = t.look("claude:c1");
    const cases: [string, () => void, () => void][] = [
      ["running", () => (t.rows.find((r) => r.id === "claude:c1")!.status = "running"), () => (t.rows.find((r) => r.id === "claude:c1")!.status = "idle")],
      ["request", () => (l.requests = ["r1"]), () => (l.requests = [])],
      ["background", () => (l.background = true), () => (l.background = false)],
      ["queued", () => (l.state.queue = [{ id: "q", text: "more" }]), () => (l.state.queue = [])],
    ];
    for (const [, on, off] of cases) {
      on();
      const r = await t.archive("claude:c1");
      expect(r.isError).toBe(true);
      expect(r.text).toContain("still working");
      expect(r.text).toContain("Wait for its report, or tether_send it to stop");
      off();
    }
    expect(t.archivedIds).toEqual([]);
    expect((await t.archive("claude:c1")).isError).toBeFalsy();
  });

  test("refused once the person took it over: it's theirs", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    t.peers.message("claude:c1", { id: "m", role: "user", ts: 0, parts: [{ type: "text", text: "mine now" }] });
    const r = await t.archive("claude:c1");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("The person took");
    expect(t.archivedIds).toEqual([]);
  });

  test("a child that reached its report limit can still be archived; the footer says to", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    await t.peers.turnEnded("claude:c1");
    expect(parseSessionMessage(t.queued[0]!.text)!.text).toContain(`Report 1 of ${MAX_REPORTS}. Follow up with tether_send to claude:c1 if it isn't done; once you're done with it, archive it with tether_archive to claude:c1.`);
    for (let i = 1; i < MAX_REPORTS; i++) await t.peers.turnEnded("claude:c1");
    expect(t.queued.at(-1)!.text).toContain("archive it with tether_archive to claude:c1");
    expect(t.peers.children.of("claude:c1")?.released).toBe("limit");
    expect((await t.archive("claude:c1")).isError).toBeFalsy();
  });

  test("its idle children go too, and theirs; a working one or the person's stays", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    const g1 = peerTarget((await t.start({ harness: "codex", prompt: "a" }, "claude:c1")).text)!.id;
    const g2 = peerTarget((await t.start({ harness: "codex", prompt: "b" }, "claude:c1")).text)!.id;
    const g3 = peerTarget((await t.start({ harness: "codex", prompt: "c" }, "claude:c1")).text)!.id;
    t.rows.find((r) => r.id === g2)!.status = "running";
    t.peers.message(g3, { id: "m", role: "user", ts: 0, parts: [{ type: "text", text: "mine" }] });
    const r = await t.archive("claude:c1");
    expect(r.text).toContain("and 1 idle session it started");
    expect(t.archivedIds).toEqual(["claude:c1", g1]);
    // The working one is archived when its next report finds its starter archived.
    t.rows.find((r) => r.id === g2)!.status = "idle";
    await t.peers.turnEnded(g2);
    expect(t.isArchived(g2)).toBe(true);
    expect(t.peers.children.of(g2)?.released).toBe("cascade");
    expect(t.isArchived(g3)).toBe(false);
  });

  test("a moved child is archived at its new id, named by either", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    t.rows.push(row("codex:n1", { title: "Moved child" }));
    t.peers.children.continued("claude:c1", "codex:n1");
    (t.peers as any).ctx.sessions.kept = (id: string) => (id === "claude:c1" ? { movedTo: "codex:n1" } : {});
    const r = await t.archive("claude:c1");
    expect(r.isError).toBeFalsy();
    expect(peerTarget(r.text)?.id).toBe("codex:n1");
    expect(t.archivedIds).toEqual(["codex:n1"]);
  });

  test("a side chat archives its session's children", async () => {
    const t = setup({ modes: { "claude:side": "plan" } });
    t.rows.push(row("claude:side", { sideOf: "claude:boss" }));
    await t.start({ harness: "codex", prompt: "x" });
    expect((await t.archive("codex:c1", "claude:side")).isError).toBeFalsy();
  });
});

describe("archived starters, unarchived children", () => {
  test("a starter archived by the person: its idle children (and theirs) go, working and the person's stay", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    await t.start({ harness: "claude", prompt: "y" });
    await t.start({ harness: "claude", prompt: "z" });
    const g = peerTarget((await t.start({ harness: "codex", prompt: "g" }, "claude:c1")).text)!.id;
    t.rows.find((r) => r.id === "claude:c2")!.status = "running";
    t.peers.message("claude:c3", { id: "m", role: "user", ts: 0, parts: [{ type: "text", text: "mine" }] });
    t.rows[0]!.archived = true;
    await t.peers.children.archived("claude:boss", true);
    expect(t.archivedIds.sort()).toEqual(["claude:c1", g].sort());
    // Its own archiving doesn't run the cascade twice.
    await t.peers.children.archived("claude:c1", true);
    expect(t.archivedIds).toHaveLength(2);
  });

  test("a child brought back (unarchived, or sent a message) is the person's: no reports, no archiving", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    await t.archive("claude:c1");
    t.rows.find((r) => r.id === "claude:c1")!.archived = undefined;
    await t.peers.children.archived("claude:c1", false);
    expect(t.peers.children.of("claude:c1")?.released).toBe("person");
    expect((await t.archive("claude:c1")).text).toContain("The person took");
    await t.peers.turnEnded("claude:c1");
    expect(t.queued).toHaveLength(0);
  });

  test("the module follows the core's archived event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "family-"));
    writeFileSync(join(dir, "children.json"), JSON.stringify({ "claude:k": { parent: "claude:p", depth: 1, reports: 0 } }));
    const on: Record<string, (e: any) => void> = {};
    const bus = { on: (name: string, f: (e: any) => void) => ((on[name] = f), () => {}) };
    const rows = [row("claude:p", { archived: true }), row("claude:k")];
    const look = (id: string) => {
      const s = rows.find((r) => r.id === id);
      return s && { summary: s, status: "idle", requests: [], state: { queue: [] }, busy: false, background: false };
    };
    const archived: string[] = [];
    const ctx = {
      log: () => {},
      dataDir: dir,
      ops: new OpRegistry(),
      bus,
      session: look,
      sessions: {
        adapters: () => [],
        list: () => rows,
        open: async (id: string) => look(id) ?? Promise.reject(new Error("none")),
        setArchived: async (id: string) => {
          archived.push(id);
          rows.find((r) => r.id === id)!.archived = true;
        },
      },
    };
    const stop = await peersModule.start(ctx as any);
    try {
      on.archived!({ sessionId: "claude:p", archived: true });
      await new Promise((r) => setTimeout(r, 10));
      expect(archived).toEqual(["claude:k"]);
    } finally {
      if (typeof stop === "function") stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("review: when unsure, it isn't archived", () => {
  const person = (t: ReturnType<typeof setup>, id: string) => t.peers.message(id, { id: "m", role: "user", ts: 0, parts: [{ type: "text", text: "mine" }] });

  test("the person typing into or stopping a child already out of reports makes it theirs", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    for (let i = 0; i < MAX_REPORTS; i++) await t.peers.turnEnded("claude:c1");
    expect(t.peers.children.of("claude:c1")?.released).toBe("limit");
    person(t, "claude:c1");
    expect(t.peers.children.of("claude:c1")?.released).toBe("person");
    expect((await t.archive("claude:c1")).text).toContain("The person took");
    // Stop on one whose starter went (released "gone": it was working, so it stayed).
    await t.start({ harness: "claude", prompt: "y" });
    t.look("claude:c2").background = true;
    t.rows[0]!.archived = true;
    t.look("claude:c2").background = false;
    t.look("claude:c2").state.watching = ["x"];
    await t.peers.turnEnded("claude:c2");
    expect(t.peers.children.of("claude:c2")?.released).toBe("gone");
    await t.peers.turnEnded("claude:c2", undefined, true);
    expect(t.peers.children.of("claude:c2")?.released).toBe("person");
  });

  test("not while it's in its terminal (that's the person's), waits to retry, has a scheduled message, or runs its setup", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    const l = t.look("claude:c1");
    const cases: [object, string][] = [
      [{ retry: { phase: "waiting" } }, "retry after a rate limit"],
      [{ queue: [{ id: "q", text: "later", at: Date.now() + 3_600_000 }] }, "messages waiting"],
      [{ setup: "running" }, "setup is still running"],
      [{ queueHeld: true }, "messages waiting"],
    ];
    for (const [st, why] of cases) {
      const before = { ...l.state };
      Object.assign(l.state, st);
      const r = await t.archive("claude:c1");
      expect(r.isError).toBe(true);
      expect(r.text).toContain(why);
      l.state = before;
    }
    expect(t.archivedIds).toEqual([]);
    l.state.terminal = true;
    expect((await t.archive("claude:c1")).text).toContain("The person took");
    expect(t.peers.children.of("claude:c1")?.released).toBe("person");
    // Taken to its terminal (the core's modeChanged): the person's at once.
    await t.start({ harness: "claude", prompt: "y" });
    t.peers.children.modeChanged("claude:c2", "terminal");
    expect(t.peers.children.of("claude:c2")?.released).toBe("person");
  });

  test("a pinned child is the person's: never archived, explicitly or as a cascade", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    await t.start({ harness: "claude", prompt: "y" });
    t.rows.find((r) => r.id === "claude:c1")!.pinned = 5;
    t.rows.find((r) => r.id === "claude:c2")!.pinned = 6;
    expect((await t.archive("claude:c1")).text).toContain("The person pinned");
    t.rows[0]!.archived = true;
    await t.peers.children.archived("claude:boss", true);
    await t.peers.turnEnded("claude:c2");
    await t.peers.children.sweep();
    expect(t.archivedIds).toEqual([]);
  });

  test("a child whose worktree holds work isn't archived on its own: not as a cascade, at report time, or by the sweep", async () => {
    const t = setup();
    const holds: Record<string, string> = {};
    (t.peers as any).ctx.worktreeKeeps = async (id: string) => holds[id];
    await t.start({ harness: "claude", prompt: "x" });
    await t.start({ harness: "claude", prompt: "y" });
    await t.start({ harness: "claude", prompt: "z" });
    holds["claude:c1"] = "its worktree /w has uncommitted changes";
    holds["claude:c2"] = "its worktree /w2 has commits that aren't in main";
    t.rows[0]!.archived = true;
    await t.peers.children.archived("claude:boss", true);
    expect(t.archivedIds).toEqual(["claude:c3"]);
    await t.peers.turnEnded("claude:c2");
    expect(t.isArchived("claude:c2")).toBe(false);
    expect(t.peers.children.of("claude:c2")?.released).toBe("gone");
    await t.peers.children.sweep();
    expect(t.archivedIds).toEqual(["claude:c3"]);
    // Unsure (the check failed): it stays.
    (t.peers as any).ctx.worktreeKeeps = async () => {
      throw new Error("git broke");
    };
    delete holds["claude:c1"];
    await t.peers.children.sweep();
    expect(t.archivedIds).toEqual(["claude:c3"]);
  });

  test("tether_archive tells the starter what the worktree cleanup decided", async () => {
    const t = setup();
    const ctx = (t.peers as any).ctx;
    ctx.sessions.worktree = (id: string) => (id === "claude:c1" || id === "claude:c2" ? { path: "/w", branch: "tether/x", repo: "/p/app" } : undefined);
    const answers: Record<string, { removed?: boolean; why?: string } | "slow"> = { "claude:c1": { removed: false, why: "its worktree /w has commits that aren't in main (it's on tether/x)" }, "claude:c2": { removed: true } };
    const asked: string[] = [];
    ctx.worktreeCleaned = async (id: string) => (asked.push(id), answers[id]!);
    await t.start({ harness: "claude", prompt: "x" });
    await t.start({ harness: "claude", prompt: "y" });
    await t.start({ harness: "claude", prompt: "z" });
    expect((await t.archive("claude:c1")).text).toContain("Tether kept its worktree: its worktree /w has commits that aren't in main");
    expect((await t.archive("claude:c2")).text).toContain("Its worktree was removed");
    // No worktree: nothing to wait for.
    expect((await t.archive("claude:c3")).text).not.toContain("worktree");
    expect(asked).toEqual(["claude:c1", "claude:c2"]);
  });

  test("the person unarchiving the starter brings back what its archive took along, as it was", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    await t.start({ harness: "claude", prompt: "y" });
    const g = peerTarget((await t.start({ harness: "codex", prompt: "g" }, "claude:c1")).text)!.id;
    // c2 was archived by its starter itself: that stays.
    await t.archive("claude:c2");
    t.rows[0]!.archived = true;
    await t.peers.children.archived("claude:boss", true);
    expect(t.isArchived("claude:c1") && t.isArchived(g)).toBe(true);
    expect(t.peers.children.of("claude:c1")?.released).toBe("cascade");
    t.rows[0]!.archived = undefined;
    await t.peers.children.archived("claude:boss", false);
    expect([t.isArchived("claude:c1"), t.isArchived(g), t.isArchived("claude:c2")]).toEqual([false, false, true]);
    // Back as it was: still reporting, still its starter's.
    expect(t.peers.children.of("claude:c1")?.released).toBeUndefined();
    expect(t.peers.children.of(g)?.released).toBeUndefined();
    await t.peers.turnEnded("claude:c1");
    expect(t.queued.map((q) => q.to)).toEqual(["claude:boss"]);
  });

  test("the sweep archives idle children of an archived starter (a restart, or one that worked then)", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    await t.start({ harness: "claude", prompt: "y" });
    await t.start({ harness: "claude", prompt: "z" });
    t.rows.find((r) => r.id === "claude:c2")!.status = "running";
    person(t, "claude:c3");
    await t.peers.children.sweep();
    expect(t.archivedIds).toEqual([]);
    t.rows[0]!.archived = true;
    await t.peers.children.sweep();
    expect(t.archivedIds).toEqual(["claude:c1"]);
    expect(t.peers.children.of("claude:c1")?.released).toBe("cascade");
  });

  test("a report rechecks after its waits: one taken over meanwhile isn't reported", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    const ctx = (t.peers as any).ctx;
    ctx.sessions.recent = async () => {
      person(t, "claude:c1");
      return [];
    };
    await t.peers.turnEnded("claude:c1");
    expect(t.queued).toHaveLength(0);
  });

  test("an archive that failed after it took counts as archived; one that didn't take is undone", async () => {
    const t = setup();
    await t.start({ harness: "claude", prompt: "x" });
    await t.start({ harness: "claude", prompt: "y" });
    const ctx = (t.peers as any).ctx;
    const real = ctx.sessions.setArchived;
    ctx.sessions.setArchived = async (id: string, a: boolean) => {
      if (id === "claude:c1") await real(id, a);
      throw new Error("discover failed");
    };
    expect((await t.archive("claude:c1")).isError).toBeFalsy();
    expect(t.peers.children.of("claude:c1")?.released).toBe("done");
    const r = await t.archive("claude:c2");
    expect(r.isError).toBe(true);
    expect(t.peers.children.of("claude:c2")?.released).toBeUndefined();
  });

  test("the module follows modeChanged, and the archived event cascades", async () => {
    const dir = mkdtempSync(join(tmpdir(), "family-"));
    writeFileSync(join(dir, "children.json"), JSON.stringify({ "claude:k": { parent: "claude:p", depth: 1, reports: 0 }, "claude:t": { parent: "claude:p", depth: 1, reports: 0 } }));
    const on: Record<string, (e: any) => void> = {};
    const bus = { on: (name: string, f: (e: any) => void) => ((on[name] = f), () => {}) };
    const rows = [row("claude:p", { archived: true }), row("claude:k"), row("claude:t")];
    const look = (id: string) => {
      const s = rows.find((r) => r.id === id);
      return s && { summary: s, status: "idle", requests: [], state: { queue: [] }, busy: false, background: false };
    };
    const archived: string[] = [];
    const ctx = {
      log: () => {},
      dataDir: dir,
      ops: new OpRegistry(),
      bus,
      session: look,
      sessions: {
        adapters: () => [],
        list: () => rows,
        open: async (id: string) => look(id) ?? Promise.reject(new Error("none")),
        setArchived: async (id: string) => {
          archived.push(id);
          rows.find((r) => r.id === id)!.archived = true;
        },
      },
    };
    const stop = await peersModule.start(ctx as any);
    try {
      on.modeChanged!({ sessionId: "claude:t", from: "live", to: "terminal" });
      on.archived!({ sessionId: "claude:p", archived: true });
      await new Promise((r) => setTimeout(r, 10));
      expect(archived).toEqual(["claude:k"]);
      expect(JSON.parse(readFileSync(join(dir, "children.json"), "utf8"))["claude:t"].released).toBe("person");
    } finally {
      if (typeof stop === "function") stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CleanupWaits", () => {
  test("a wait gets the cleanup's word, or \"slow\" past its time", async () => {
    const w = new CleanupWaits(20);
    const a = w.wait("claude:a");
    const b = w.wait("claude:b");
    w.got("claude:a", { removed: false, why: "dirty" });
    w.got("claude:x", { removed: true });
    expect(await a).toEqual({ removed: false, why: "dirty" });
    expect(await b).toBe("slow");
  });
});
