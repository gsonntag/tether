import { expect, test } from "bun:test";
import { join } from "node:path";
import { readBuildInfo, type GitRunner } from "./build";

test("parses git log, branch, and clean status into server build stamp", async () => {
  const git: GitRunner = async (argv) => {
    if (argv[0] === "log") return { code: 0, stdout: "1a2b3c4\x002026-11-21\n" };
    if (argv[0] === "branch") return { code: 0, stdout: "main\n" };
    if (argv[0] === "status") return { code: 0, stdout: "" };
    return { code: 1, stdout: "" };
  };
  const b = await readBuildInfo("/any/path", git);
  expect(b).toEqual({ commit: "1a2b3c4", date: "2026-11-21", branch: "main", dirty: false });
});

test("marks detached HEAD when branch is empty or fails", async () => {
  const git: GitRunner = async (argv) => {
    if (argv[0] === "log") return { code: 0, stdout: "1a2b3c4\x002026-11-21\n" };
    if (argv[0] === "branch") return { code: 0, stdout: "\n" };
    if (argv[0] === "status") return { code: 0, stdout: "" };
    return { code: 1, stdout: "" };
  };
  const b = await readBuildInfo("/any/path", git);
  expect(b?.branch).toBe("detached");
});

test("marks dirty when status outputs uncommitted changes", async () => {
  const git: GitRunner = async (argv) => {
    if (argv[0] === "log") return { code: 0, stdout: "1a2b3c4\x002026-11-21\n" };
    if (argv[0] === "branch") return { code: 0, stdout: "main\n" };
    if (argv[0] === "status") return { code: 0, stdout: " M package.json\n" };
    return { code: 1, stdout: "" };
  };
  const b = await readBuildInfo("/any/path", git);
  expect(b?.dirty).toBe(true);
});

test("falls back to undefined if git log fails or folder has no .git", async () => {
  const failingGit: GitRunner = async () => ({ code: 128, stdout: "fatal: not a git repository\n" });
  expect(await readBuildInfo("/nonexistent", failingGit)).toBeUndefined();
});

test("reads build info from the actual server checkout", async () => {
  const b = await readBuildInfo(join(import.meta.dir, ".."));
  expect(b).toBeDefined();
  expect(typeof b?.commit).toBe("string");
  expect(b?.commit.length).toBeGreaterThan(0);
  expect(b?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});
