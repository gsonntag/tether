import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { isAccountSource } from "../../../../shared/credentials";
import { accountIdentity } from "../../accountIdentity";
import { ClaudeAccounts } from "./accounts";
import { CSWAP_RELOGIN, Cswap, cswapBin, cswapSource } from "./cswap";
import { fakeCswap } from "./cswapFixture";

let prior: string | undefined;
let fx: ReturnType<typeof fakeCswap>;
beforeEach(() => {
  fx = fakeCswap();
  prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = fx.shared;
});
afterEach(() => {
  if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prior;
  delete process.env.FAKE_CSWAP_BROKEN;
  delete process.env.FAKE_CSWAP_CODE;
  delete process.env.FAKE_CSWAP_NO_SHARE;
});

const accounts = (primary?: string) => new ClaudeAccounts(join(fx.root, "claude-accounts"), { cswap: { bin: fx.bin, claude: "/bin/false", ...(primary ? { primary: async () => primary } : {}) } });
const id = (email: string) => accountIdentity(email, undefined, `${email}'s Organization`, `org-${email}`).accountId!;

test("discovers signed-in cswap accounts other than the active default, each in its own shared profile", async () => {
  fx.write([{ number: 1, email: "one@example.test", active: true }, { number: 2, email: "two@example.test" }, { number: 3, email: "three@example.test", organizationName: "Acme Team" }]);
  const a = accounts();
  await a.refresh();
  const listed = a.list();
  expect(listed.map(({ identity }) => identity.email)).toEqual(["two@example.test", "three@example.test"]);
  for (const { source } of listed) expect(isAccountSource(source)).toBe(true);
  const [two, three] = listed;
  expect(two!.identity).toEqual({ accountId: id("two@example.test"), email: "two@example.test", organization: "two@example.test's Organization" });
  expect(three!.identity.organization).toBe("Acme Team");
  expect(a.configDir(two!.source)).toBe(fx.profile(2));
  expect(a.configDir(three!.source)).toBe(fx.profile(3));
  // Tether's own state, never a file in cswap's profile.
  const file = a.identityFile(two!.source);
  expect(file.startsWith(join(fx.root, "claude-accounts", ".cswap"))).toBe(true);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(two!.identity);
  expect(existsSync(join(fx.profile(2), ".tether-account.json"))).toBe(false);
  // cswap is asked for history sharing; the active default never gets a profile.
  expect(readFileSync(fx.log, "utf8")).toContain("run 2 --share-history -- --tether-cswap-config-dir");
  expect(readFileSync(fx.log, "utf8")).not.toContain("run 1 ");
  expect(existsSync(fx.profile(1))).toBe(false);
});

test("skips the primary login and Tether's own accounts by identity", async () => {
  fx.write([{ number: 1, email: "primary@example.test" }, { number: 2, email: "native@example.test" }, { number: 3, email: "extra@example.test" }]);
  const a = accounts(id("primary@example.test"));
  const native = a.create();
  a.save(native, { accountId: id("native@example.test"), email: "native@example.test", organization: "native@example.test's Organization" });
  await a.refresh();
  expect(a.list().map(({ source, identity }) => [source === native, identity.email])).toEqual([[true, "native@example.test"], [false, "extra@example.test"]]);
  expect(readFileSync(fx.log, "utf8")).not.toContain("run 1 ");
  expect(readFileSync(fx.log, "utf8")).not.toContain("run 2 ");
});

test("a source stays the same when cswap reorders its slots, and follows the new slot's profile", async () => {
  fx.write([{ number: 2, email: "a@example.test" }, { number: 3, email: "b@example.test" }]);
  const cswap = new Cswap({ stateDir: join(fx.root, "state"), bin: fx.bin, claude: "/bin/false", ttlMs: 0 });
  const before = await cswap.refresh(true);
  fx.write([{ number: 3, email: "a@example.test" }, { number: 2, email: "b@example.test" }]);
  const after = await cswap.refresh(true);
  const a = cswapSource("a@example.test", "org-a@example.test");
  expect(before.find((x) => x.source === a)?.configDir).toBe(fx.profile(2));
  expect(after.find((x) => x.source === a)?.configDir).toBe(fx.profile(3));
  expect(after.map((x) => x.source).sort()).toEqual(before.map((x) => x.source).sort());
  // Email case doesn't change it; another organization does.
  expect(cswapSource("A@Example.test", "org-a@example.test")).toBe(a);
  expect(cswapSource("a@example.test", "other-org")).not.toBe(a);
});

test("an account cswap needs signed in again shows with a hint but can't be used", async () => {
  fx.write([{ number: 2, email: "gone@example.test", usageStatus: "relogin_required" }, { number: 4, email: "key@example.test", usageStatus: "api_key" }]);
  const a = accounts();
  await a.refresh();
  expect(a.list()).toEqual([]);
  const [gone, ...rest] = a.cswap!.accounts();
  expect(rest).toEqual([]);
  expect(gone).toMatchObject({ identity: { email: "gone@example.test" }, problem: CSWAP_RELOGIN });
  expect(a.read(gone!.source)).toBeUndefined();
  expect(() => a.configDir(gone!.source)).toThrow("cswap add");
  expect(readFileSync(fx.log, "utf8")).not.toContain("run ");
  expect(() => a.remove(gone!.source)).toThrow("managed by cswap");
});

