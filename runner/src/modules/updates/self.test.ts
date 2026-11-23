import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionLook } from "..";
import { restartBusy, SELF_CHECK_EVERY_MS, SELF_FAILED_BACKOFF_MS, SELF_IDLE_FOR_MS, SelfUpdater, type Run } from "./self";

const OLD = "a".repeat(40), NEW = "b".repeat(40);

const look = (p: Partial<SessionLook> & { status?: string; terminal?: boolean } = {}): SessionLook =>
  ({ summary: { title: "S" }, status: p.status ?? "idle", requests: [], busy: false, background: false, state: { requests: [], queue: [], ...(p.terminal ? { terminal: {} } : {}) } }) as unknown as SessionLook;

function setup(o: { branch?: string; dirty?: boolean; ancestor?: boolean; installFails?: boolean; buildFails?: boolean; supported?: string; main?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tether-self-"));
  for (const d of ["shared", "runner/src"]) mkdirSync(join(dir, d), { recursive: true });
  for (const f of ["shared/package.json", "runner/package.json", "runner/src/index.ts"]) writeFileSync(join(dir, f), "{}");
  let head = OLD;
  let now = 1_000_000;
  const looks: SessionLook[] = [look()];
  const calls: string[] = [];
  let restarts = 0;
  const git = async (argv: string[]) => {
    calls.push(`git ${argv.join(" ")}`);
    const [cmd] = argv;
    if (cmd === "rev-parse") return { code: 0, stdout: argv[1] === "HEAD" ? head : (o.main ?? NEW) };
    if (cmd === "branch") return { code: 0, stdout: o.branch ?? "" };
    if (cmd === "status") return { code: 0, stdout: o.dirty ? " M x" : "" };
    if (cmd === "fetch") return { code: 0, stdout: "" };
    if (cmd === "merge-base") return { code: o.ancestor === false ? 1 : 0, stdout: "" };
    if (cmd === "rev-list") return { code: 0, stdout: "3" };
    if (cmd === "checkout") return (head = argv[argv.length - 1]!), { code: 0, stdout: "" };
    return { code: 1, stdout: "" };
  };
  const run: Run = async (argv) => {
    calls.push(argv.slice(1, 2).join(" "));
    if (argv[1] === "install" && o.installFails && head === NEW) return { code: 1, output: "lockfile mismatch" };
    if (argv[1] === "build" && o.buildFails) return { code: 1, output: "Could not resolve x" };
    return { code: 0, output: "" };
  };
  const make = () =>
    new SelfUpdater({ repo: dir, looks: () => looks, git, run, bun: "bun", now: () => now, file: join(dir, "self.json"), restart: () => void restarts++, ...(o.supported ? { supported: () => o.supported } : {}) });
  const u = make();
  return { u, make, dir, looks, calls, get head() { return head; }, get restarts() { return restarts; }, advance: (ms: number) => void (now += ms), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("off by default: no fetch, no restart", async () => {
  const t = setup();
  await t.u.tick();
  expect(t.u.status()).toMatchObject({ enabled: false });
  expect(t.calls).toEqual([]);
  t.cleanup();
});

test("a newer main waits for every session to be idle a while, then checks out, installs, test-builds and restarts", async () => {
  const t = setup();
  t.u.set(true);
  t.looks[0] = look({ status: "running" });
  await t.u.tick();
  expect(t.u.status()).toMatchObject({ available: { commit: NEW, behind: 3 }, waiting: { why: '"S" is running a turn' } });
  expect(t.head).toBe(OLD);
  // idle, but not for long enough yet
  t.looks[0] = look();
  await t.u.tick();
  expect(t.restarts).toBe(0);
  expect(t.u.status().waiting?.why).toContain("waiting a few minutes");
  t.advance(SELF_IDLE_FOR_MS);
  await t.u.tick();
  expect(t.head).toBe(NEW);
  expect(t.calls).toContain("install");
  expect(t.calls).toContain("build");
  expect(t.restarts).toBe(1);
  // the next start says it came back on the new commit
  const after = t.make();
  const stop = await after.start();
  stop();
  expect(after.status().last).toMatchObject({ from: OLD, to: NEW, ok: true });
  expect(JSON.parse(readFileSync(join(t.dir, "self.json"), "utf8")).restarting).toBeUndefined();
  t.cleanup();
});

test("a session starting in between resets the idle wait", async () => {
  const t = setup();
  t.u.set(true);
  await t.u.tick();
  t.advance(SELF_IDLE_FOR_MS - 1);
  t.looks[0] = look({ status: "running" });
  await t.u.tick();
  t.looks[0] = look();
  t.advance(SELF_IDLE_FOR_MS - 1);
  await t.u.tick();
  expect(t.restarts).toBe(0);
  t.cleanup();
});

test("a terminal doesn't hold the restart (tmux outlives it); a turn or a request does", () => {
  expect(restartBusy([look({ terminal: true })])).toBeUndefined();
  expect(restartBusy([look({ status: "waiting" })])).toContain("waiting on the person");
  expect(restartBusy([look({ status: "running" }), look({ status: "running" })])).toBe("2 sessions are busy");
});

test("a failed install goes back to the old commit, reports it, and isn't retried for a day", async () => {
  const t = setup({ installFails: true });
  t.u.set(true);
  await t.u.tick();
  t.advance(SELF_IDLE_FOR_MS);
  await t.u.tick();
  expect(t.head).toBe(OLD);
  expect(t.restarts).toBe(0);
  expect(t.u.status().last).toMatchObject({ ok: false, from: OLD, to: NEW, error: "bun install failed", output: "lockfile mismatch" });
  t.advance(SELF_CHECK_EVERY_MS);
  await t.u.tick();
  t.advance(SELF_IDLE_FOR_MS);
  await t.u.tick();
  expect(t.calls.filter((c) => c === `git checkout --quiet --detach ${NEW}`)).toHaveLength(1);
  t.advance(SELF_FAILED_BACKOFF_MS);
  await t.u.tick();
  t.advance(SELF_IDLE_FOR_MS);
  await t.u.tick();
  expect(t.calls.filter((c) => c === `git checkout --quiet --detach ${NEW}`)).toHaveLength(2);
  t.cleanup();
});

test("a session starting during the install: back to the old commit, and it tries again at the next idle", async () => {
  const t = setup();
  t.u.set(true);
  await t.u.tick();
  t.advance(SELF_IDLE_FOR_MS);
  const looks = t.looks;
  let builds = 0;
  // the build is the last step before the final look
  const orig = (t.u as any).run;
  (t.u as any).run = async (argv: string[], cwd: string) => {
    if (argv[1] === "build" && builds++ === 0) looks[0] = look({ status: "running" });
    return orig(argv, cwd);
  };
  await t.u.tick();
  expect(t.head).toBe(OLD);
  expect(t.restarts).toBe(0);
  expect(t.u.status().last).toBeUndefined();
  looks[0] = look();
  await t.u.tick();
  t.advance(SELF_IDLE_FOR_MS);
  await t.u.tick();
  expect(t.head).toBe(NEW);
  expect(t.restarts).toBe(1);
  t.cleanup();
});

test("a failed test build goes back too", async () => {
  const t = setup({ buildFails: true });
  t.u.set(true);
  await t.u.tick();
  t.advance(SELF_IDLE_FOR_MS);
  await t.u.tick();
  expect(t.head).toBe(OLD);
  expect(t.restarts).toBe(0);
  expect(t.u.status().last).toMatchObject({ ok: false, error: "the test build failed" });
  t.cleanup();
});

test("never touches a branch, local changes, local commits, or a runner systemd doesn't run", async () => {
  for (const [o, why] of [
    [{ branch: "main" }, "branch main"],
    [{ dirty: true }, "local changes"],
    [{ ancestor: false }, "isn't on origin/main"],
    [{ supported: "The runner isn't run by systemd, so it can't restart itself." }, "systemd"],
  ] as const) {
    const t = setup(o);
    t.u.set(true);
    await t.u.tick();
    t.advance(SELF_IDLE_FOR_MS);
    await t.u.tick();
    expect(t.u.status().unsupported).toContain(why);
    expect(t.calls.some((c) => c.startsWith("git checkout"))).toBe(false);
    expect(t.restarts).toBe(0);
    t.cleanup();
  }
});

test("up to date: nothing waits, nothing restarts", async () => {
  const t = setup({ main: OLD });
  t.u.set(true);
  await t.u.tick();
  t.advance(SELF_IDLE_FOR_MS);
  await t.u.tick();
  expect(t.u.status()).toMatchObject({ enabled: true, commit: OLD });
  expect(t.u.status().available).toBeUndefined();
  expect(t.u.status().waiting).toBeUndefined();
  expect(t.restarts).toBe(0);
  t.cleanup();
});
