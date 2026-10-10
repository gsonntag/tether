// `/name args` from the message box runs a skill on every harness (web/src/shared/skill.ts parses
// it). Which skills a session can run comes from the master context's registry when it has been
// imported, else from a read-only look at the session harness's own skill dirs and the repo's
// .claude/skills and .agents/skills. On send, each one is resolved per harness:
//
//   - the harness can run that skill itself → passed through in its own syntax
//     (Claude Code `/name`, pi `/skill:name`, Codex a `skill` input item, ACP `/name` commands);
//   - otherwise → expanded: SKILL.md and a list of its files go in front of the request.

import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ContextSkill, HarnessId, SlashCommand } from "../../web/src/shared/protocol";
import { isSkillName, parseInvocation, skillBlock } from "../../web/src/shared/skill";
import { splitFrontMatter } from "./context/format";
import { harness as H, home, untilde } from "./context/paths";

export interface SkillInfo {
  /** the name typed after `/` */
  name: string;
  description?: string;
  /** the skill's folder (holds SKILL.md) */
  dir: string;
  /** badges: "claude", "codex", "agents", "repo", "tether", … */
  sources: string[];
  /** a registry skill symlinked into every harness's skill dir by the master context */
  installed?: boolean;
  /** a repo skill: the repo folder it must stay inside (symlinks resolved) to be read */
  root?: string;
}

/** What a harness can run itself, as reported by the live harness (undefined: it couldn't say). */
export interface NativeSkill {
  name: string;
  description?: string;
  /** SKILL.md or its folder, when the harness reports it */
  path?: string;
}

// ---------------- discovery ----------------

const isSkill = (dir: string) => existsSync(join(dir, "SKILL.md"));

const realOf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir === "/" ? "/" : dir + "/");

/**
 * The SKILL.md Tether may read for a skill: a regular file that, symlinks resolved, stays inside
 * the skill's folder, and for a repo skill (`root`) the folder stays inside the repo. A cloned repo
 * can't point a skill at ~/.ssh/id_rsa and have it read into a message or the menu.
 */
export function skillMd(dir: string, root?: string): string | undefined {
  const d = realOf(dir);
  const f = realOf(join(dir, "SKILL.md"));
  if (!d || !f || !inside(f, d)) return undefined;
  if (root) {
    const r = realOf(root);
    if (!r || !inside(d, r)) return undefined;
  }
  return statSync(f, { throwIfNoEntry: false })?.isFile() ? f : undefined;
}

/** SKILL.md is read up to this size; a longer one is cut, with a pointer to the rest. */
export const MAX_SKILL_BYTES = 256 * 1024;

/** SKILL.md as text (at most MAX_SKILL_BYTES), or an error for a binary file. */
export function readSkillMd(file: string, max = MAX_SKILL_BYTES): { text: string; truncated: boolean } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, max));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) throw new Error("SKILL.md is not a text file");
    // a multi-byte character cut at the limit decodes to U+FFFD; drop it
    const text = new TextDecoder().decode(bytes).replace(size > n ? /�+$/ : /$^/, "");
    return { text, truncated: size > n };
  } finally {
    closeSync(fd);
  }
}

