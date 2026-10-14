import { describe, expect, test } from "bun:test";
import { addModeOf, filterRepos, isMissing, isOldRunner } from "./addProject";

describe("add project", () => {
  test("a stored mode is used only if it's still a mode", () => {
    expect(addModeOf("clone")).toBe("clone");
    expect(addModeOf("new")).toBe("new");
    for (const bad of [null, "", "github", "__proto__"]) expect(addModeOf(bad)).toBe("folder");
  });

  test("only a missing folder offers creating it", () => {
    expect(isMissing("/home/me/x doesn't exist")).toBe(true);
    expect(isMissing("ENOENT: no such file or directory, scandir '/home/me/x'")).toBe(true); // older runners
    for (const other of ["EACCES: permission denied, scandir '/root'", "/home/me/a.txt is a file, not a folder", "Not connected", "Connection lost"])
      expect(isMissing(other)).toBe(false);
  });

  test("an old runner is told apart from gh being logged out", () => {
    expect(isOldRunner(`This runner doesn't know "githubAccount": it's older than the web app. Restart it to update.`)).toBe(true);
    expect(isOldRunner("Not connected")).toBe(false);
  });

  test("filter matches every word anywhere in org/name, capped", () => {
    const repos = ["acme/widget", "acme/gadget", "me/widget-docs"].map((nameWithOwner) => ({ nameWithOwner }));
    expect(filterRepos(repos, "WIDGET").map((r) => r.nameWithOwner)).toEqual(["acme/widget", "me/widget-docs"]);
    expect(filterRepos(repos, "acme gad").map((r) => r.nameWithOwner)).toEqual(["acme/gadget"]);
    expect(filterRepos(repos, " ")).toHaveLength(3);
    expect(filterRepos(repos, "", 2)).toHaveLength(2);
  });
});
