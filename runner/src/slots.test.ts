// The commands, agents and env slots (commands.ts, subagents.ts, secrets.ts and their connector
// entries): the secrets store and `${NAME}` resolution at launch, the command library (import from
// every harness, argument filling, native vs filled in, the `/` menu, a live session), the subagent
// library (import, each harness's format, pi's folder), and the capability matrix. Everything reads
// and writes the scratch HOME (testenv.ts).

import { HOME, resetHome } from "./testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpTransport } from "../../web/src/shared/protocol";
import {
  addLibraryCommand,
  commandLib,
  commandsFile,
  expandCommand,
  importCommands,
  listLibraryCommands,
  offlineNativeCommands,
  opencodeCommands,
  piPromptTemplates,
  setLibraryCommand,
  shellCompatible,
  opencodeCompatible,
  splitArgs,
} from "./commands";
import { capabilityMatrix } from "./connectors";
import { withOpencodeConfig } from "./connectors/acp";
import { launchWith, processLaunch } from "./connectors/launch";
import { SLOTS } from "./connectors/types";
import { harness } from "./context/paths";
import { exportRegistry } from "./mcp/export";
import { sessionServers } from "./mcp/registry";
import { load, mutate, resetCache } from "./mcp/store";
import { agentEnv, listSecrets, resetSecretsCache, resolveRefs, secretEnv, secretsFile, setSecret, withSecrets } from "./secrets";
import { LiveSession } from "./session";
import { resolveForBrief, slashMenu } from "./skillcmd";
import {
  addSubagent,
  agentLib,
  claudeAgentDefs,
  codexAgentConfig,
  importSubagents,
  listSubagents,
  opencodeAgentConfig,
  piTetherAgentsDir,
  setSubagent,
  syncPiAgents,
} from "./subagents";

const put = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const read = (p: string) => readFileSync(p, "utf8");
let proj: string;

beforeEach(() => {
  resetHome();
  resetSecretsCache();
  resetCache();
  commandLib.reset();
  agentLib.reset();
  proj = join(HOME, "proj");
  mkdirSync(join(proj, ".git"), { recursive: true });
});

// ---------------- secrets ----------------

