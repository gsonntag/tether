// Real tmux, on a socket of the test's own (never Tether's).

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, projectKey, shellName, Tmux, tuiName } from "./tmux";

const tmux = new Tmux({ socket: `tether-test-${process.pid}` });
const dir = mkdtempSync(join(tmpdir(), "tether-tmux-"));
afterAll(() => tmux.killServer());

const until = async (f: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(30);
  }
};

test("names are valid tmux session names", () => {
  expect(tuiName("claude:0bf.a:x")).toBe("t-claude-0bf-a-x");
  expect(shellName(projectKey("/a/b"), 2)).toMatch(/^sh-[0-9a-f]{10}-2$/);
  expect(projectKey("/a/b")).toBe(projectKey("/a/b"));
});

test("the environment loses Tether's secrets and tmux's nesting markers", () => {
  const env = cleanEnv({ PATH: "/bin", TETHER_TOKEN: "secret", TETHER_URL: "u", TMUX: "x", HOME: "/h" });
  expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
});

test("sessions are created tagged, listed, typed into, and killed", async () => {
  expect(await tmux.list()).toEqual([]);
  expect(await tmux.running()).toBe(false);
  await tmux.create({ name: "sh-test-1", cwd: dir, argv: ["sh"], cols: 90, rows: 20, tags: { kind: "shell", project: dir, n: "1" } });
  await tmux.create({ name: "t-claude-x", cwd: dir, argv: ["sh"], tags: { kind: "tui", session: "claude:x", project: dir } });
  const list = await tmux.list();
  expect(list.map((t) => [t.name, t.kind, t.sessionId, t.projectPath, t.n])).toEqual([
    ["sh-test-1", "shell", undefined, dir, 1],
    ["t-claude-x", "tui", "claude:x", dir, undefined],
  ]);
  expect(await tmux.has("sh-test-1")).toBe(true);
  expect(await tmux.has("sh-test")).toBe(false); // exact names only

  await tmux.type("sh-test-1", "echo hel''lo $((40+2))");
  await tmux.keys("sh-test-1", "Enter");
  await until(async () => (await tmux.capture("sh-test-1")).includes("hello 42"));
  // A trailing ";" is kept (tmux would read it as a command separator).
  await tmux.type("sh-test-1", "echo semi;");
  await tmux.type("sh-test-1", " echo colon;");
  await tmux.keys("sh-test-1", "Enter");
  await until(async () => /^semi\ncolon$/m.test(await tmux.capture("sh-test-1")));
  await tmux.tag("sh-test-1", "return", "1");
  expect((await tmux.list()).find((t) => t.name === "sh-test-1")?.returnWhenIdle).toBe(true);
  await tmux.tag("sh-test-1", "return", undefined);
  expect((await tmux.list()).find((t) => t.name === "sh-test-1")?.returnWhenIdle).toBeUndefined();
  // Several lines go in as a paste.
  await tmux.type("sh-test-1", "echo one\necho two\n");
  await until(async () => /two\n/.test(await tmux.capture("sh-test-1")));

  // The server is set up for a browser client.
  const p = Bun.spawn(tmux.argv("show-options", "-g", "window-size"), { stdout: "pipe" });
  expect(await new Response(p.stdout).text()).toContain("latest");

  // A shell that exits ends its session.
  await tmux.type("sh-test-1", "exit");
  await tmux.keys("sh-test-1", "Enter");
  await until(async () => !(await tmux.has("sh-test-1")));
  await tmux.kill("t-claude-x");
  expect(await tmux.list()).toEqual([]);
});

test("two sessions started at once share one server", async () => {
  await Promise.all([1, 2, 3].map((n) => tmux.create({ name: `sh-race-${n}`, cwd: dir, argv: ["sh"], tags: { kind: "shell", project: dir, n: String(n) } })));
  expect((await tmux.list()).map((t) => t.name).sort()).toEqual(["sh-race-1", "sh-race-2", "sh-race-3"]);
  for (const n of [1, 2, 3]) await tmux.kill(`sh-race-${n}`);
});
