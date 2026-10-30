// Real tmux, on a socket of the test's own (never Tether's).

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, projectKey, SERVER_OPTIONS, shellName, Tmux, tuiName } from "./tmux";

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

test("the server is started on its own, stays up between sessions, and looks like tmux, not like what runs in it", async () => {
  await tmux.killServer();
  const t = new Tmux({ socket: tmux.socket, wrapStart: (argv) => ["env", "INVOCATION_ID=x", "JOURNAL_STREAM=1:2", ...argv] });
  await t.create({ name: "t-claude-title", cwd: dir, argv: ["sh", "-c", "sleep 30 # claude --resume x"], tags: { kind: "tui", session: "claude:x", project: dir } });
  const pid = Bun.spawnSync(t.argv("display", "-p", "#{pid}")).stdout.toString().trim();
  const title = (await Bun.file(`/proc/${pid}/cmdline`).text()).replace(/\0/g, " ");
  expect(title).toContain("start-server");
  expect(title).not.toContain("claude");
  // No systemd markers for the shells and TUIs it runs.
  const env = Bun.spawnSync(t.argv("show-environment", "-g")).stdout.toString();
  expect(env).not.toMatch(/^INVOCATION_ID=/m);
  expect(env).not.toMatch(/^JOURNAL_STREAM=/m);
  await t.kill("t-claude-title");
  // Still up with no session left: the next session's command is only a client.
  expect(await t.running()).toBe(true);
  expect(Bun.spawnSync(t.argv("show-options", "-gv", "exit-empty")).stdout.toString().trim()).toBe("off");
  await t.create({ name: "sh-semi-1", cwd: `${dir}`, argv: ["sh"], tags: { kind: "shell", project: `${dir};`, n: "1" } });
  expect((await t.list()).find((x) => x.name === "sh-semi-1")?.projectPath).toBe(`${dir};`);
  await t.killServer();
});

test("two sessions started at once share one server", async () => {
  await Promise.all([1, 2, 3].map((n) => tmux.create({ name: `sh-race-${n}`, cwd: dir, argv: ["sh"], tags: { kind: "shell", project: dir, n: String(n) } })));
  expect((await tmux.list()).map((t) => t.name).sort()).toEqual(["sh-race-1", "sh-race-2", "sh-race-3"]);
  for (const n of [1, 2, 3]) await tmux.kill(`sh-race-${n}`);
});

test("an option this tmux refuses is skipped and logged; the rest apply and terminals open", async () => {
  await tmux.killServer();
  const logged: string[] = [];
  SERVER_OPTIONS.push(["set", "-g", "no-such-option-tether", "1"]);
  try {
    const t = new Tmux({ socket: tmux.socket, log: (l) => logged.push(l) });
    await t.create({ name: "sh-opt-1", cwd: dir, argv: ["sh"], tags: { kind: "shell", project: dir, n: "1" } });
    expect(await t.has("sh-opt-1")).toBe(true);
    expect(logged.join("\n")).toContain("no-such-option-tether");
    expect(Bun.spawnSync(t.argv("show-options", "-gv", "window-size")).stdout.toString().trim()).toBe("latest");
    expect(Bun.spawnSync(t.argv("show-options", "-gv", "status")).stdout.toString().trim()).toBe("off");
    await t.killServer();
  } finally {
    SERVER_OPTIONS.pop();
  }
});

test("tags and pastes target a session by its exact name, never a sibling by prefix", async () => {
  await tmux.create({ name: "t-claude-y-ab12", cwd: dir, argv: ["sh"], tags: { kind: "tui", session: "claude:y2", project: dir } });
  await expect(tmux.tag("t-claude-y", "return", "1")).rejects.toThrow();
  expect((await tmux.list()).find((t) => t.name === "t-claude-y-ab12")?.returnWhenIdle).toBeUndefined();
  await tmux.type("t-claude-y-ab12", "echo pasted-$((6*7))", true);
  await tmux.keys("t-claude-y-ab12", "Enter");
  await until(async () => (await tmux.capture("t-claude-y-ab12")).includes("pasted-42"));
  await tmux.kill("t-claude-y-ab12");
});

test("history: the scrollback and the screen as text (the panel's Copy)", async () => {
  await tmux.create({ name: "sh-hist-1", cwd: dir, argv: ["sh"], cols: 40, rows: 5, tags: { kind: "shell", project: dir, n: "9" } });
  await tmux.type("sh-hist-1", "seq 1 200; echo LONG-$(printf 'x%.0s' $(seq 1 60))");
  await tmux.keys("sh-hist-1", "Enter");
  await until(async () => (await tmux.history("sh-hist-1")).includes("LONG-"));
  const h = await tmux.history("sh-hist-1");
  // Lines long since scrolled off the 5-row screen are there, and a wrapped line is one line.
  expect(h).toMatch(/^1$/m);
  expect(h).toMatch(/^200$/m);
  expect(h).toMatch(/LONG-x{60}/);
  expect(await tmux.capture("sh-hist-1")).not.toMatch(/^1$/m);
});
