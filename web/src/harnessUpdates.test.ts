import { expect, test } from "bun:test";
import type { HarnessReport, HarnessVersion } from "../../shared/harnessUpdates";
import { canUpdate, checkedAgo, runLine, updateAllTargets } from "./harnessUpdates";

const row = (o: Partial<HarnessVersion>): HarnessVersion => ({ id: "codex", name: "Codex", pkg: "@openai/codex", status: "available", method: "npm", updatable: true, installed: "1.0.0", latest: "1.1.0", ...o });

test("Update all takes every updatable row on online runners, never bundled or busy ones", () => {
  const a: HarnessReport = { checkedAt: 0, harnesses: [row({}), row({ id: "claude", status: "current" }), row({ id: "sdk", method: "bundled", updatable: false })] };
  const b: HarnessReport = { checkedAt: 0, harnesses: [row({ update: { state: "running", startedAt: 0, output: "", command: "x" } }), row({ id: "claude" })] };
  const c: HarnessReport = { checkedAt: 0, harnesses: [row({})] };
  expect(updateAllTargets({ a, b, c, d: undefined }, (id) => id !== "c")).toEqual([{ runnerId: "a", id: "codex" }, { runnerId: "b", id: "claude" }]);
  expect(canUpdate(row({ status: "unknown" }))).toBe(false);
});

test("the run's line", () => {
  const u = (o: object) => row({ update: { state: "done", startedAt: 0, output: "", command: "x", ...o } as HarnessVersion["update"] });
  expect(runLine(row({}))).toBeUndefined();
  expect(runLine(u({ state: "queued" }))).toContain("Waiting");
  expect(runLine(u({ from: "1.0.0", to: "1.1.0" }))).toBe("Updated 1.0.0 → 1.1.0");
  expect(runLine(u({ from: "1.0.0", to: "1.0.0" }))).toBe("Update finished (1.0.0)");
  expect(runLine(u({ state: "failed", error: "It exited with code 1." }))).toBe("Update failed: It exited with code 1.");
  expect(checkedAgo(0, 30_000)).toBe("Checked just now");
  expect(checkedAgo(0, 4 * 60_000)).toBe("Checked 4 min ago");
});

test("the auto-update's lines", async () => {
  const { autoLines } = await import("./harnessUpdates");
  expect(autoLines({ enabled: false }, 0)).toEqual({});
  expect(autoLines({ enabled: true, waiting: { since: 0, harnesses: ["Codex"], why: "2 sessions are busy" } }, 0).waiting).toBe("Waiting for all agents to be idle to update Codex (2 sessions are busy).");
  const last = { at: 0, results: [{ id: "codex", name: "Codex", from: "0.164.0", to: "0.167.1", ok: true }, { id: "claude", name: "Claude Code", from: "2.1.300", ok: false, error: "It exited with code 1." }] };
  expect(autoLines({ enabled: true, last }, 2 * 60 * 60_000).last).toBe("Last auto-update 2 h ago: Codex 0.164.0 → 0.167.1; Claude Code failed: It exited with code 1. (still 2.1.300)");
});
