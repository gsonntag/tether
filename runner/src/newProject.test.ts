import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkName, createProject } from "./newProject";

describe("checkName", () => {
  test("keeps GitHub-safe names", () => {
    expect(checkName("  email-reply ")).toBe("email-reply");
    expect(checkName("my_app.v2")).toBe("my_app.v2");
  });
  test("refuses paths, spaces and dot names", () => {
    for (const bad of ["", "a/b", "my app", ".hidden", "..", "x;rm"]) expect(() => checkName(bad)).toThrow("can't be a project name");
  });
});

describe("createProject (no GitHub)", () => {
  test("makes parent/name with git init on main, creating the parent too", async () => {
    const parent = join(mkdtempSync(join(tmpdir(), "tether-new-")), "projects");
    const dir = await createProject({ name: "email-reply", parent });
    expect(dir).toBe(join(parent, "email-reply"));
    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(Bun.spawnSync(["git", "-C", dir, "symbolic-ref", "--short", "HEAD"]).stdout.toString().trim()).toBe("main");
  });
  test("an existing empty folder is fine; one with files is refused", async () => {
    const parent = mkdtempSync(join(tmpdir(), "tether-new-"));
    mkdirSync(join(parent, "empty"));
    expect(await createProject({ name: "empty", parent })).toBe(join(parent, "empty"));
    mkdirSync(join(parent, "full"));
    writeFileSync(join(parent, "full", "a.txt"), "x");
    await expect(createProject({ name: "full", parent })).rejects.toThrow("isn't empty");
  });
});
