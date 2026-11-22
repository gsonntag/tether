import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_BINS } from "../adapters/detect";
import { registerHarnessLogin } from "./harnessLogin";
import { OpRegistry } from "./ops";

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
      printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","email":"owner@example.test","subscriptionType":"max","accessToken":"private-access-token"}'
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
  const stop = registerHarnessLogin(ops, (h) => changed.push(h));
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
    expect(await remote("harnessLoginStart", harness)).toMatchObject({ ok: false });
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
    expect(await remote("harnessLoginStatus", harness)).toEqual({ ok: true, data: { state: "signedIn", email: "owner@example.test", plan: "max" } });
    expect(await remote("harnessLogout", harness)).toEqual({ ok: true, data: { state: "signedOut" } });
    expect(changed).toEqual(["claude", "claude"]);

    const another = await remote("harnessLoginStart", harness);
    expect(another.ok).toBe(true);
    if (!another.ok) throw new Error(another.error);
    expect(await remote("harnessLoginCancel", another.data)).toEqual({ ok: true, data: null });
    expect(await remote("harnessLoginPoll", another.data)).toEqual({ ok: true, data: { state: "cancelled" } });
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
