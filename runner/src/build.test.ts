import { expect, test } from "bun:test";
import { join } from "node:path";
import { readBuildInfo, type GitRunner } from "./build";

test("parses git log, branch, and clean status into build stamp", async () => {
  const git: GitRunner = async (argv) => {
    if (argv[0] === "log") return { code: 0, stdout: "1a2b3c4\x002026-11-21\n" };
    if (argv[0] === "branch") return { code: 0, stdout: "feature/test\n" };
    if (argv[0] === "status") return { code: 0, stdout: "" };
    if (argv[0] === "rev-parse" && argv[3] === "@{upstream}") return { code: 0, stdout: "origin/feature/test\n" };
    if (argv[0] === "fetch") return { code: 0, stdout: "" };
    if (argv[0] === "rev-list") return { code: 0, stdout: "3\n" };
    return { code: 1, stdout: "" };
  };
  const b = await readBuildInfo("/any/path", git);
  expect(b).toEqual({ commit: "1a2b3c4", date: "2026-11-21", branch: "feature/test", dirty: false, behind: 3 });
});

test("leaves behind undefined when no upstream branch is configured", async () => {
  const git: GitRunner = async (argv) => {
    if (argv[0] === "log") return { code: 0, stdout: "1a2b3c4\x002026-11-21\n" };
    if (argv[0] === "branch") return { code: 0, stdout: "local-only\n" };
    if (argv[0] === "status") return { code: 0, stdout: "" };
    if (argv[0] === "rev-parse" && argv[3] === "@{upstream}") return { code: 1, stdout: "" };
    return { code: 1, stdout: "" };
  };
  const b = await readBuildInfo("/any/path", git);
  expect(b?.behind).toBeUndefined();
});

test("leaves behind undefined when git fetch fails", async () => {
  const git: GitRunner = async (argv) => {
    if (argv[0] === "log") return { code: 0, stdout: "1a2b3c4\x002026-11-21\n" };
    if (argv[0] === "branch") return { code: 0, stdout: "main\n" };
    if (argv[0] === "status") return { code: 0, stdout: "" };
    if (argv[0] === "rev-parse" && argv[3] === "@{upstream}") return { code: 0, stdout: "origin/main\n" };
    if (argv[0] === "fetch") return { code: 128, stdout: "fatal: unable to access\n" };
    return { code: 1, stdout: "" };
  };
  const b = await readBuildInfo("/any/path", git);
  expect(b?.behind).toBeUndefined();
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
  expect(b?.behind).toBeUndefined();
});

test("marks dirty when status outputs uncommitted changes", async () => {
  const git: GitRunner = async (argv) => {
    if (argv[0] === "log") return { code: 0, stdout: "1a2b3c4\x002026-11-21\n" };
    if (argv[0] === "branch") return { code: 0, stdout: "main\n" };
    if (argv[0] === "status") return { code: 0, stdout: " M file.ts\n?? new.ts\n" };
    return { code: 1, stdout: "" };
  };
  const b = await readBuildInfo("/any/path", git);
  expect(b?.dirty).toBe(true);
});

test("falls back to undefined if git log fails or folder has no .git", async () => {
  const failingGit: GitRunner = async () => ({ code: 128, stdout: "fatal: not a git repository\n" });
  expect(await readBuildInfo("/nonexistent", failingGit)).toBeUndefined();
});

test("falls back to undefined if git output is malformed", async () => {
  const badGit: GitRunner = async () => ({ code: 0, stdout: "not-null-separated\n" });
  expect(await readBuildInfo("/any/path", badGit)).toBeUndefined();
});

test("reads build info from the actual runner checkout", async () => {
  const b = await readBuildInfo(join(import.meta.dir, ".."));
  expect(b).toBeDefined();
  expect(typeof b?.commit).toBe("string");
  expect(b?.commit.length).toBeGreaterThan(0);
  expect(b?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(typeof b?.branch).toBe("string");
  expect(typeof b?.dirty).toBe("boolean");
});
