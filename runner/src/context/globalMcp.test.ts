// Global tether-context registration in config files shared with the harness (~/.claude.json,
// opencode.json(c)), the per-session pi config, and undoing it all — in a scratch home.

import "./testenv";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";
import { CONFIG_DIR, config } from "../config";
import { put, seedHome } from "./fixtures";
import { exportAll } from "./export";
import { editJson, lockConfig, registerGlobalMcp, unregisterGlobalMcp, writeConfigAtomic } from "./globalMcp";
import { ContextService } from "./index";
import { piMcpConfig, sessionContext, setInjectionEnabled } from "./inject";
import { MCP_SCRIPT } from "./launch";
import { handle } from "./mcp";
import { harness } from "./paths";
import { inboxEntries } from "./sources";
import { Store } from "./store";

if (!CONFIG_DIR.startsWith(tmpdir())) throw new Error(`refusing to run: runner config dir ${CONFIG_DIR} is not a temp dir`);
if (!harness.claudeJson().startsWith(tmpdir())) throw new Error("refusing to run: ~/.claude.json is not in a temp home");

// Shaped like a real ~/.claude.json: lots of state Claude owns, project-scoped mcpServers too.
const CLAUDE_JSON = `{
  "numStartups": 412,
  "installMethod": "native",
  "autoUpdates": false,
  "tipsHistory": {
    "new-user-warmup": 7,
    "memory-command": 22
  },
  "projects": {
    "/home/u/proj": {
      "allowedTools": [],
      "mcpServers": {
        "proj-only": { "command": "x" }
      },
      "hasTrustDialogAccepted": true
    }
  },
  "oauthAccount": {
    "emailAddress": "someone@example.com"
  },
  "userID": "abc123"
}
`;

const OPENCODE_JSONC = `{
  // my opencode setup
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight", /* inline */
  "mcp": {
    // the docs server
    "docs": { "type": "remote", "url": "https://example.com/mcp" },
  },
}
`;