test("no cswap, or cswap output it can't read, is no extra accounts and never an error", async () => {
  const missing = new ClaudeAccounts(join(fx.root, "missing"), { cswap: { bin: join(fx.root, "no-such-cswap"), claude: "/bin/false" } });
  await missing.refresh();
  expect(missing.list()).toEqual([]);
  for (const [out, code] of [["not json", "0"], ["{\"schemaVersion\":2,\"accounts\":[]}", "0"], ["{\"schemaVersion\":1,\"accounts\":{}}", "0"], ["boom", "1"]] as const) {
    process.env.FAKE_CSWAP_BROKEN = out;
    process.env.FAKE_CSWAP_CODE = code;
    const a = accounts();
    await a.refresh();
    expect(a.list()).toEqual([]);
  }
});

test("a profile that keeps its own conversations isn't offered: a hop couldn't resume there", async () => {
  process.env.FAKE_CSWAP_NO_SHARE = "1";
  fx.write([{ number: 2, email: "two@example.test" }]);
  const a = accounts();
  await a.refresh();
  expect(a.list()).toEqual([]);
  expect(a.cswap!.accounts()[0]?.problem).toContain("doesn't share");
});

test("each start has cswap refresh the profile, and refuses one that changed", async () => {
  fx.write([{ number: 2, email: "two@example.test" }]);
  const a = accounts();
  await a.refresh();
  const source = a.list()[0]!.source;
  await a.cswap!.prepare(source, fx.profile(2));
  expect(readFileSync(fx.log, "utf8").match(/run 2 --share-history/g)?.length).toBe(2);
  await expect(a.cswap!.prepare(source, "/elsewhere")).rejects.toThrow("Nothing was sent");
  fx.write([{ number: 2, email: "two@example.test", usageStatus: "relogin_required" }]);
  await expect(a.cswap!.prepare(source, fx.profile(2))).rejects.toThrow("cswap add");
});

test("a profile whose history link a plain `cswap run` removed is run again with sharing, then starts", async () => {
  fx.write([{ number: 2, email: "two@example.test" }]);
  const a = accounts();
  await a.refresh();
  const source = a.list()[0]!.source;
  rmSync(join(fx.profile(2), "projects"));
  await a.cswap!.refresh(true);
  expect(a.list().map((x) => x.source)).toEqual([source]);
  expect(realpathSync(join(fx.profile(2), "projects"))).toBe(realpathSync(join(fx.shared, "projects")));
  rmSync(join(fx.profile(2), "projects"));
  await a.cswap!.prepare(source, fx.profile(2));
  expect(realpathSync(join(fx.profile(2), "projects"))).toBe(realpathSync(join(fx.shared, "projects")));
});

test("Tether's account root must be a private folder, not a link, before cswap is pointed at its shim", async () => {
  fx.write([{ number: 2, email: "two@example.test" }]);
  const real = join(fx.root, "elsewhere");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, join(fx.root, "linked"));
  const a = new ClaudeAccounts(join(fx.root, "linked"), { cswap: { bin: fx.bin, claude: "/bin/false" } });
  await a.refresh();
  expect(a.list()).toEqual([]);
  expect(readFileSync(fx.log, "utf8")).not.toContain("run 2");
});

test("a forced discovery reads cswap after the call, not a run already in flight", async () => {
  fx.write([{ number: 2, email: "a@example.test" }]);
  const cswap = new Cswap({ stateDir: join(fx.root, "state"), bin: fx.bin, claude: "/bin/false" });
  const early = cswap.refresh();
  fx.write([{ number: 3, email: "a@example.test" }]);
  const forced = await cswap.refresh(true);
  await early;
  expect(forced[0]?.configDir).toBe(fx.profile(3));
});

test("no_credentials is signed out; TETHER_CSWAP=0 turns discovery off; a bare claude name never runs the shim", async () => {
  fx.write([{ number: 2, email: "none@example.test", usageStatus: "no_credentials" }]);
  const a = accounts();
  await a.refresh();
  expect(a.cswap!.accounts()[0]?.problem).toBe(CSWAP_RELOGIN);
  const prior = process.env.TETHER_CSWAP;
  process.env.TETHER_CSWAP = "0";
  try { expect(cswapBin()).toBeUndefined(); } finally { if (prior === undefined) delete process.env.TETHER_CSWAP; else process.env.TETHER_CSWAP = prior; }
  fx.write([{ number: 2, email: "two@example.test" }]);
  const bare = new Cswap({ stateDir: join(fx.root, "bare"), bin: fx.bin, claude: "no-such-claude-on-path" });
  expect((await bare.refresh(true))[0]?.configDir).toBeUndefined();
  expect(readFileSync(fx.log, "utf8")).not.toContain("run 2");
});
