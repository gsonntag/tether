import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { childEnv, isRunnerSecret } from "./childEnv";

/** Every .ts file under runner/src but tests. */
function sources(dir = import.meta.dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "node_modules" ? [] : sources(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

/** The text of each call to `name(` in `src`, up to its closing paren. */
function calls(src: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    out.push(src.slice(m.index!, i + 1));
  }
  return out;
}

test("every process the runner starts gets an explicit environment (Bun hands a child the one the runner started with)", () => {
  const missing: string[] = [];
  let seen = 0;
  for (const f of sources()) {
    const src = readFileSync(f, "utf8");
    for (const c of calls(src, /\b(?:Bun\.spawn|Bun\.spawnSync|spawn)\(/g)) {
      // A definition or a bare reference in a comment isn't a call that starts something.
      if (/^spawn\(\s*\)|^spawn\(argv: string\[\]/.test(c)) continue;
      seen++;
      if (!/\benv\b/.test(c)) missing.push(`${f.replace(import.meta.dir, "src")}: ${c.slice(0, 80)}`);
    }
  }
  expect(seen).toBeGreaterThan(10);
  expect(missing).toEqual([]);
});

test("every Agent SDK query() passes an environment too (it would otherwise hand Claude Code the runner's)", () => {
  const missing: string[] = [];
  let seen = 0;
  for (const f of sources()) {
    const src = readFileSync(f, "utf8");
    for (const c of calls(src, /(?<![.\w])query\((?=\{)/g)) {
      seen++;
      if (!/\benv\b/.test(c)) missing.push(`${f.replace(import.meta.dir, "src")}: ${c.slice(0, 80)}`);
    }
  }
  expect(seen).toBeGreaterThanOrEqual(3);
  expect(missing).toEqual([]);
});

test("childEnv: Tether's secrets out, everything else (and extras) in", () => {
  const env = { PATH: "/bin", HOME: "/h", CODEX_HOME: "/c", OPENAI_API_KEY: "o", TETHER_TOKEN: "t", TETHER_DISCORD_TOKEN: "d", TETHER_PHOTON_PROJECT_SECRET: "p", TETHER_TEXT_PHONE: "+1", TETHER_PEERS_TOKEN: "x", TETHER_TMUX_SOCKET: "tether", TETHER_URL: "https://x" };
  expect(childEnv({ GIT_TERMINAL_PROMPT: "0", HOME: undefined }, env)).toEqual({ PATH: "/bin", CODEX_HOME: "/c", OPENAI_API_KEY: "o", TETHER_TMUX_SOCKET: "tether", TETHER_URL: "https://x", GIT_TERMINAL_PROMPT: "0" });
  for (const k of ["TETHER_TOKEN", "TETHER_DISCORD_OWNER_IDS", "TETHER_VAPID_PRIVATE_KEY", "TETHER_GATEWAY_KEY"]) expect(isRunnerSecret(k)).toBe(true);
  expect(isRunnerSecret("TETHER_TMUX_SOCKET")).toBe(false);
});

test("a child really doesn't see a secret set when the runner started", async () => {
  const before = process.env.TETHER_TOKEN;
  process.env.TETHER_TOKEN = "secret-from-start";
  try {
    const p = Bun.spawn(["sh", "-c", "echo ${TETHER_TOKEN:-none}"], { env: childEnv(), stdout: "pipe" });
    expect((await new Response(p.stdout).text()).trim()).toBe("none");
  } finally {
    if (before === undefined) delete process.env.TETHER_TOKEN;
    else process.env.TETHER_TOKEN = before;
  }
});
