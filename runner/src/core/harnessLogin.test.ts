import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSWAP_MANAGED, ClaudeAccounts } from "../adapters/claude/accounts";
import { CSWAP_RELOGIN } from "../adapters/claude/cswap";
import { fakeCswap } from "../adapters/claude/cswapFixture";
import type { HarnessAccount } from "../../../shared/harnessLogin";
import { HARNESS_BINS } from "../adapters/detect";
import { registerHarnessLogin } from "./harnessLogin";
import { OpRegistry } from "./ops";
import { Prefs } from "./prefs";

async function waitFor<T>(read: () => Promise<T | undefined>) {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error("Harness sign-in did not reach the expected state.");
}

test("a CLI challenge and paste-back stay with the initiating owner", async () => {
  const previous = HARNESS_BINS.claude;
  const dir = mkdtempSync(join(tmpdir(), "tether-login-test-"));
  const cli = join(dir, "claude");
  const marker = join(dir, "signed-in");
  const url = "https://claude.ai/oauth/authorize?state=testing";
  writeFileSync(cli, `#!/bin/sh
case "$*" in
  "auth login --claudeai")
    printf 'private-harness-output\\nhttps://elsewhere.example/ignored\\n%s\\nPaste code here if prompted > ' '${url}'
    read -r code
    [ "$code" = 'test-code#state' ] || exit 1
    printf 'access-token=private-access-token\\n'
    touch '${marker}'
    ;;
  *"auth status --json")
    if test -f '${marker}'; then
      printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","email":"owner@example.test","subscriptionType":"max","orgName":"Test Organization","orgId":"test-org","accessToken":"private-access-token"}'
    else
      printf '%s\\n' '{"loggedIn":false}'
      exit 1
    fi
    ;;
  "auth logout") rm '${marker}' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  HARNESS_BINS.claude = cli;
  const ops = new OpRegistry();
  const changed: string[] = [];
  const file = join(dir, "runner.json");
  writeFileSync(file, JSON.stringify({ runnerId: "test-runner" }));
  const stop = registerHarnessLogin(ops, (h) => changed.push(h), new Prefs(file));
  const owner = "owner-one";
  const remote = (op: string, args: unknown) => ops.handle(op, args, owner);
  try {
    const harness = { harness: "claude" };
    expect(await remote("harnessLoginStatus", harness)).toEqual({ ok: true, data: { state: "signedOut" } });
    expect(await ops.handle("harnessLoginStart", { ...harness, loginOwner: owner })).toMatchObject({ ok: false });
    const started = await remote("harnessLoginStart", harness);
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const flow = started.data as { flowId: string };
    // The same owner (e.g. after a page reload) gets the running flow back; anyone else is refused.
    expect(await remote("harnessLoginStart", harness)).toEqual({ ok: true, data: flow });
    expect(await ops.handle("harnessLoginStart", harness, "other-owner")).toMatchObject({ ok: false });
    expect(await remote("harnessLogout", harness)).toMatchObject({ ok: false });
    const prompt = await waitFor(async () => {
      const response = await remote("harnessLoginPoll", flow);
      if (response.ok && (response.data as { acceptsCode?: boolean }).acceptsCode) return response.data;
    });
    expect(prompt).toEqual({ state: "pending", url, acceptsCode: true });
    expect(await ops.handle("harnessLoginPoll", flow, "other-owner")).toMatchObject({ ok: false });
    expect(await ops.handle("harnessLoginCode", { ...flow, code: "test-code#state" }, "other-owner")).toMatchObject({ ok: false });
    expect(await remote("harnessLoginCode", { ...flow, code: "code\nextra" })).toMatchObject({ ok: false });
    expect(await remote("harnessLoginCode", { ...flow, code: "test-code#state" })).toEqual({ ok: true, data: null });
    const result = await waitFor(async () => {
      const response = await remote("harnessLoginPoll", flow);
      if (response.ok && (response.data as { state: string }).state !== "pending") return response.data;
    });
    expect(result).toEqual({ state: "done" });
    const status = await remote("harnessLoginStatus", harness);
    expect(status).toEqual({ ok: true, data: { state: "signedIn", email: "owner@example.test", plan: "max", organization: "Test Organization", accountId: expect.any(String) } });
    if (!status.ok) throw new Error(status.error);
    const { accountId } = status.data as { accountId: string };
    const rename = { ...harness, accountId, displayName: "  Work  " };
    expect(await ops.handle("renameHarnessAccount", rename)).toMatchObject({ ok: false });
    expect(await remote("renameHarnessAccount", { ...rename, accountId: "previous-login" })).toMatchObject({ ok: false });
    expect(await remote("renameHarnessAccount", rename)).toMatchObject({ ok: true, data: { displayName: "Work" } });
    expect(await remote("harnessLoginStatus", harness)).toMatchObject({ ok: true, data: { displayName: "Work" } });
    expect(new Prefs(file).accountName("claude", accountId)).toBe("Work");
    expect(new Prefs(file).accountName("claude", "different-account")).toBeUndefined();
    expect(await remote("renameHarnessAccount", { ...rename, displayName: "" })).toEqual(status);
    expect(new Prefs(file).accountName("claude", accountId)).toBeUndefined();
    expect(await remote("harnessLogout", harness)).toEqual({ ok: true, data: { state: "signedOut" } });
    expect(changed).toEqual(["claude", "claude"]);

    const another = await remote("harnessLoginStart", harness);
    expect(another.ok).toBe(true);
    if (!another.ok) throw new Error(another.error);
    expect(await remote("harnessLoginCancel", another.data)).toEqual({ ok: true, data: null });
    expect(await remote("harnessLoginPoll", another.data)).toEqual({ ok: true, data: { state: "cancelled" } });
    // A cancelled flow is not resumed: once its process exits, Start begins a fresh flow.
    const fresh = await waitFor(async () => {
      const response = await remote("harnessLoginStart", harness);
      if (response.ok) return response.data as { flowId: string };
    });
    expect(fresh.flowId).not.toBe((another.data as { flowId: string }).flowId);
    expect(await remote("harnessLoginCancel", fresh)).toEqual({ ok: true, data: null });
  } finally {
    stop();
    HARNESS_BINS.claude = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex uses device authorization on the subscription daemon and cancels its challenge", async () => {
  const { setConnector } = await import("../adapters/codex/daemon");
  const { CodexRpc } = await import("../adapters/codex/rpc");
  const previous = HARNESS_BINS.codex;
  HARNESS_BINS.codex = process.execPath;
  let closed = false;
  const daemon = new CodexRpc();
  const calls: { method: string; params: unknown }[] = [];
  daemon.wire = {
    send(text) {
      const { method, params, id } = JSON.parse(text);
      calls.push({ method, params });
      const result = method === "account/login/start"
        ? { type: "chatgptDeviceCode", loginId: "own-login", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" }
        : {};
      queueMicrotask(() => daemon.receive(JSON.stringify({ id, result })));
    },
    close() { closed = true; },
  };
  setConnector(async () => daemon);
  const ops = new OpRegistry();
  const stop = registerHarnessLogin(ops, () => {});
  const remote = (op: string, args: unknown) => ops.handle(op, args, "owner");
  try {
    const started = await remote("harnessLoginStart", { harness: "codex" });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);
    const challenge = await waitFor(async () => {
      const response = await remote("harnessLoginPoll", started.data);
      if (response.ok && (response.data as { deviceCode?: string }).deviceCode) return response.data;
    });
    expect(challenge).toEqual({ state: "pending", url: "https://auth.openai.com/codex/device", deviceCode: "ABCD-EFGH" });
    await remote("harnessLoginCancel", started.data);
    await waitFor(async () => closed || undefined);
    expect(calls).toEqual([
      { method: "account/login/start", params: { type: "chatgptDeviceCode" } },
      { method: "account/login/cancel", params: { loginId: "own-login" } },
    ]);
  } finally {
    stop();
    setConnector(undefined);
    HARNESS_BINS.codex = previous;
  }
});

test("additional Claude sign-ins isolate credentials, share session files, and remove only their own folder", async () => {
  const previousBin = HARNESS_BINS.claude;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "tether-extra-login-"));
  const primary = join(dir, "primary");
  const root = join(dir, "accounts");
  mkdirSync(primary);
  writeFileSync(join(primary, "settings.json"), "{}");
  writeFileSync(join(primary, "login"), "primary");
  const cli = join(dir, "claude");
  writeFileSync(cli, `#!/bin/sh
case "$*" in
  "auth login --claudeai")
    echo "https://claude.ai/oauth/authorize?state=testing"
    echo "Paste code here if prompted"
    read -r code
    [ -n "$code" ] || exit 1
    printf '%s' "$code" > "$CLAUDE_CONFIG_DIR/login"
    ;;
  *"auth status --json")
    [ -f "$CLAUDE_CONFIG_DIR/login" ] || exit 1
    identity=$(cat "$CLAUDE_CONFIG_DIR/login")
    printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"%s@example.test","orgName":"Test Organization","orgId":"%s","subscriptionType":"max"}\n' "$identity" "$identity"
    ;;
  "auth logout") touch '${join(dir, "logged-out")}' ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  HARNESS_BINS.claude = cli;
  process.env.CLAUDE_CONFIG_DIR = primary;
  const accounts = new ClaudeAccounts(root);
  const ops = new OpRegistry();
  const file = join(dir, "runner.json");
  writeFileSync(file, JSON.stringify({ runnerId: "test-runner" }));
  let inUse = false;
  const stop = registerHarnessLogin(ops, () => {}, new Prefs(file), accounts, () => inUse);
  const remote = (op: string, args: unknown) => ops.handle(op, args, "owner");
  const harness = { harness: "claude" };
  const list = async () => {
    const result = await remote("listHarnessAccounts", harness);
    if (!result.ok) throw new Error(result.error);
    return result.data as HarnessAccount[];
  };
  async function signIn(account: string, code: string) {
    const result = await remote("harnessLoginStart", { ...harness, account });
    if (!result.ok) throw new Error(result.error);
    const flow = result.data as { flowId: string };
    await waitFor(async () => {
      const poll = await remote("harnessLoginPoll", flow);
      if (poll.ok && (poll.data as { acceptsCode?: boolean }).acceptsCode) return true;
    });
    expect(await remote("harnessLoginCode", { ...flow, code })).toMatchObject({ ok: true });
    return waitFor(async () => {
      const poll = await remote("harnessLoginPoll", flow);
      if (poll.ok && (poll.data as { state: string }).state !== "pending") return poll.data;
    });
  }
  try {
    expect(await ops.handle("listHarnessAccounts", harness)).toMatchObject({ ok: false });
    expect(await signIn("new", "secondary")).toEqual({ state: "done" });
    const [entry] = await list();
    expect(entry).toMatchObject({ available: true, status: { email: "secondary@example.test", organization: "Test Organization" } });
    const config = accounts.configDir(entry!.source);
    expect(statSync(config).mode & 0o777).toBe(0o700);
    for (const name of ["projects", "history.jsonl", "settings.json", "keybindings.json", "CLAUDE.md", "skills", "commands", "agents", "rules"]) {
      expect(readlinkSync(join(config, name))).toBe(join(primary, name));
    }
    writeFileSync(join(config, "projects", "shared-session"), "transcript");
    expect(existsSync(join(primary, "projects", "shared-session"))).toBe(true);
    expect(await signIn("new", "secondary")).toEqual({ state: "failed" });
    expect(readdirSync(root)).toHaveLength(1);
    expect(await signIn(entry!.source, "different")).toEqual({ state: "failed" });
    expect((await list())[0]).toMatchObject({ available: false, status: { email: "secondary@example.test" } });
    expect(await signIn(entry!.source, "secondary")).toEqual({ state: "done" });
    const accountId = accounts.read(entry!.source)!.accountId;
    expect(await remote("renameHarnessAccount", { ...harness, source: entry!.source, accountId, displayName: "Work" })).toMatchObject({ ok: true, data: { displayName: "Work" } });
    expect((await list())[0]).toMatchObject({ status: { displayName: "Work" } });
    const removal = { ...harness, source: entry!.source };
    expect(await ops.handle("removeHarnessAccount", removal)).toMatchObject({ ok: false });
    inUse = true;
    expect(await remote("removeHarnessAccount", removal)).toMatchObject({ ok: false });
    inUse = false;
    expect(await remote("removeHarnessAccount", removal)).toEqual({ ok: true, data: null });
    expect(await list()).toEqual([]);
    expect(existsSync(config)).toBe(false);
    expect(existsSync(join(dir, "logged-out"))).toBe(false);
    expect(existsSync(join(primary, "settings.json"))).toBe(true);
    expect(existsSync(join(primary, "projects", "shared-session"))).toBe(true);
    expect(await remote("harnessLoginStatus", harness)).toMatchObject({ ok: true, data: { email: "primary@example.test" } });
  } finally {
    stop();
    HARNESS_BINS.claude = previousBin;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cswap accounts list as managed by cswap: renamed in Tether, signed in and removed only with cswap", async () => {
  const previousBin = HARNESS_BINS.claude;
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const fx = fakeCswap();
  const dir = fx.root;
  const cli = join(dir, "claude");
  writeFileSync(cli, `#!/bin/sh
case "$*" in
  *"auth status --json")
    [ -f "$CLAUDE_CONFIG_DIR/login" ] || { echo '{"loggedIn":false}'; exit 1; }
    identity=$(cat "$CLAUDE_CONFIG_DIR/login")
    printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"%s@example.test","orgName":"Test Organization","orgId":"%s","subscriptionType":"max"}\\n' "$identity" "$identity"
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o700 });
  HARNESS_BINS.claude = cli;
  process.env.CLAUDE_CONFIG_DIR = fx.shared;
  fx.write([
    { number: 2, email: "ok@example.test", organizationName: "Test Organization", organizationUuid: "ok" },
    { number: 3, email: "gone@example.test", usageStatus: "relogin_required" },
  ]);
  const accounts = new ClaudeAccounts(join(dir, "accounts"), { cswap: { bin: fx.bin, claude: cli } });
  const file = join(dir, "runner.json");
  writeFileSync(file, JSON.stringify({ runnerId: "test-runner" }));
  const registry = new OpRegistry();
  const stop = registerHarnessLogin(registry, () => {}, new Prefs(file), accounts);
  const remote = (op: string, args: unknown) => registry.handle(op, args, "owner");
  const list = async () => {
    const result = await remote("listHarnessAccounts", { harness: "claude" });
    if (!result.ok) throw new Error(result.error);
    return result.data as HarnessAccount[];
  };
  try {
    await accounts.refresh();
    writeFileSync(join(fx.profile(2), "login"), "ok");
    const [ok, gone] = await list();
    expect(ok).toMatchObject({ available: true, managedBy: "cswap", status: { state: "signedIn", email: "ok@example.test", organization: "Test Organization" } });
    expect(ok).not.toHaveProperty("hint");
    expect(gone).toMatchObject({ available: false, managedBy: "cswap", hint: CSWAP_RELOGIN, status: { email: "gone@example.test" } });
    const source = ok!.source;
    expect(await remote("removeHarnessAccount", { harness: "claude", source })).toMatchObject({ ok: false, error: CSWAP_MANAGED });
    expect(await remote("harnessLoginStart", { harness: "claude", account: source })).toMatchObject({ ok: false, error: CSWAP_MANAGED });
    expect(existsSync(fx.profile(2))).toBe(true);
    const accountId = accounts.read(source)!.accountId;
    expect(await remote("renameHarnessAccount", { harness: "claude", source, accountId, displayName: "Side" })).toMatchObject({ ok: true });
    expect((await list())[0]).toMatchObject({ status: { displayName: "Side" } });
    // Signed out in its profile: still listed, with what to do in cswap.
    rmSync(join(fx.profile(2), "login"));
    expect((await list())[0]).toMatchObject({ source, available: false, hint: CSWAP_RELOGIN });
  } finally {
    stop();
    HARNESS_BINS.claude = previousBin;
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
  }
});
