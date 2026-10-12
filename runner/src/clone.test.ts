import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneRepo, parseRepo } from "./clone";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("parseRepo", () => {
  const ssh = { url: "git@github.com:acme/widget.git", name: "widget" };
  test.each([
    "acme/widget",
    " acme/widget.git ",
    "github.com/acme/widget",
    "https://github.com/acme/widget",
    "https://github.com/acme/widget.git",
    "https://www.github.com/acme/widget/",
    "git@github.com:acme/widget",
    "git@github.com:acme/widget.git",
    "ssh://git@github.com/acme/widget.git",
  ])("GitHub over SSH: %s", (input) => expect(parseRepo(input)).toEqual(ssh));

  test("other hosts are cloned as given", () => {
    expect(parseRepo("git@gitlab.com:acme/sub/widget.git")).toEqual({ url: "git@gitlab.com:acme/sub/widget.git", name: "widget" });
    expect(parseRepo("https://gitlab.com/acme/widget")).toEqual({ url: "https://gitlab.com/acme/widget", name: "widget" });
  });

  test.each(["", "widget", "acme/../x", "acme/.git", "gitlab.com/acme/widget", "acme/widget; rm -rf ~", "-c core.sshCommand=x acme/w"])("rejects %p", (input) =>
    expect(() => parseRepo(input)).toThrow(),
  );
});

describe("cloneRepo", () => {
  test("refuses a folder that is something else", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "clone-")));
    dirs.push(parent);
    mkdirSync(join(parent, "widget"));
    await expect(cloneRepo("acme/widget", parent)).rejects.toThrow("already exists");
  });

  test("reuses an existing clone of the same repo", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "clone-")));
    dirs.push(parent);
    const dest = join(parent, "widget");
    mkdirSync(dest);
    Bun.spawnSync(["git", "init", "-q", dest]);
    Bun.spawnSync(["git", "-C", dest, "remote", "add", "origin", "https://github.com/acme/widget"]);
    expect(await cloneRepo("git@github.com:acme/widget.git", parent)).toBe(dest);
  });
});