describe("secrets", () => {
  test("set, list (names only), remove; the file is mode 600", async () => {
    expect(await setSecret("GITHUB_TOKEN", { value: "ghp_1" })).toEqual([{ name: "GITHUB_TOKEN", updatedAt: expect.any(Number) }]);
    await setSecret("API_KEY", { value: "k" });
    expect(listSecrets().map((s) => s.name)).toEqual(["API_KEY", "GITHUB_TOKEN"]);
    expect(JSON.stringify(listSecrets())).not.toContain("ghp_1");
    expect(statSync(secretsFile()).mode & 0o777).toBe(0o600);
    expect(secretEnv()).toEqual({ API_KEY: "k", GITHUB_TOKEN: "ghp_1" });
    await setSecret("API_KEY", { remove: true });
    expect(secretEnv()).toEqual({ GITHUB_TOKEN: "ghp_1" });
  });

  test("bad and reserved names are refused", async () => {
    await expect(setSecret("1ABC", { value: "x" })).rejects.toThrow(/name/);
    await expect(setSecret("A-B", { value: "x" })).rejects.toThrow(/name/);
    await expect(setSecret("PATH", { value: "x" })).rejects.toThrow(/can't be set/);
    await expect(setSecret("TETHER_GUARD_KEY", { value: "x" })).rejects.toThrow(/can't be set/);
    await expect(setSecret("OK", {})).rejects.toThrow(/value/);
  });

  test("agentEnv: secrets over the runner's env, Tether's own over secrets", async () => {
    await setSecret("FOO", { value: "secret" });
    process.env.FOO = "runner";
    try {
      expect(agentEnv().FOO).toBe("secret");
      expect(agentEnv({ FOO: "tether" }).FOO).toBe("tether");
    } finally {
      delete process.env.FOO;
    }
  });

  test("${NAME} and ${NAME:-default}; unknown names stay as written", () => {
    const env = { TOKEN: "t0k" };
    expect(resolveRefs("Bearer ${TOKEN}", env)).toBe("Bearer t0k");
    expect(resolveRefs("${MISSING:-dflt}/${TOKEN:-x}", env)).toBe("${MISSING:-dflt}/t0k");
    expect(resolveRefs("$TOKEN ${OTHER}", env)).toBe("$TOKEN ${OTHER}");
  });

  test("a name that isn't a secret keeps its default as written, for the harness to expand from its env", () => {
    process.env.MY_TOKEN = "fromenv";
    try {
      expect(resolveRefs("Bearer ${MY_TOKEN:-none} ${HOME:-/nohome}", { OTHER: "x" })).toBe("Bearer ${MY_TOKEN:-none} ${HOME:-/nohome}");
      const http: McpTransport = { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ${MY_TOKEN:-}" } };
      expect(withSecrets(http, { OTHER: "x" })).toEqual(http);
    } finally {
      delete process.env.MY_TOKEN;
    }
  });

  test("withSecrets: stdio env gets every secret under its own, headers resolve", () => {
    const env = { TOKEN: "t0k", OTHER: "o" };
    const stdio: McpTransport = { type: "stdio", command: "x", args: ["${TOKEN}"], env: { GITHUB_TOKEN: "${TOKEN}", OTHER: "mine" } };
    expect(withSecrets(stdio, env)).toEqual({ type: "stdio", command: "x", args: ["${TOKEN}"], env: { TOKEN: "t0k", OTHER: "mine", GITHUB_TOKEN: "t0k" } });
    const http: McpTransport = { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ${TOKEN}" } };
    expect(withSecrets(http, env)).toEqual({ ...http, headers: { Authorization: "Bearer t0k" } });
    expect(withSecrets(http, {})).toBe(http);
  });

  test("registry servers: resolved at launch only; the registry and the global export keep ${NAME}", async () => {
    await setSecret("GH", { value: "ghp_real" });
    mkdirSync(harness.codexDir(), { recursive: true });
    await mutate((d) => {
      d.servers = [
        { id: "a", name: "github", transport: { type: "stdio", command: "gh-mcp", args: [], env: { GITHUB_TOKEN: "${GH}" } }, scope: "global", enabled: true, trusted: false, sources: ["you"], addedAt: 1 },
        { id: "b", name: "api", transport: { type: "http", url: "https://api.example.com/mcp", headers: { "X-Key": "${GH}" } }, scope: "global", enabled: true, trusted: false, sources: ["you"], addedAt: 1 },
      ];
      exportRegistry(d.servers);
    });
    expect(read(harness.codexConfig())).toContain("${GH}");
    expect(read(harness.codexConfig())).not.toContain("ghp_real");
    expect(JSON.stringify(load())).not.toContain("ghp_real");
    // Codex has Tether's export (with ${GH}) already: the session still gets a resolved copy under that name.
    const servers = await sessionServers("codex", proj);
    const gh = servers.find((s) => s.name === "github")!.transport as any;
    expect(gh.env).toEqual({ GH: "ghp_real", GITHUB_TOKEN: "ghp_real" });
    expect((servers.find((s) => s.name === "api")!.transport as any).headers).toEqual({ "X-Key": "ghp_real" });
  });

  test("Codex filters its servers' env: an exported stdio server is injected again with your secrets once you have any", async () => {
    mkdirSync(harness.codexDir(), { recursive: true });
    await mutate((d) => {
      d.servers = [{ id: "a", name: "plain", transport: { type: "stdio", command: "plain-mcp", args: [], env: {} }, scope: "global", enabled: true, trusted: false, sources: ["you"], addedAt: 1 }];
      exportRegistry(d.servers);
    });
    expect(read(harness.codexConfig())).toContain("plain-mcp");
    expect(await sessionServers("codex", proj)).toEqual([]);
    await setSecret("GH", { value: "ghp_real" });
    const servers = await sessionServers("codex", proj);
    expect(servers.map((s) => s.name)).toEqual(["plain"]);
    expect((servers[0]!.transport as any).env).toEqual({ GH: "ghp_real" });
  });

  test("the env slot: Claude's SDK env (whole environment), the others' env", async () => {
    expect(launchWith("claude-code", { projectPath: proj }).options.env).toBeUndefined();
    await setSecret("FOO", { value: "bar" });
    const claude = launchWith("claude-code", { projectPath: proj }).options.env;
    expect(claude.FOO).toBe("bar");
    expect(claude.PATH).toBe(process.env.PATH);
    for (const h of ["codex", "pi", "opencode", "kiro", "antigravity"] as const) expect(launchWith(h, { projectPath: proj }).env.FOO).toBe("bar");
    expect(processLaunch("kiro", proj).env).toEqual({ FOO: "bar" });
  });
});

// ---------------- commands ----------------

function seedCommands() {
  put(join(HOME, ".claude/commands/fix-issue.md"), "---\ndescription: Fix a GitHub issue\nargument-hint: [issue] [priority]\nmodel: sonnet\n---\n\nFix issue #$0 with priority $1. ($ARGUMENTS)\n");
  put(join(HOME, ".claude/commands/git/commit.md"), "Write a commit message for the staged diff.\n");
  put(join(HOME, ".codex/prompts/draft.md"), "---\ndescription: Draft a PR\n---\nDraft a PR for $1 about $ARGUMENTS\n");
  put(join(HOME, ".config/opencode/command/test.md"), "---\ndescription: Run tests\n---\nRun the tests in $1 and fix failures.\n");
  put(join(HOME, ".config/opencode/opencode.jsonc"), `{ // mine\n "command": { "lint": { "template": "Lint $ARGUMENTS", "description": "Lint" } } }`);
  put(join(HOME, ".pi/agent/prompts/review.md"), "---\ndescription: Review\n---\nReview ${1:-everything}, then ${@:2}.\n");
}

describe("commands: import", () => {
  test("every harness's command files, read only, with their argument rules", async () => {
    seedCommands();
    const before = read(join(HOME, ".claude/commands/fix-issue.md"));
    const r = await importCommands();
    expect(r.added.sort()).toEqual(["commit", "draft", "fix-issue", "lint", "review", "test"]);
    const by = Object.fromEntries(r.commands.map((c) => [c.name, c]));
    expect(by["fix-issue"]).toMatchObject({ description: "Fix a GitHub issue", argumentHint: "[issue] [priority]", style: "claude", sources: ["claude:~/.claude/commands/fix-issue.md"] });
    expect(by.commit!.description).toBe("Write a commit message for the staged diff.");
    expect(by.draft!.style).toBe("shell");
    expect(by.lint!.sources).toEqual(["opencode:~/.config/opencode/opencode.jsonc"]);
    expect(by.review!.style).toBe("shell");
    expect(read(join(HOME, ".claude/commands/fix-issue.md"))).toBe(before);
    expect(statSync(commandsFile()).mode & 0o777).toBe(0o600);
    // Again: nothing new.
    expect((await importCommands()).added).toEqual([]);
  });

  test("same name elsewhere: same text adds the source, other text is a warning", async () => {
    put(join(HOME, ".claude/commands/x.md"), "Do X.\n");
    put(join(HOME, ".codex/prompts/x.md"), "Do X.\n");
    put(join(HOME, ".pi/agent/prompts/x.md"), "Do something else.\n");
    const r = await importCommands();
    expect(r.commands.find((c) => c.name === "x")!.sources).toEqual(["claude:~/.claude/commands/x.md", "codex:~/.codex/prompts/x.md"]);
    expect(r.warnings.join()).toContain("x (pi:~/.pi/agent/prompts/x.md) differs");
  });

  test("a deleted import isn't brought back; adding it by hand is", async () => {
    put(join(HOME, ".claude/commands/x.md"), "Do X.\n");
    await importCommands();
    const id = listLibraryCommands()[0]!.id;
    await setLibraryCommand(id, { enabled: false });
    expect(listLibraryCommands()[0]!.enabled).toBe(false);
    await setLibraryCommand(id, { remove: true });
    expect((await importCommands()).added).toEqual([]);
    await addLibraryCommand("x", "Do X now.");
    expect(listLibraryCommands()[0]).toMatchObject({ name: "x", body: "Do X now.", sources: ["you"] });
  });

  test("adding by hand: name checks, front matter, a style worked out from the text, edits replace", async () => {
    await expect(addLibraryCommand("bad name", "x")).rejects.toThrow(/name/);
    await expect(addLibraryCommand("empty", "---\ndescription: d\n---\n")).rejects.toThrow(/no text/);
    await addLibraryCommand("/deploy", "---\ndescription: Deploy it\n---\nDeploy $1 to ${2:-staging}");
    expect(listLibraryCommands()[0]).toMatchObject({ name: "deploy", description: "Deploy it", style: "shell" });
    await addLibraryCommand("deploy", "Deploy $ARGUMENTS");
    expect(listLibraryCommands()).toHaveLength(1);
    expect(listLibraryCommands()[0]).toMatchObject({ body: "Deploy $ARGUMENTS", style: "claude" });
    // Same text, new description and no argument hint: the paste still wins.
    await addLibraryCommand("deploy", "---\ndescription: Ship\nargument-hint: <env>\n---\nDeploy $ARGUMENTS");
    expect(listLibraryCommands()[0]).toMatchObject({ description: "Ship", argumentHint: "<env>" });
    await addLibraryCommand("deploy", "---\ndescription: Ship\n---\nDeploy $ARGUMENTS");
    expect(listLibraryCommands()[0]!.argumentHint).toBeUndefined();
  });
});

describe("commands: arguments", () => {
  test("splitArgs: quotes and escapes like a shell", () => {
    expect(splitArgs(`12 "high prio" 'a b' c\\ d ""`)).toEqual(["12", "high prio", "a b", "c d", ""]);
    expect(splitArgs("   ")).toEqual([]);
  });

  test("Claude Code's rules: $ARGUMENTS, $ARGUMENTS[N] and $N from 0, unused arguments appended", () => {
    const c = { style: "claude" as const, body: "Fix #$0 (prio $ARGUMENTS[1]); all: $ARGUMENTS; $2x stays" };
    expect(expandCommand(c, `42 "very high"`)).toBe(`Fix #42 (prio very high); all: 42 "very high"; $2x stays`);
    expect(expandCommand({ style: "claude", body: "Summarize the diff." }, "briefly")).toBe("Summarize the diff.\n\nARGUMENTS: briefly");
    expect(expandCommand({ style: "claude", body: "Summarize the diff." }, "")).toBe("Summarize the diff.");
  });

  test("the shell-like rules (pi, Codex, opencode): $1 first, $@, defaults, slices, $$", () => {
    const c = { style: "shell" as const, body: "A=$1 B=${2:-dflt} ALL=$@ REST=${@:2} TWO=${@:1:2} ANY=${@:-none} $$5" };
    expect(expandCommand(c, "x y z")).toBe("A=x B=y ALL=x y z REST=y z TWO=x y ANY=x y z $5");
    expect(expandCommand(c, "")).toBe("A= B=dflt ALL= REST= TWO= ANY=none $5");
  });

  test("shellCompatible: what pi and opencode fill the same way", () => {
    expect(shellCompatible({ style: "shell", body: "$1" })).toBe(true);
    expect(shellCompatible({ style: "claude", body: "Do $ARGUMENTS" })).toBe(true);
    expect(shellCompatible({ style: "claude", body: "Do $0" })).toBe(false);
    expect(shellCompatible({ style: "claude", body: "Do $ARGUMENTS[0]" })).toBe(false);
    expect(shellCompatible({ style: "claude", body: "No placeholders" })).toBe(false);
  });
});

describe("commands: per harness", () => {
  test("pi: compatible ones as --prompt-template files (not ones pi has itself)", async () => {
    put(join(HOME, ".pi/agent/prompts/mine.md"), "Mine $1\n");
    await addLibraryCommand("mine", "Mine $1");
    await addLibraryCommand("shout", "---\ndescription: Shout\nargument-hint: <text>\n---\nShout $ARGUMENTS");
    await addLibraryCommand("first", "First $0");
    const files = piPromptTemplates();
    expect(files.map((f) => f.split("/").pop())).toEqual(["shout.md"]);
    expect(read(files[0]!)).toBe(`---\ndescription: "Shout"\nargument-hint: "<text>"\n---\nShout $ARGUMENTS\n`);
    expect(statSync(files[0]!).mode & 0o777).toBe(0o600);
    expect(launchWith("pi", { projectPath: proj }).args).toEqual(["--prompt-template", files[0]!]);
    expect([...offlineNativeCommands("pi", proj)].sort()).toEqual(["mine", "shout"]);
  });

  test("opencodeCompatible: only $ARGUMENTS (or nothing); positional and shell forms are Tether's", () => {
    expect(opencodeCompatible({ style: "claude", body: "Do $ARGUMENTS" })).toBe(true);
    expect(opencodeCompatible({ style: "shell", body: "Do $ARGUMENTS" })).toBe(true);
    expect(opencodeCompatible({ style: "claude", body: "No placeholders" })).toBe(true);
    // opencode's highest $N takes the rest, pi's and Tether's take one argument.
    expect(opencodeCompatible({ style: "shell", body: "Deploy $1 to $2" })).toBe(false);
    expect(opencodeCompatible({ style: "claude", body: "Do $0" })).toBe(false);
    expect(opencodeCompatible({ style: "claude", body: "Do $ARGUMENTS[0]" })).toBe(false);
    for (const body of ["Do ${@:2} for $ARGUMENTS", "All $@", "Review ${1:-everything}", "Any ${@:-none}", "Cost $$5 $ARGUMENTS"]) expect(opencodeCompatible({ style: "shell", body })).toBe(false);
  });

  test("opencode: compatible ones in its inline config, under what's already there", async () => {
    put(join(HOME, ".config/opencode/command/own.md"), "Own\n");
    await addLibraryCommand("own", "Own $1");
    await addLibraryCommand("shout", "Shout $ARGUMENTS");
    await addLibraryCommand("rest", "Do ${@:2} for $1");
    expect(opencodeCommands()).toEqual({ shout: { template: "Shout $ARGUMENTS", description: "Shout $ARGUMENTS" } });
    const l = processLaunch("opencode", proj);
    expect(l.opencodeConfig).toEqual({ command: { shout: { template: "Shout $ARGUMENTS", description: "Shout $ARGUMENTS" } } });
    const base = JSON.stringify({ agent: { plan: { permission: { edit: "deny" } } } });
    const merged = JSON.parse(withOpencodeConfig(base, { agent: { plan: { prompt: "x" }, helper: { mode: "subagent" } }, command: { a: { template: "t" } } }));
    expect(merged).toEqual({ agent: { helper: { mode: "subagent" }, plan: { permission: { edit: "deny" } } }, command: { a: { template: "t" } } });
    expect(withOpencodeConfig("not json", { command: {} })).toBe("not json");
  });

  test("Claude Code: its own command files are native when it can't answer", () => {
    put(join(HOME, ".claude/commands/a.md"), "A");
    put(join(proj, ".claude/commands/sub/b.md"), "B");
    expect([...offlineNativeCommands("claude-code", proj)].sort()).toEqual(["a", "b"]);
    expect([...offlineNativeCommands("codex", proj)]).toEqual([]);
  });

  test("the / menu: your commands after skills, native where the harness lists them", async () => {
    await importCommands();
    await addLibraryCommand("fix", "Fix $ARGUMENTS");
    await addLibraryCommand("lint", "Lint");
    const lib = listLibraryCommands().map((c) => ({ ...c, id: c.id, addedAt: 0 })) as any;
    const menu = slashMenu([], [{ name: "lint", description: "harness lint" }, { name: "init" }], undefined, "opencode", proj, new Set(), lib);
    expect(menu.map((m) => [m.name, m.kind, m.native, m.sources])).toEqual([
      ["fix", "command", false, ["you"]],
      ["lint", "command", true, ["you"]],
      ["init", "command", undefined, undefined],
    ]);
  });

  test("a handoff brief fills the command in", async () => {
    await addLibraryCommand("fix", "Fix issue $0");
    expect(resolveForBrief("pi", proj, "/fix 12")).toBe("Fix issue 12");
    expect(resolveForBrief("pi", proj, "/unknown 12")).toBe("/unknown 12");
  });
});

describe("commands in a live session", () => {
  const sink = { emit: () => {}, summary: () => {}, handoff: async () => {} };
  const sessions: LiveSession[] = [];
  afterEach(() => sessions.splice(0).forEach((s) => s.close()));

  function fake(listed: string[]) {
    const log: string[] = [];
    class Fake extends LiveSession {
      async start() {}
      protected async send(text: string) {
        log.push(text);
        this.setState({ status: "running" });
      }
      async abort() {}
      async applyModel() {}
      async setThinking() {}
      async setPermissionMode() {}
      async rename() {}
      async listCommands() {
        return listed.map((name) => ({ name }));
      }
      async continueTurn() {}
      protected shutdown() {}
      protected async nativeSkills() {
        return [];
      }
    }
    const s = new Fake("codex", { nativeId: crypto.randomUUID(), projectPath: proj }, sink);
    s.t.state.status = "idle";
    sessions.push(s);
    return { s, log };
  }

  test("filled in when the harness doesn't have it, passed through when it does; a skill of the same name wins", async () => {
    await addLibraryCommand("fix", "Fix issue $0 now");
    await addLibraryCommand("own", "Own $ARGUMENTS");
    mkdirSync(join(proj, ".agents/skills/fix"), { recursive: true });
    const { s, log } = fake(["own"]);
    await s.prompt("/own 1");
    expect(log).toEqual(["/own 1"]);
    s.t.state.status = "idle";
    await s.prompt("/fix 7");
    expect(log[1]).toBe("Fix issue 7 now"); // no SKILL.md, so not a skill
    writeFileSync(join(proj, ".agents/skills/fix/SKILL.md"), "---\ndescription: fix skill\n---\nThe skill.\n");
    s.t.state.status = "idle";
    await s.prompt("/fix 7");
    expect(log[2]).toContain('<skill name="fix"');
  });

  test("the menu lists them with the harness's commands", async () => {
    await addLibraryCommand("fix", "Fix $ARGUMENTS");
    const { s } = fake(["own"]);
    const menu = await s.slashMenu();
    expect(menu.find((m) => m.name === "fix")).toMatchObject({ kind: "command", native: false, sources: ["you"] });
    expect(menu.find((m) => m.name === "own")).toMatchObject({ kind: "command" });
  });
});

// ---------------- subagents ----------------

function seedAgents() {
  put(join(HOME, ".claude/agents/reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep, Bash\nmodel: sonnet\n---\n\nYou review code.\n");
  put(join(HOME, ".codex/agents/explorer.toml"), `name = "explorer"\ndescription = "Explores"\ndeveloper_instructions = "Explore the repo."\n`);
  put(join(HOME, ".config/opencode/agent/docs.md"), "---\ndescription: Writes docs\nmode: subagent\nmodel: anthropic/claude-sonnet-5\n---\nWrite docs.\n");
  put(join(HOME, ".config/opencode/agent/main.md"), "---\ndescription: A primary agent\nmode: primary\n---\nBe the main agent.\n");
  put(join(HOME, ".config/opencode/opencode.json"), JSON.stringify({ agent: { tester: { description: "Tests", mode: "subagent", prompt: "Run tests." }, filed: { prompt: "{file:./x.md}" }, plan: { prompt: "p" } } }));
  put(join(HOME, ".pi/agent/agents/scout.md"), "---\nname: scout\ndescription: Recon\ntools: read, grep, find\n---\nScout the code.\n");
}

describe("subagents", () => {
  test("import from every harness (read only); opencode's primary agents and file prompts left out", async () => {
    seedAgents();
    const r = await importSubagents();
    expect(r.added.sort()).toEqual(["docs", "explorer", "reviewer", "scout", "tester"]);
    const by = Object.fromEntries(r.agents.map((a) => [a.name, a]));
    expect(by.reviewer).toMatchObject({ description: "Reviews code", prompt: "You review code.", tools: ["Read", "Grep", "Bash"], model: "sonnet", sources: ["claude:~/.claude/agents/reviewer.md"] });
    expect(by.explorer).toMatchObject({ prompt: "Explore the repo.", sources: ["codex:~/.codex/agents/explorer.toml"] });
    expect(by.scout!.tools).toEqual(["read", "grep", "find"]);
    // Where each harness gets it: Claude already has the reviewer.
    expect(by.reviewer!.delivery.find((d) => d.harness === "claude-code")!.how).toBe("native");
    expect(by.explorer!.delivery.find((d) => d.harness === "claude-code")!.how).toBe("session");
    expect(by.explorer!.delivery.find((d) => d.harness === "codex")!.how).toBe("native");
    expect(by.explorer!.delivery.find((d) => d.harness === "pi")).toMatchObject({ how: "none", note: "Needs the pi-subagents package" });
  });

  test("Claude Code: SDK agents for the ones it doesn't load itself, tools and model where they're Claude's", async () => {
    seedAgents();
    await importSubagents();
    put(join(proj, ".claude/agents/docs.md"), "---\ndescription: repo docs\n---\nRepo docs.\n");
    const defs = claudeAgentDefs(proj);
    expect(Object.keys(defs).sort()).toEqual(["explorer", "scout", "tester"]);
    expect(defs.scout).toEqual({ description: "Recon", prompt: "Scout the code.", tools: ["Read", "Grep", "Glob"] });
    expect(launchWith("claude-code", { projectPath: proj }).options.agents).toEqual(defs);
  });

  test("Codex: role files in the runner's config dir and agents.<name> thread config", async () => {
    seedAgents();
    await importSubagents();
    const cfg = codexAgentConfig();
    expect(Object.keys(cfg).sort()).toEqual(["agents.docs", "agents.reviewer", "agents.scout", "agents.tester"]);
    const role = cfg["agents.reviewer"]!;
    expect(role.description).toBe("Reviews code");
    expect(role.config_file.startsWith(process.env.TETHER_CONFIG_DIR!)).toBe(true);
    expect(Bun.TOML.parse(read(role.config_file))).toEqual({ name: "reviewer", description: "Reviews code", developer_instructions: "You review code." });
    expect(statSync(role.config_file).mode & 0o777).toBe(0o600);
    // merged with the MCP slot's config, one level deep
    expect(Object.keys(launchWith("codex", { projectPath: proj }).options.config).sort()).toEqual(Object.keys(cfg).sort());
    // a role in its config.toml is its own
    put(harness.codexConfig(), `[agents.docs]\ndescription = "mine"\nconfig_file = "/x.toml"\n`);
    expect(Object.keys(codexAgentConfig())).not.toContain("agents.docs");
  });

  test("opencode: inline subagents it doesn't have, provider/model kept", async () => {
    seedAgents();
    await importSubagents();
    const a = opencodeAgentConfig();
    expect(Object.keys(a).sort()).toEqual(["explorer", "reviewer", "scout"]);
    // Its tools list as permission rules: the rest denied, its own still asked (Tether's guard).
    expect(a.reviewer).toEqual({ description: "Reviews code", prompt: "You review code.", mode: "subagent", permission: { "*": "deny", read: "ask", grep: "ask", bash: "ask" } });
    expect(a.scout!.permission).toEqual({ "*": "deny", read: "ask", grep: "ask", glob: "ask" });
    expect(a.explorer!.permission).toBeUndefined();
    expect(processLaunch("opencode", proj).opencodeConfig?.agent).toEqual(a);
  });

  test("a tools list is never widened: an agent none of whose tools a harness has isn't handed to it", async () => {
    put(harness.piSettings(), JSON.stringify({ packages: ["npm:pi-subagents"] }));
    await addSubagent("---\nname: research\ndescription: Researches\ntools: WebSearch, WebFetch\n---\nLook it up.");
    put(join(HOME, ".pi/agent/agents/custom.md"), "---\nname: custom\ndescription: Custom\ntools: my_tool\n---\nUse my tool.\n");
    await importSubagents();
    expect(existsSync(join(piTetherAgentsDir(), "research.md"))).toBe(false);
    expect(Object.keys(claudeAgentDefs(proj))).toEqual(["research"]);
    expect(opencodeAgentConfig().research!.permission).toEqual({ "*": "deny", websearch: "ask", webfetch: "ask" });
    expect(opencodeAgentConfig().custom!.permission).toEqual({ "*": "deny" });
    const by = Object.fromEntries(listSubagents().map((a) => [a.name, a]));
    expect(by.research!.delivery.find((d) => d.harness === "pi")).toMatchObject({ how: "none", note: "None of its tools are pi's" });
    expect(by.custom!.delivery.find((d) => d.harness === "claude-code")).toMatchObject({ how: "none", note: "None of its tools are Claude Code's" });
  });

  test("pi: Tether's own folder, only with pi-subagents; never a folder that isn't Tether's", async () => {
    seedAgents();
    await importSubagents();
    syncPiAgents();
    expect(existsSync(piTetherAgentsDir())).toBe(false);
    put(harness.piSettings(), JSON.stringify({ packages: ["npm:pi-subagents"] }));
    syncPiAgents();
    const files = () => require("node:fs").readdirSync(piTetherAgentsDir()).sort();
    expect(files()).toEqual([".tether-owned", "docs.md", "explorer.md", "reviewer.md", "tester.md"]);
    expect(read(join(piTetherAgentsDir(), "reviewer.md"))).toBe(`---\nname: "reviewer"\ndescription: "Reviews code"\ntools: read, grep, bash\n---\n\nYou review code.\n`);
    // off: its file goes; deleted: too
    const docs = listSubagents().find((x) => x.name === "docs")!;
    await setSubagent(docs.id, { enabled: false });
    expect(files()).not.toContain("docs.md");
    // pi-subagents gone: the folder goes
    put(harness.piSettings(), JSON.stringify({ packages: [] }));
    syncPiAgents();
    expect(existsSync(piTetherAgentsDir())).toBe(false);
    // someone else's folder of that name is left alone
    put(join(piTetherAgentsDir(), "theirs.md"), "x");
    put(harness.piSettings(), JSON.stringify({ packages: ["npm:pi-subagents"] }));
    expect(syncPiAgents()).toContain("isn't Tether's");
    expect(files()).toEqual(["theirs.md"]);
  });

  test("adding by hand: a Claude Code agent file", async () => {
    await expect(addSubagent("no front matter and no name")).rejects.toThrow(/agent file/);
    await addSubagent("---\nname: helper\ndescription: Helps\ntools: [Read, Grep]\n---\nHelp out.");
    expect(listSubagents()[0]).toMatchObject({ name: "helper", tools: ["Read", "Grep"], sources: ["you"] });
  });

  test("pasting one under the same name replaces it wholesale", async () => {
    await addSubagent("---\nname: helper\ndescription: Old\ntools: Read, Grep\nmodel: opus\n---\nHelp out.");
    const id = listSubagents()[0]!.id;
    await setSubagent(id, { enabled: false });
    // Same prompt, new description, no tools or model.
    await addSubagent("---\nname: helper\ndescription: New\n---\nHelp out.");
    let a = listSubagents();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ id, description: "New", enabled: false, sources: ["you"] });
    expect(a[0]!.tools).toBeUndefined();
    expect(a[0]!.model).toBeUndefined();
    await addSubagent("---\nname: helper\ndescription: Newer\ntools: Read\n---\nHelp more.");
    a = listSubagents();
    expect(a[0]).toMatchObject({ id, description: "Newer", prompt: "Help more.", tools: ["Read"] });
  });
});

// ---------------- the matrix ----------------

describe("capability matrix", () => {
  test("every slot is mapped for every harness", () => {
    const m = capabilityMatrix();
    for (const [h, slots] of Object.entries(m)) for (const s of SLOTS) expect(`${h}.${s}: ${slots[s].note}`).not.toContain("not mapped yet");
    expect(m.kiro.agents.level).toBe("unsupported");
    expect(m.antigravity.agents.level).toBe("unsupported");
    expect(m.codex.commands.level).toBe("emulated");
    expect(m["claude-code"].agents.level).toBe("native");
  });
});