function readDescription(dir: string, root?: string): string | undefined {
  try {
    const f = skillMd(dir, root);
    if (!f) return undefined;
    const d = splitFrontMatter(readSkillMd(f, 16 * 1024).text).fm.description;
    return typeof d === "string" ? d.slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

// Claude Code's own commands: `/name` runs one of these instead of a skill with the same name. The
// live list (builtin: true in supportedCommands) is used when Claude Code answers; this is for
// when it can't (still starting, or slow), plus every builtin name a live session ever reported.
const claudeBuiltins = new Set(
  "add-dir agents bashes bug clear compact config context cost doctor effort exit export fast feedback help hooks ide init install-github-app login logout mcp memory migrate-installer model output-style permissions plan plugin pr-comments privacy-settings release-notes resume review rewind sandbox security-review skills stats status statusline tasks terminal-setup theme todos upgrade usage vim".split(" "),
);
export function rememberClaudeBuiltins(names: Iterable<string>) {
  for (const n of names) claudeBuiltins.add(n);
}

/** The project folder and its parents up to the repo root (or /), nearest first. */
function upward(projectPath: string): string[] {
  const out: string[] = [];
  let d = resolve(projectPath);
  for (;;) {
    out.push(d);
    if (existsSync(join(d, ".git"))) break;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

/** Each harness's own skill dirs, nearest first, with a badge. Read only. */
export function harnessSkillDirs(harness: HarnessId, projectPath: string): SkillDir[] {
  const up = upward(projectPath);
  const repo = (sub: string) => up.map((d) => ({ dir: join(d, sub), source: "repo", root: up[up.length - 1] }));
  switch (harness) {
    case "claude-code":
      return [...repo(".claude/skills"), { dir: H.claudeSkills(), source: "claude" }];
    case "codex":
      return [...repo(".agents/skills"), ...repo(".codex/skills"), { dir: H.codexSkills(), source: "codex" }, { dir: H.agentsSkills(), source: "agents" }];
    case "pi":
      return [{ dir: join(projectPath, ".pi/skills"), source: "repo", root: up[up.length - 1] }, ...repo(".agents/skills"), { dir: H.piSkills(), source: "pi" }, { dir: H.agentsSkills(), source: "agents" }];
    case "opencode":
      return [
        ...repo(".opencode/skills"),
        ...repo(".claude/skills"),
        ...repo(".agents/skills"),
        { dir: H.opencodeSkills(), source: "opencode" },
        { dir: H.claudeSkills(), source: "claude" },
        { dir: H.agentsSkills(), source: "agents" },
      ];
    case "antigravity":
      return [{ dir: H.agySkills(), source: "antigravity" }, { dir: H.geminiSkills(), source: "gemini" }];
    case "kiro":
      return [{ dir: join(projectPath, ".kiro/skills"), source: "repo", root: up[up.length - 1] }, { dir: join(home(), ".kiro", "skills"), source: "kiro" }];
  }
}

interface SkillDir {
  dir: string;
  source: string;
  /** repo dirs: the repo root its skills must stay inside */
  root?: string;
}

function scan(dirs: SkillDir[], out: Map<string, SkillInfo>, hidden: Set<string>) {
  for (const { dir, source, root } of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      // Harness-owned dirs: claude.ai's synced copies, Codex's bundled .system skills.
      if (n.startsWith(".") || (n === "synced" && dir === H.claudeSkills())) continue;
      if (!isSkillName(n) || hidden.has(n)) continue;
      const p = join(dir, n);
      if (!skillMd(p, root)) continue;
      const have = out.get(n);
      if (have) {
        if (!have.sources.includes(source)) have.sources.push(source);
        continue;
      }
      out.set(n, { name: n, description: readDescription(p, root), dir: p, sources: [source], root });
    }
  }
}

type ContextSkills = { enabled: boolean; registry: string; skills: () => ContextSkill[] };

/** Names the master context has switched off: never offered, never expanded, wherever a copy is. */
export function disabledNames(skills: ContextSkill[]): Set<string> {
  return new Set(skills.filter((s) => !s.enabled).flatMap((s) => [s.name, ...(s.exposedAs ? [s.exposedAs] : [])]));
}

/**
 * Skills a session can run: the master context's enabled registry skills (once imported), the
 * repo's .claude/skills and .agents/skills, and the session harness's own skill dirs, all read in
 * place. The first one found under a name wins. A skill the master context has disabled is left
 * out everywhere (a harness dir may still hold a copy of it).
 */
export function sessionSkills(harness: HarnessId, projectPath: string, ctx?: ContextSkills): SkillInfo[] {
  const out = new Map<string, SkillInfo>();
  const up = upward(projectPath);
  const repos = new Set(up);
  let hidden = new Set<string>();
  if (ctx?.enabled) {
    const all = ctx.skills();
    hidden = disabledNames(all);
    for (const s of all) {
      if (!s.enabled) continue;
      if (s.repo && !repos.has(resolve(s.repo))) continue;
      const name = s.exposedAs ?? s.name;
      if (!isSkillName(name) || out.has(name)) continue;
      const dir = s.repo ? untilde(s.sources[0]?.path ?? "") : join(ctx.registry, s.name);
      const root = s.repo ? resolve(s.repo) : undefined;
      if (!dir || !skillMd(dir, root)) continue;
      const sources = s.repo ? ["repo"] : [...new Set(s.sources.map((x) => x.harness))];
      out.set(name, { name, description: s.description, dir, sources, installed: !s.repo, root });
    }
  }
  // Repo skills from both conventions are always offered, whatever the harness reads natively.
  const root = up[up.length - 1];
  scan(up.flatMap((d) => [".claude/skills", ".agents/skills"].map((sub) => ({ dir: join(d, sub), source: "repo", root }))), out, hidden);
  scan(harnessSkillDirs(harness, projectPath), out, hidden);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------- resolution ----------------

export type Resolution = "native" | "expand";

const under = (p: string, dir: string) => {
  const real = (x: string) => {
    try {
      return realpathSync(x);
    } catch {
      return resolve(x);
    }
  };
  const a = real(p);
  const b = real(dir);
  return a === b || a.startsWith(b + "/");
};

/**
 * Whether the harness runs this skill itself or Tether expands it. `native` is what the live
 * harness reported it can run (by name); when it couldn't say, the skill's location decides.
 */
export function decide(harness: HarnessId, skill: Pick<SkillInfo, "name" | "dir" | "installed">, native: Set<string> | undefined, projectPath: string): Resolution {
  if (native) return native.has(skill.name) ? "native" : "expand";
  // No live answer: only harnesses with a native skill syntax, and only for skills in their dirs.
  if (harness !== "claude-code" && harness !== "codex" && harness !== "pi") return "expand";
  // Claude Code runs its own command of that name instead.
  if (harness === "claude-code" && claudeBuiltins.has(skill.name)) return "expand";
  if (skill.installed) return "native";
  // In one of its dirs, or linked into one under the same name.
  const found = harnessSkillDirs(harness, projectPath).some((d) => under(skill.dir, d.dir) || (isSkill(join(d.dir, skill.name)) && under(join(d.dir, skill.name), skill.dir)));
  return found ? "native" : "expand";
}

const MAX_FILES = 60;
const MAX_DEPTH = 6;

/**
 * Absolute paths of a skill's files other than SKILL.md (listed, never read). Symlinked folders
 * are listed as entries but not walked into: a link to `..` or to $HOME would loop or list
 * whatever is there.
 */
export function skillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (out.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(d).sort();
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= MAX_FILES) return;
      if (n === ".git" || n === "node_modules" || n === ".DS_Store") continue;
      const p = join(d, n);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (st.isSymbolicLink() && statSync(p, { throwIfNoEntry: false })?.isDirectory()) out.push(`${p}/`);
      else if (p !== join(dir, "SKILL.md")) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

/** The message for a harness that can't run the skill: SKILL.md and its files in front of the request. */
export function expandSkill(skill: Pick<SkillInfo, "name" | "dir" | "root">, args: string): string {
  if (!isSkillName(skill.name)) throw new Error(`not a skill name: ${skill.name}`);
  const file = skillMd(skill.dir, skill.root);
  if (!file) throw new Error(`${skill.name}: SKILL.md is missing or points outside the skill`);
  const location = join(skill.dir, "SKILL.md");
  const { text, truncated } = readSkillMd(file);
  let body = splitFrontMatter(text).body;
  if (truncated) body = `${body.trimEnd()}\n\n[SKILL.md is longer than ${MAX_SKILL_BYTES / 1024} KB and was cut here: read the rest from ${location}]`;
  return skillBlock({ name: skill.name, location, body, files: skillFiles(skill.dir), args });
}

export interface ResolveContext {
  harness: HarnessId;
  projectPath: string;
  skills: SkillInfo[];
  native: Set<string> | undefined;
  /** the harness's own syntax for running one of its skills (undefined: expand it instead) */
  nativeText: (name: string, args: string) => string | undefined;
}

/**
 * One message on its way to the agent. `/name args` for a known skill becomes the harness's own
 * invocation or the expanded skill; `\/…` is sent without the backslash; anything else is unchanged
 * (including `/name` that isn't a skill: it may be one of the harness's own commands).
 */
export function resolveMessage(text: string, c: ResolveContext): string {
  const inv = parseInvocation(text);
  if (!inv) return text;
  if ("literal" in inv) {
    // A harness that reads `/name` itself (Claude Code, ACP) would still run it: keep the escape
    // there so it doesn't. Unknown (no live answer): keep it for those harnesses too.
    const name = parseInvocation(inv.literal);
    if (!name || !("name" in name)) return inv.literal;
    const readsSlash = c.nativeText(name.name, "") === `/${name.name}`;
    const runs = c.native ? c.native.has(name.name) : c.harness === "claude-code";
    return readsSlash && runs ? text : inv.literal;
  }
  const skill = c.skills.find((s) => s.name === inv.name);
  if (!skill) return text;
  if (decide(c.harness, skill, c.native, c.projectPath) === "native") {
    const native = c.nativeText(skill.name, inv.args);
    if (native !== undefined) return native;
  }
  try {
    return expandSkill(skill, inv.args);
  } catch {
    return text; // SKILL.md went away: send as typed
  }
}

/**
 * A message as typed, for a handoff brief to `harness`: inside the brief `/name` isn't at the start
 * of the message, so no harness would run it natively. A skill the new session has is expanded.
 */
export function resolveForBrief(harness: HarnessId, projectPath: string, text: string): string {
  return resolveMessage(text, { harness, projectPath, skills: skillsFor(harness, projectPath), native: new Set(), nativeText: () => undefined });
}

/**
 * The `/` menu: skills first (with how they'll run here), then the harness's other commands. A
 * harness that loaded a skill before the master context disabled it still lists it as a command:
 * `hidden` leaves those out.
 */
export function slashMenu(
  skills: SkillInfo[],
  commands: SlashCommand[],
  native: Set<string> | undefined,
  harness: HarnessId,
  projectPath: string,
  hidden: Set<string> = new Set(),
): SlashCommand[] {
  const names = new Set(skills.map((s) => s.name));
  return [
    ...skills.map(
      (s): SlashCommand => ({ name: s.name, description: s.description, kind: "skill", sources: s.sources, native: decide(harness, s, native, projectPath) === "native" }),
    ),
    ...commands.filter((c) => !names.has(c.name) && !hidden.has(c.name)).map((c): SlashCommand => ({ ...c, kind: "command" })),
  ];
}

// ---------------- where sessions get their skills ----------------

type ContextSource = () => ContextSkills;
let contextSource: ContextSource | undefined;

/** runner/src/index.ts: skills come from the master context once it has been imported. */
export function useContextSkills(fn: ContextSource) {
  contextSource = fn;
}

function currentContext(): ContextSkills | undefined {
  try {
    return contextSource?.();
  } catch {
    return undefined;
  }
}

/** The master context's disabled skills (empty while it is off). */
export function hiddenSkills(): Set<string> {
  const ctx = currentContext();
  if (!ctx?.enabled) return new Set();
  try {
    return disabledNames(ctx.skills());
  } catch {
    return new Set();
  }
}

/** A session's skills, plus the ones its harness reported (with a path) that the dirs didn't show. */
export function skillsFor(harness: HarnessId, projectPath: string, native?: NativeSkill[]): SkillInfo[] {
  const ctx = currentContext();
  const list = sessionSkills(harness, projectPath, ctx);
  const have = new Set(list.map((s) => s.name));
  const hidden = native?.length ? hiddenSkills() : new Set<string>();
  for (const n of native ?? []) {
    if (!n.path || have.has(n.name) || hidden.has(n.name) || !isSkillName(n.name)) continue;
    const dir = n.path.endsWith("SKILL.md") ? dirname(n.path) : n.path;
    if (!skillMd(dir)) continue;
    have.add(n.name);
    list.push({ name: n.name, description: n.description ?? readDescription(dir), dir, sources: [harness === "claude-code" ? "claude" : harness] });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}
