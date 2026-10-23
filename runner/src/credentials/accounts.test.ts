// Harness logins and extra accounts (credentials/accounts.ts, signin.ts, authError.ts): homes that
// mirror the machine's config but not its login, removal that never follows a link, env per
// account, usage read from the account's own login, quota per account, sign-in relays (link and
// code read out of the CLI, the pasted code written back, a half-made account cleaned up), and
// auth errors pointing at the right login. Fake CLIs only: no real login is read or touched.

import { resetHome } from "../testenv";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEntry } from "../../../web/src/shared/protocol";
import { config } from "../config";
import { markExhausted, pickEntry, quotaKey } from "../fallback";
import { userHome } from "../home";
import {
  accountHome,
  accountLabel,
  accountPlugins,
  chatgptPlugin,
  claudePlugin,
  codexLogin,
  mirror,
  partHome,
  piLogin,
  preparedHome,
  removeAccountHome,
  resetAccountCaches,
  setModelSource,
} from "./accounts";
import { loginOf, signInFor } from "./authError";
import { credentialAction, launchFor, listCredentials, register, unregister } from "./registry";
import { cancelAllFlows, findDeviceCode, findUrl, outputTail, startRelay, stripAnsi, submitCode } from "./signin";
import { accountsDir } from "./store";

const bin = join(tmpdir(), `tether-acct-bin-${process.pid}`);
const TOKEN = "eyJhbGciOiJub25lIn0.SECRET-ACCESS-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789";

function script(name: string, body: string): string {
  mkdirSync(bin, { recursive: true });
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const jwt = (claims: object) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

function codexAuth(home: string, email: string, plan = "pro", access = TOKEN) {
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      tokens: {
        id_token: jwt({
          email,
          "https://api.openai.com/auth": { chatgpt_plan_type: plan },
        }),
        access_token: access,
        account_id: "acct-" + email,
      },
    }),
  );
}

const saved = { ...process.env };