beforeEach(() => {
  seedHome();
  config().context = undefined;
  setInjectionEnabled(false);
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe("~/.claude.json", () => {
  test("adds only the user-scope entry, keeps every other byte and the file mode, and undoes exactly", () => {
    writeFileSync(harness.claudeJson(), CLAUDE_JSON, { mode: 0o600 });
    const seen: string[] = [];
    // The snapshot hook runs before the write, with the original still in place.
    const r = registerGlobalMcp({ before: (p) => seen.push(readFileSync(p, "utf8")) });
    expect(seen).toEqual([CLAUDE_JSON]);
    expect(r.written).toEqual([harness.claudeJson()]);
    const text = readFileSync(harness.claudeJson(), "utf8");
    const cfg = JSON.parse(text);
    expect(cfg.mcpServers["tether-context"]).toEqual({ type: "stdio", command: process.execPath, args: [MCP_SCRIPT], env: { TETHER_CONTEXT_DIR: join(harness.claudeDir(), "..", ".config", "tether", "context") } });
    expect(cfg.projects["/home/u/proj"].mcpServers).toEqual({ "proj-only": { command: "x" } }); // project scope untouched
    // Byte for byte outside the inserted key.
    expect(text.startsWith(CLAUDE_JSON.trimEnd().slice(0, -2))).toBe(true);
    expect(statSync(harness.claudeJson()).mode & 0o777).toBe(0o600);
    expect(existsSync(`${harness.claudeJson()}.tether-backup`)).toBe(false);
    // Idempotent.
    expect(registerGlobalMcp().written).toEqual([]);
    // Undo: the file reads exactly as before.
    expect(unregisterGlobalMcp().written).toEqual([harness.claudeJson()]);
    expect(readFileSync(harness.claudeJson(), "utf8")).toBe(CLAUDE_JSON);
  });

  test("keeps the user's other servers; never replaces their own tether-context entry", () => {
    writeFileSync(harness.claudeJson(), `{"mcpServers":{"gh":{"command":"gh-mcp"}},"userID":"u"}`);
    registerGlobalMcp();
    const cfg = JSON.parse(readFileSync(harness.claudeJson(), "utf8"));
    expect(Object.keys(cfg.mcpServers)).toEqual(["gh", "tether-context"]);
    unregisterGlobalMcp();
    expect(JSON.parse(readFileSync(harness.claudeJson(), "utf8"))).toEqual({ mcpServers: { gh: { command: "gh-mcp" } }, userID: "u" });

    const own = `{"mcpServers":{"tether-context":{"command":"my-own"}}}`;
    writeFileSync(harness.claudeJson(), own);
    registerGlobalMcp();
    unregisterGlobalMcp();
    expect(readFileSync(harness.claudeJson(), "utf8")).toBe(own);
  });

  test("broken JSON is left alone with a warning; dry runs write nothing; not installed means no file", () => {
    writeFileSync(harness.claudeJson(), `{"a": 1,}`);
    const r = registerGlobalMcp();
    expect(r.warnings[0]).toContain("couldn't be parsed");
    expect(readFileSync(harness.claudeJson(), "utf8")).toBe(`{"a": 1,}`);

    writeFileSync(harness.claudeJson(), CLAUDE_JSON);
    expect(registerGlobalMcp({ dryRun: true }).written).toEqual([harness.claudeJson()]);
    expect(readFileSync(harness.claudeJson(), "utf8")).toBe(CLAUDE_JSON);

    seedHome();
    Bun.spawnSync(["rm", "-rf", harness.claudeDir()]);
    registerGlobalMcp();
    expect(existsSync(harness.claudeJson())).toBe(false);
  });

  test("a write that lands between our read and our rename is never overwritten", () => {
    writeFileSync(harness.claudeJson(), CLAUDE_JSON, { mode: 0o600 });
    const claudes = CLAUDE_JSON.replace(`"numStartups": 412`, `"numStartups": 413`);
    let raced = false;
    const ok = writeConfigAtomic(harness.claudeJson(), "{}", () => {
      // Claude writes its own change just before our rename.
      if (!raced) writeFileSync(harness.claudeJson(), claudes);
      raced = true;
      return readFileSync(harness.claudeJson(), "utf8") === CLAUDE_JSON;
    });
    expect(ok).toBe(false);
    expect(readFileSync(harness.claudeJson(), "utf8")).toBe(claudes);
    expect(readdirSync(dirname(harness.claudeJson())).filter((f) => f.includes("tether-tmp"))).toEqual([]);
    // The whole update redoes the edit on Claude's text: both changes end up in the file.
    registerGlobalMcp();
    const cfg = JSON.parse(readFileSync(harness.claudeJson(), "utf8"));
    expect(cfg.numStartups).toBe(413);
    expect(cfg.mcpServers["tether-context"]).toBeDefined();
  });

  test("waits for Claude's own lock; a busy lock means no write and a warning", () => {
    writeFileSync(harness.claudeJson(), CLAUDE_JSON);
    const lock = `${harness.claudeJson()}.lock`;
    mkdirSync(lock);
    try {
      const r = registerGlobalMcp();
      expect(r.written).toEqual([]);
      expect(r.warnings[0]).toContain("kept changing");
      expect(readFileSync(harness.claudeJson(), "utf8")).toBe(CLAUDE_JSON);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
    // A stale lock (a crashed writer, >10s old) is taken over, as proper-lockfile does.
    mkdirSync(lock);
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(registerGlobalMcp().written).toEqual([harness.claudeJson()]);
    expect(existsSync(lock)).toBe(false);
    // Released after our write.
    const release = lockConfig(harness.claudeJson())!;
    expect(existsSync(lock)).toBe(true);
    release();
    expect(existsSync(lock)).toBe(false);
  }, 30_000);

  test("a symlinked ~/.claude.json stays a symlink; the real file is edited", () => {
    const real = join(process.env.HOME!, "dotfiles-claude.json");
    writeFileSync(real, CLAUDE_JSON);
    rmSync(harness.claudeJson(), { force: true });
    symlinkSync(real, harness.claudeJson());
    registerGlobalMcp();
    expect(lstatSync(harness.claudeJson()).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain("tether-context");
    unregisterGlobalMcp();
    expect(readFileSync(real, "utf8")).toBe(CLAUDE_JSON);
    rmSync(harness.claudeJson(), { force: true });
  });

  test("CLAUDE_CONFIG_DIR moves the file", () => {
    const dir = join(process.env.HOME!, "alt-claude");
    mkdirSync(dir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = dir;
    writeFileSync(join(dir, ".claude.json"), "{}\n");
    registerGlobalMcp();
    expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8")).mcpServers["tether-context"]).toBeDefined();
  });
});

describe("opencode", () => {
  test("JSONC: comments and trailing commas survive; undo restores the text", () => {
    const p = join(harness.opencodeDir(), "opencode.jsonc");
    put(p, OPENCODE_JSONC);
    expect(registerGlobalMcp().mcpConfigs).toContain(p);
    const text = readFileSync(p, "utf8");
    expect(text).toContain("// my opencode setup");
    expect(text).toContain("/* inline */");
    expect(text).toContain("// the docs server");
    const cfg = parse(text, [], { allowTrailingComma: true });
    expect(cfg.mcp.docs.type).toBe("remote");
    expect(cfg.mcp["tether-context"]).toEqual({ type: "local", command: [process.execPath, MCP_SCRIPT], environment: expect.any(Object), enabled: true });
    unregisterGlobalMcp();
    const back = readFileSync(p, "utf8");
    expect(parse(back, [], { allowTrailingComma: true })).toEqual(parse(OPENCODE_JSONC, [], { allowTrailingComma: true }));
    expect(back).toContain("// the docs server");
  });

  test("no config yet: creates opencode.json; undo leaves an empty object", () => {
    mkdirSync(harness.opencodeDir(), { recursive: true });
    registerGlobalMcp();
    const p = join(harness.opencodeDir(), "opencode.json");
    expect(Object.keys(JSON.parse(readFileSync(p, "utf8")).mcp)).toEqual(["tether-context"]);
    unregisterGlobalMcp();
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({});
  });
});

describe("service: only the user's import writes them; disabling undoes", () => {
  test("import registers; background exports don't; disable removes every registration", async () => {
    writeFileSync(harness.claudeJson(), CLAUDE_JSON, { mode: 0o600 });
    put(join(harness.opencodeDir(), "opencode.jsonc"), OPENCODE_JSONC);
    put(harness.codexConfig(), 'model = "gpt"\n');
    // Antigravity installed, its newer config dir (~/.gemini/config) not there yet.
    mkdirSync(harness.agyDir(), { recursive: true });

    // Preview (dry run) lists them, writes nothing.
    const s = new ContextService({ decider: async () => ({ action: "new" }) });
    const p = await s.preview();
    expect(p.mcpConfigs).toEqual(expect.arrayContaining(["~/.claude.json", "~/.config/opencode/opencode.jsonc"]));
    expect(readFileSync(harness.claudeJson(), "utf8")).toBe(CLAUDE_JSON);

    // A background export (watcher-driven) never touches them.
    const store = new Store(join(process.env.TETHER_CONFIG_DIR!, "context"));
    await store.init();
    await exportAll(store);
    expect(readFileSync(harness.claudeJson(), "utf8")).toBe(CLAUDE_JSON);

    await s.runImport();
    await s.idle();
    expect(readFileSync(harness.claudeJson(), "utf8")).toContain("tether-context");
    expect(readFileSync(join(harness.opencodeDir(), "opencode.jsonc"), "utf8")).toContain("tether-context");
    expect(readFileSync(harness.codexConfig(), "utf8")).toContain("[mcp_servers.tether-context]");
    expect(readFileSync(harness.piMcp(), "utf8")).toContain("tether-context");
    expect(readFileSync(harness.agyMcp(), "utf8")).toContain("tether-context");

    const st = await s.disable();
    expect(st.enabled).toBe(false);
    // What was undone, for the page to show.
    expect(st.turnedOff.files).toEqual(expect.arrayContaining(["~/.claude.json", "~/.config/opencode/opencode.jsonc", "~/.codex/config.toml", "~/.pi/agent/mcp.json"]));
    expect(st.turnedOff.warnings).toEqual([]);
    expect(config().context?.enabled).toBe(false);
    expect(await sessionContext(process.env.HOME!)).toBeUndefined();
    expect(readFileSync(harness.claudeJson(), "utf8")).toBe(CLAUDE_JSON);
    expect(readFileSync(join(harness.opencodeDir(), "opencode.jsonc"), "utf8")).not.toContain("tether-context");
    expect(readFileSync(harness.codexConfig(), "utf8")).toBe('model = "gpt"\n');
    // Files the import created are gone again.
    expect(existsSync(harness.piMcp())).toBe(false);
    expect(existsSync(harness.agyMcp())).toBe(false);
    expect(existsSync(`${harness.claudeJson()}.lock`)).toBe(false);
    s.stop();
  });
});

describe("per-session MCP", () => {
  test("pi: a --mcp-config with the user's adapter servers plus this session's tether-context", async () => {
    await new Store(join(process.env.TETHER_CONFIG_DIR!, "context")).init();
    setInjectionEnabled(true);
    const ctx = await sessionContext(process.env.HOME!, { key: "gk1" });
    expect(ctx).toBeDefined();
    expect(piMcpConfig(ctx, "gk1")).toBeUndefined(); // pi-mcp-adapter not installed
    put(harness.piSettings(), JSON.stringify({ packages: ["npm:pi-subagents", "npm:pi-mcp-adapter"] }));
    put(harness.piMcpAdapter(), `{ "mcpServers": { "gh": { "command": "gh-mcp" } }, "settings": { "toolPrefix": "short" }, }`);
    const p = piMcpConfig(ctx, "gk1")!;
    expect(p.startsWith(process.env.TETHER_CONFIG_DIR!)).toBe(true);
    const cfg = JSON.parse(readFileSync(p, "utf8"));
    expect(cfg.settings).toEqual({ toolPrefix: "short" });
    expect(Object.keys(cfg.mcpServers)).toEqual(["gh", "tether-context"]);
    expect(cfg.mcpServers["tether-context"].env.TETHER_SESSION_KEY).toBe("gk1");
    // The user's own file is untouched.
    expect(readFileSync(harness.piMcpAdapter(), "utf8")).toContain("toolPrefix");
  });

  test("memory_write falls back to the guard key from the harness's environment", async () => {
    await new Store(join(process.env.TETHER_CONFIG_DIR!, "context")).init();
    const saved = { s: process.env.TETHER_SESSION_KEY, g: process.env.TETHER_GUARD_KEY };
    delete process.env.TETHER_SESSION_KEY;
    process.env.TETHER_GUARD_KEY = "agy-key";
    try {
      await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_write", arguments: { text: "Agy note." } } });
      const [e] = inboxEntries(join(process.env.TETHER_CONFIG_DIR!, "context", "inbox"));
      expect(e!.sessionKey).toBe("agy-key");
    } finally {
      if (saved.s === undefined) delete process.env.TETHER_SESSION_KEY;
      else process.env.TETHER_SESSION_KEY = saved.s;
      if (saved.g === undefined) delete process.env.TETHER_GUARD_KEY;
      else process.env.TETHER_GUARD_KEY = saved.g;
    }
  });
});

test("editJson: set and remove on empty and populated text", () => {
  expect(JSON.parse(editJson("", ["a"], 1))).toEqual({ a: 1 });
  expect(editJson("", ["a"], undefined)).toBe("");
  expect(editJson(`{\n\t"x": 1\n}`, ["y"], 2)).toBe(`{\n\t"x": 1,\n\t"y": 2\n}`);
});
