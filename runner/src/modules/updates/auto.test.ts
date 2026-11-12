import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessReport, HarnessVersion, UpdateRun } from "../../../../shared/harnessUpdates";
import type { SessionLook } from "..";
import { AutoUpdater, busyReason, CHECK_EVERY_MS, FAILED_BACKOFF_MS, reportLine } from "./auto";

const idle = (o: Partial<Omit<SessionLook, "state">> & { state?: Partial<SessionLook["state"]> } = {}): SessionLook =>
  ({ summary: { title: "Fix bug" }, status: "idle", requests: [], busy: false, background: false, ...o, state: { requests: [], queue: [], ...o.state } }) as unknown as SessionLook;

const row = (o: Partial<HarnessVersion>): HarnessVersion => ({ id: "codex", name: "Codex", pkg: "@openai/codex", installed: "0.164.0", latest: "0.167.1", status: "available", method: "npm", updatable: true, command: "npm i -g", ...o });

function setup(o: { rows?: HarnessVersion[]; looks?: () => SessionLook[]; fail?: string[]; during?: () => void; file?: string } = {}) {
  let now = 1_000_000;
  const rows = o.rows ?? [row({}), row({ id: "claude", name: "Claude Code", installed: "2.1.300", latest: "2.1.322", method: "native" }), row({ id: "claude-agent-sdk", name: "Claude Agent SDK", method: "bundled", updatable: false })];
  const updated: string[] = [];
  const told: string[] = [];
  let reports = 0;
  const checker = {
    report: async (): Promise<HarnessReport> => (reports++, { checkedAt: now, harnesses: rows }),
    updateAndWait: async (id: string): Promise<UpdateRun> => {
      updated.push(id);
      o.during?.();
      const r = rows.find((h) => h.id === id)!;
      if (o.fail?.includes(id)) return { state: "failed", startedAt: now, output: "npm ERR! EACCES", command: "x", from: r.installed, to: r.installed, error: "It exited with code 1." };
      return { state: "done", startedAt: now, output: "ok", command: "x", from: r.installed, to: r.latest };
    },
  };
  const a = new AutoUpdater({ checker, looks: o.looks ?? (() => [idle()]), file: o.file, now: () => now, notify: (t) => void told.push(t) });
  return { a, updated, told, tick: (ms: number) => (now += ms), reports: () => reports };
}

test("off by default: nothing is checked or updated", async () => {
  const s = setup();
  expect(s.a.status()).toEqual({ enabled: false });
  await s.a.tick();
  expect(s.reports()).toBe(0);
  expect(s.updated).toEqual([]);
});

test("the setting and the last result are kept on the runner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tether-auto-"));
  const file = join(dir, "auto.json");
  const s = setup({ file });
  s.a.set(true);
  await s.a.tick();
  const again = setup({ file });
  expect(again.a.status()).toMatchObject({ enabled: true, last: { results: [{ id: "codex", ok: true }, { id: "claude", ok: true }] } });
  rmSync(dir, { recursive: true });
});

test("waits while any session is busy, then updates every live-updatable harness when all are idle", async () => {
  let looks: SessionLook[] = [idle(), idle({ status: "running" })];
  const s = setup({ looks: () => looks });
  s.a.set(true);
  await s.a.tick();
  expect(s.updated).toEqual([]);
  expect(s.a.status().waiting).toMatchObject({ harnesses: ["Codex", "Claude Code"], why: '"Fix bug" is running a turn' });
  for (const busy of [idle({ requests: ["r"] }), idle({ state: { queue: [{} as never] } }), idle({ state: { retry: { attempt: 1, maxAttempts: 3, nextAt: 0, deadline: 0, error: "429" } } }), idle({ background: true }), idle({ busy: true }), idle({ state: { terminal: {} as never } })]) {
    looks = [busy];
    await s.a.tick();
    expect(s.updated).toEqual([]);
  }
  looks = [idle(), idle()];
  await s.a.tick();
  expect(s.updated).toEqual(["codex", "claude"]); // never the bundled SDK
  expect(s.a.status().waiting).toBeUndefined();
  expect(s.a.status().last).toMatchObject({ results: [{ id: "codex", from: "0.164.0", to: "0.167.1", ok: true }, { id: "claude", from: "2.1.300", to: "2.1.322", ok: true }] });
  expect(s.told).toEqual(["Auto-updated Codex 0.164.0 → 0.167.1. Auto-updated Claude Code 2.1.300 → 2.1.322."]);
});

test("stops before the next update when a session starts mid-update", async () => {
  let looks = [idle()];
  let started = false;
  const s = setup({ looks: () => looks, during: () => void (!started && ((started = true), (looks = [idle({ status: "running" })]))) });
  s.a.set(true);
  await s.a.tick();
  expect(s.updated).toEqual(["codex"]);
  const last = s.a.status().last!;
  expect(last.results.map((r) => r.id)).toEqual(["codex"]);
  expect(last.aborted).toBe('Stopped before updating Claude Code: "Fix bug" is running a turn.');
  expect(s.a.status().waiting?.harnesses).toEqual(["Claude Code"]);
  // once idle again, the rest goes
  looks = [idle()];
  s.updated.length = 0;
  await s.a.tick();
  expect(s.updated).toEqual(["codex", "claude"]); // the fake's rows still say codex is behind
});

test("a failure is recorded, the old version stays, and that version isn't retried for a day", async () => {
  const s = setup({ rows: [row({})], fail: ["codex"] });
  s.a.set(true);
  await s.a.tick();
  expect(s.a.status().last!.results[0]).toMatchObject({ id: "codex", ok: false, error: "It exited with code 1.", output: "npm ERR! EACCES", from: "0.164.0" });
  expect(s.told[0]).toBe("Auto-update of Codex failed (It exited with code 1.); it stays on 0.164.0.");
  s.tick(CHECK_EVERY_MS);
  await s.a.tick();
  expect(s.updated).toEqual(["codex"]); // not again
  s.tick(FAILED_BACKOFF_MS);
  await s.a.tick();
  expect(s.updated).toEqual(["codex", "codex"]);
});

test("checks only every few hours unless updates are waiting", async () => {
  const s = setup({ rows: [row({ status: "current" })] });
  s.a.set(true);
  await s.a.tick();
  await s.a.tick();
  expect(s.reports()).toBe(1);
  s.tick(CHECK_EVERY_MS);
  await s.a.tick();
  expect(s.reports()).toBe(2);
});

test("turning it off stops waiting updates", async () => {
  const s = setup({ looks: () => [idle({ status: "running" })] });
  s.a.set(true);
  await s.a.tick();
  expect(s.a.status().waiting).toBeDefined();
  expect(s.a.set(false)).toMatchObject({ enabled: false });
  expect(s.a.status().waiting).toBeUndefined();
});

test("busy reasons and report lines", () => {
  expect(busyReason([idle(), idle()])).toBeUndefined();
  expect(busyReason([idle({ status: "running" }), idle({ status: "waiting" })])).toBe("2 sessions are busy");
  expect(reportLine({ at: 0, results: [], aborted: "Stopped." })).toBe("Stopped.");
});