beforeEach(() => {
  resetHome();
  resetAccountCaches();
  unregister();
  config().exhausted = {};
  // Fake CLIs: nothing reaches a real login.
  process.env.CLAUDE_BIN = script(
    "claude",
    `if [ "$1 $2" = "auth status" ]; then
  if [ -f "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" ]; then echo '{"loggedIn":true,"email":"gavin@example.com","orgName":"Org","subscriptionType":"max"}'; else echo '{"loggedIn":false}'; fi
  exit 0
fi
exit 1`,
  );
  process.env.KIRO_BIN = join(bin, "no-kiro");
  process.env.AGY_BIN = join(bin, "no-agy");
  process.env.CODEX_BIN = join(bin, "no-codex");
  process.env.PI_BIN = join(bin, "no-pi");
  setModelSource(async (h) =>
    h === "claude-code"
      ? [{ id: "opus" }, { id: "sonnet" }]
      : h === "codex"
        ? [{ id: "default" }, { id: "gpt-6-luna" }]
        : [{ id: "openai-codex/gpt-6-luna" }, { id: "anthropic/x" }],
  );
});
afterEach(() => {
  cancelAllFlows();
  unregister();
  config().exhausted = {};
  for (const k of ["CLAUDE_BIN", "KIRO_BIN", "AGY_BIN", "CODEX_BIN", "PI_BIN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(() => setModelSource());

describe("account homes", () => {
  test("mirror links the machine's config except the login files; removal never follows a link", () => {
    const machine = join(userHome(), ".claude");
    mkdirSync(join(machine, "projects", "p"), { recursive: true });
    writeFileSync(join(machine, "projects", "p", "s.jsonl"), "{}\n");
    writeFileSync(join(machine, "settings.json"), "{}");
    writeFileSync(join(machine, ".credentials.json"), "MACHINE LOGIN");
    for (const n of ["daemon.lock", "daemon.status.json", "sessions"]) writeFileSync(join(machine, n), "machine's own");
    const dir = preparedHome("claude:work", "claude", true);
    for (const n of ["daemon.lock", "daemon.status.json", "sessions"]) expect(existsSync(join(dir, n))).toBe(false);
    expect(dir).toBe(join(accountsDir(), "claude:work", "claude"));
    expect(lstatSync(join(dir, "projects")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, "settings.json"))).toBe(join(machine, "settings.json"));
    expect(existsSync(join(dir, ".credentials.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"))).toEqual({ hasCompletedOnboarding: true });
    // a new entry on the machine shows up next time; the account's own files stay
    writeFileSync(join(machine, "CLAUDE.md"), "x");
    writeFileSync(join(dir, ".credentials.json"), "ACCOUNT LOGIN");
    mirror(machine, dir, /^\.credentials\.json$/);
    expect(lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir, ".credentials.json"), "utf8")).toBe("ACCOUNT LOGIN");
    removeAccountHome("claude:work");
    expect(existsSync(accountHome("claude:work"))).toBe(false);
    expect(readFileSync(join(machine, "projects", "p", "s.jsonl"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(machine, ".credentials.json"), "utf8")).toBe("MACHINE LOGIN");
  });

  test("a Codex home doesn't share the machine's daemon, locks or databases", () => {
    const machine = join(userHome(), ".codex");
    mkdirSync(join(machine, "sessions"), { recursive: true });
    for (const n of ["config.toml", "auth.json", "state_5.sqlite", "state_5.sqlite-wal", "logs_2.sqlite-shm", "app-server-daemon", "thread-writer-locks"])
      writeFileSync(join(machine, n), "x");
    const dir = preparedHome("chatgpt:work", "codex", true);
    expect(readdirSync(dir).sort()).toEqual(["config.toml", "sessions"]);
  });

  test("a signed-out account fails closed: nothing brings its home back", async () => {
    register(...accountPlugins);
    preparedHome("claude:gone", "claude", true);
    const r: any = await credentialAction("claude:gone", "signOut", {});
    expect(r.message).toMatch(/Signed out/);
    expect(existsSync(accountHome("claude:gone"))).toBe(false);
    await expect(launchFor(parseEntry("claude-code:opus#claude:gone", "claude-code"))).rejects.toThrow(/signed out/);
    expect(existsSync(accountHome("claude:gone"))).toBe(false);
  });

  test("only extra account ids have homes", () => {
    for (const id of ["claude:machine", "chatgpt:codex", "chatgpt:pi", "kiro:x", "claude:../x", "claude:a:b", "claude:"]) expect(() => accountHome(id)).toThrow();
    expect(accountHome("chatgpt:work")).toBe(join(accountsDir(), "chatgpt:work"));
  });

  test("adding an account under a machine login's name, or twice, is refused", async () => {
    register(...accountPlugins);
    await expect(credentialAction("claude", "add", { name: "machine" })).rejects.toThrow(/this machine's own login/);
    mkdirSync(accountHome("claude:work"), { recursive: true });
    await expect(credentialAction("claude", "add", { name: "Work" })).rejects.toThrow(/already an account/);
  });
});

describe("env per account", () => {
  test("an extra Claude account runs on its own home, the machine's token variables blanked; the machine login adds nothing", async () => {
    register(...accountPlugins);
    preparedHome("claude:work", "claude", true);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "machine-token";
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example";
    const l = await launchFor(parseEntry("claude-code:opus#claude:work", "claude-code"));
    expect(l.env).toEqual({
      CLAUDE_CONFIG_DIR: partHome("claude:work", "claude"),
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "",
    });
    expect((await launchFor(parseEntry("claude-code:opus#claude:machine", "claude-code"))).env).toEqual({});
    expect(claudePlugin.homeFor("claude:work", "claude-code")).toBe(partHome("claude:work", "claude"));
    expect(claudePlugin.homeFor("claude:machine", "claude-code")).toBeUndefined();
  });

  test("a ChatGPT account gives Codex its CODEX_HOME and pi its agent dir, only the one the entry needs", async () => {
    register(...accountPlugins);
    mkdirSync(accountHome("chatgpt:work"), { recursive: true });
    process.env.OPENAI_API_KEY = "machine-key";
    expect((await launchFor(parseEntry("codex:gpt-6-luna#chatgpt:work", "codex"))).env).toEqual({ CODEX_HOME: partHome("chatgpt:work", "codex"), OPENAI_API_KEY: "" });
    expect((await launchFor(parseEntry("pi:openai-codex/gpt-6-luna#chatgpt:work", "pi"))).env).toEqual({ PI_CODING_AGENT_DIR: partHome("chatgpt:work", "pi") });
    expect((await launchFor(parseEntry("codex:gpt-6-luna#chatgpt:codex", "codex"))).env).toEqual({});
    await expect(launchFor(parseEntry("claude-code:opus#chatgpt:work", "claude-code"))).rejects.toThrow(/runs Codex and pi/);
  });
});

describe("listing", () => {
  test("machine login and extra accounts, with account, plan, models on extras only, and no token anywhere", async () => {
    mkdirSync(join(userHome(), ".claude"), { recursive: true });
    writeFileSync(join(userHome(), ".claude", ".credentials.json"), TOKEN);
    preparedHome("claude:work", "claude", true);
    writeFileSync(join(partHome("claude:work", "claude"), ".credentials.json"), TOKEN);
    preparedHome("claude:spare", "claude", true);
    codexAuth(join(userHome(), ".codex"), "me@example.com");
    codexAuth(partHome("chatgpt:work", "codex"), "work@example.com", "plus");
    register(claudePlugin, chatgptPlugin);
    // usage: no network in tests
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as any;
    try {
      const list = await listCredentials();
      const by = Object.fromEntries(list.credentials.map((c) => [c.id, c]));
      expect(by["claude:machine"]).toMatchObject({
        label: "Max (gavin@)",
        source: "cli",
        state: "ok",
        actions: ["signOut"],
      });
      expect(by["claude:machine"]!.models).toBeUndefined();
      expect(by["claude:work"]).toMatchObject({
        label: "Max (gavin@)",
        source: "tether",
        state: "ok",
        account: "gavin@example.com · Org",
      });
      expect(by["claude:work"]!.models!.map((m) => m.id)).toEqual(["opus", "sonnet"]);
      expect(by["claude:spare"]).toMatchObject({
        state: "missing",
        actions: ["signIn"],
      });
      expect(by["chatgpt:codex"]).toMatchObject({
        label: "Pro (me@)",
        state: "ok",
      });
      expect(by["chatgpt:work"]).toMatchObject({
        label: "Plus (work@)",
        account: "work@example.com",
        actions: ["signInPi"],
      });
      expect(by["chatgpt:work"]!.models).toEqual([{ harness: "codex", id: "gpt-6-luna", credentialLabel: "Plus (work@)" }]);
      expect(JSON.stringify(list)).not.toContain("SECRET-ACCESS-TOKEN");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("login readers", () => {
    const pi = join(userHome(), "pi");
    mkdirSync(pi, { recursive: true });
    writeFileSync(
      join(pi, "auth.json"),
      JSON.stringify({
        "openai-codex": {
          access: jwt({
            "https://api.openai.com/profile": { email: "p@x.io" },
          }),
          refresh: "r",
        },
      }),
    );
    expect(piLogin(pi)).toMatchObject({ signedIn: true, email: "p@x.io" });
    expect(codexLogin(join(userHome(), "nothing")).signedIn).toBe(false);
    expect(accountLabel({ signedIn: true, email: "a@b.c", plan: "team_plus" }, "x")).toBe("Team Plus (a@)");
    expect(accountLabel({ signedIn: false }, "work")).toBe("work");
  });
});

describe("usage and quota per account", () => {
  test("an extra ChatGPT account's usage is read with its own login", async () => {
    codexAuth(join(userHome(), ".codex"), "me@example.com", "pro", "MACHINE-ACCESS");
    codexAuth(partHome("chatgpt:work", "codex"), "work@example.com", "plus", "WORK-ACCESS");
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: any) => {
      seen.push(init.headers.Authorization);
      return Response.json({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 100, limit_window_seconds: 18000 },
          limit_reached: true,
        },
      });
    }) as any;
    try {
      const u = await chatgptPlugin.usage!("chatgpt:work");
      expect(seen).toEqual(["Bearer WORK-ACCESS"]);
      expect(u).toMatchObject({
        limited: true,
        windows: [{ label: "5h", percent: 100 }],
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a limit on one account leaves the next account in the order usable", () => {
    const chain = ["claude-code:opus#claude:machine", "claude-code:opus#claude:work", "codex:gpt-6-luna"];
    markExhausted(quotaKey(parseEntry(chain[0]!, "claude-code")), Date.now() + 60_000);
    const pick = pickEntry(chain, "claude-code");
    expect("entry" in pick && pick.entry).toEqual({
      harness: "claude-code",
      model: "opus",
      credential: "claude:work",
    });
  });
});

describe("sign-in relay", () => {
  test("parsing: the OAuth link that shows a code, a device code, a tail without tokens", () => {
    const out = stripAnsi(
      "\x1b[2J\x1b[1mBrowser didn't open? Use the url below to sign in\x1b[0m\r\nhttps://claude.ai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback\r\nhttps://claude.ai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s\r\nPaste code here if prompted > ",
    );
    expect(findUrl(out, "paste")).toBe("https://claude.ai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s");
    const dev =
      "Follow these steps to sign in with ChatGPT using device code authorization:\n1. Open this link\n   https://auth.openai.com/codex/device\n2. Enter this one-time code (expires in 15 minutes)\n   KX4P-9QZTA\n";
    expect(findUrl(dev, "device")).toBe("https://auth.openai.com/codex/device");
    expect(findDeviceCode(dev)).toBe("KX4P-9QZTA");
    expect(outputTail(`token ${TOKEN}\nnext`)).not.toContain("SECRET");
  });

  test("Claude-style flow through a pseudo-terminal: link out, code in, login checked; the code isn't echoed", async () => {
    const home = join(userHome(), "acct");
    mkdirSync(home, { recursive: true });
    const cli = script(
      "fake-login",
      `printf 'If the browser didn'"'"'t open, visit:\\nhttps://claude.ai/oauth/authorize?redirect_uri=https%%3A%%2F%%2Fplatform.claude.com%%2Foauth%%2Fcode%%2Fcallback&state=x\\nPaste code here if prompted > '
read code
[ "$code" = "good-code#x" ] && echo ok > "$ACCT/.credentials.json" && echo "Login successful." && exit 0
echo "Invalid code"; exit 1`,
    );
    let ended: string | undefined;
    const flow = await startRelay({
      id: "claude:t",
      kind: "paste",
      argv: [cli],
      env: { ...process.env, ACCT: home },
      check: async () => existsSync(join(home, ".credentials.json")),
      onEnd: (f) => void (ended = f.state),
    });
    expect(flow.state).toBe("waiting");
    expect(flow.url).toContain("oauth/authorize");
    await submitCode("claude:t", "good-code#x");
    for (let i = 0; i < 50 && !ended; i++) await Bun.sleep(100);
    expect(ended).toBe("done");
    expect(readFileSync(join(home, ".credentials.json"), "utf8")).toBe("ok\n");
  });

  test("a device flow shows its code; cancelling a new account's sign-in removes its half-made home", async () => {
    register(...accountPlugins);
    process.env.CODEX_BIN = script(
      "codex",
      `[ "$1 $2" = "login --device-auth" ] || exit 2\nprintf '1. Open https://auth.openai.com/codex/device\\n2. Enter this one-time code\\n   ABCD-12345\\n'; sleep 30`,
    );
    const r: any = await credentialAction("chatgpt", "add", { name: "Spare" });
    expect(r).toMatchObject({
      url: "https://auth.openai.com/codex/device",
      code: "ABCD-12345",
      flow: { id: "chatgpt:spare", kind: "device", state: "waiting" },
    });
    expect(existsSync(partHome("chatgpt:spare", "codex"))).toBe(true);
    await credentialAction("chatgpt:spare", "signInCancel", {});
    for (let i = 0; i < 20 && existsSync(accountHome("chatgpt:spare")); i++) await Bun.sleep(50);
    expect(existsSync(accountHome("chatgpt:spare"))).toBe(false);
  });

  test("retrying a new account's sign-in keeps the home it just prepared (Add twice, then Sign in on the row)", async () => {
    register(...accountPlugins);
    process.env.CODEX_BIN = script("codex", `printf 'Open https://auth.openai.com/codex/device\\nEnter this one-time code\\n   ABCD-12345\\n'; sleep 30`);
    await credentialAction("chatgpt", "add", { name: "retry" });
    const again: any = await credentialAction("chatgpt", "add", { name: "retry" });
    expect(again.flow.state).toBe("waiting");
    await Bun.sleep(200);
    expect(existsSync(partHome("chatgpt:retry", "codex"))).toBe(true);
    await credentialAction("chatgpt:retry", "signIn", {});
    await Bun.sleep(200);
    expect(existsSync(partHome("chatgpt:retry", "codex"))).toBe(true);
    // Claude's add path too
    process.env.CLAUDE_BIN = script("claude-login", `printf 'visit https://claude.ai/oauth/authorize?x=1\\nPaste code here > '; sleep 30`);
    await credentialAction("claude", "add", { name: "retry" });
    await credentialAction("claude", "add", { name: "retry" });
    await Bun.sleep(200);
    expect(existsSync(partHome("claude:retry", "claude"))).toBe(true);
  });

  test("a machine login is never signed out from the browser: the command to run is shown instead", async () => {
    register(...accountPlugins);
    const marker = join(userHome(), "logged-out");
    process.env.CODEX_BIN = script("codex", `[ "$1" = "logout" ] && touch "${marker}"; exit 0`);
    codexAuth(join(userHome(), ".codex"), "me@example.com");
    const r: any = await credentialAction("chatgpt:codex", "signOut", {});
    expect(r.flow).toMatchObject({ kind: "command", state: "waiting", command: `${process.env.CODEX_BIN} logout` });
    await Bun.sleep(300);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(userHome(), ".codex", "auth.json"))).toBe(true);
    for (const id of ["claude:machine", "kiro:machine", "chatgpt:pi"]) expect(((await credentialAction(id, "signOut", {})) as any).flow.kind).toBe("command");
  });

  test("the output shown never carries secrets: key=value, JSON fields, bearer, the pasted code", () => {
    const out = outputTail(`error: access_token=abc123 "refresh_token": "r-xyz" code=4/0Abc\nAuthorization: Bearer sk-live\npasted: MY-PASTED-CODE`, 12, ["MY-PASTED-CODE"]);
    for (const s of ["abc123", "r-xyz", "4/0Abc", "sk-live", "MY-PASTED-CODE"]) expect(out).not.toContain(s);
  });
});

describe("expired access tokens", () => {
  test("a Codex login with a refresh token whose usage call is refused reads as unknown, not expired", async () => {
    codexAuth(partHome("chatgpt:work", "codex"), "work@example.com");
    const auth = JSON.parse(readFileSync(join(partHome("chatgpt:work", "codex"), "auth.json"), "utf8"));
    auth.tokens.refresh_token = "r";
    writeFileSync(join(partHome("chatgpt:work", "codex"), "auth.json"), JSON.stringify(auth));
    register(chatgptPlugin);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("no", { status: 401 })) as any;
    try {
      const list = await listCredentials();
      expect(list.credentials.find((c) => c.id === "chatgpt:work")).toMatchObject({ state: "unknown" });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("auth errors", () => {
  test("point at the login the session runs on", () => {
    expect(signInFor(parseEntry("claude-code:opus", "claude-code"), "authentication_failed: OAuth token has expired")).toEqual({
      credential: "claude:machine",
      provider: "Claude",
    });
    expect(signInFor(parseEntry("claude-code:opus#claude:work", "claude-code"), "Invalid API key · Please run /login")).toEqual({ credential: "claude:work", provider: "Claude" });
    expect(signInFor(parseEntry("pi:openai-codex/gpt-6-luna", "pi"), "401 Unauthorized")).toEqual({ credential: "chatgpt:pi", provider: "ChatGPT" });
    expect(signInFor(parseEntry("codex:gpt-6-luna#azure:east", "codex"), "401 Unauthorized")).toBeUndefined();
    expect(signInFor(parseEntry("claude-code:opus", "claude-code"), "You've hit your usage limit")).toBeUndefined();
    expect(loginOf(parseEntry("pi:anthropic/claude", "pi"))).toBeUndefined();
  });
});
