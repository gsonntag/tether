// `/name args` from the message box runs a skill on every harness (web/src/shared/skill.ts parses
// it). Which skills a session can run comes from the master context's registry when it has been
// imported, else from a read-only look at the session harness's own skill dirs and the repo's
// .claude/skills and .agents/skills. On send, each one is resolved per harness:
//
//   - the harness can run that skill itself → passed through in its own syntax
//     (Claude Code `/name`, pi `/skill:name`, Codex a `skill` input item, ACP `/name` commands);
//   - otherwise → expanded: SKILL.md and a list of its files go in front of the request.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ContextSkill, HarnessId, SlashCommand } from "../../web/src/shared/protocol";
import { parseInvocation, skillBlock } from "../../web/src/shared/skill";
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

function readDescription(dir: string): string | undefined {
  try {
    const d = splitFrontMatter(readFileSync(join(dir, "SKILL.md"), "utf8")).fm.description;
    return typeof d === "string" ? d : undefined;
  } catch {
    return undefined;
  }
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
export function harnessSkillDirs(harness: HarnessId, projectPath: string): { dir: string; source: string }[] {
  const up = upward(projectPath);
  const repo = (sub: string) => up.map((d) => ({ dir: join(d, sub), source: "repo" }));
  switch (harness) {
    case "claude-code":
      return [...repo(".claude/skills"), { dir: H.claudeSkills(), source: "claude" }];
    case "codex":
      return [...repo(".agents/skills"), ...repo(".codex/skills"), { dir: H.codexSkills(), source: "codex" }, { dir: H.agentsSkills(), source: "agents" }];
    case "pi":
      return [{ dir: join(projectPath, ".pi/skills"), source: "repo" }, ...repo(".agents/skills"), { dir: H.piSkills(), source: "pi" }, { dir: H.agentsSkills(), source: "agents" }];
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
      return [{ dir: join(projectPath, ".kiro/skills"), source: "repo" }, { dir: join(home(), ".kiro", "skills"), source: "kiro" }];
  }
}

function scan(dirs: { dir: string; source: string }[], out: Map<string, SkillInfo>) {
  for (const { dir, source } of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      // Harness-owned dirs: claude.ai's synced copies, Codex's bundled .system skills.
      if (n.startsWith(".") || (n === "synced" && dir === H.claudeSkills())) continue;
      const p = join(dir, n);
      if (!isSkill(p)) continue;
      const have = out.get(n);
      if (have) {
        if (!have.sources.includes(source)) have.sources.push(source);
        continue;
      }
      out.set(n, { name: n, description: readDescription(p), dir: p, sources: [source] });
    }
  }
}

/**
 * Skills a session can run: the master context's enabled registry skills (once imported), the
 * repo's .claude/skills and .agents/skills, and the session harness's own skill dirs, all read in
 * place. The first one found under a name wins.
 */
export function sessionSkills(
  harness: HarnessId,
  projectPath: string,
  ctx?: { enabled: boolean; registry: string; skills: () => ContextSkill[] },
): SkillInfo[] {
  const out = new Map<string, SkillInfo>();
  const repos = new Set(upward(projectPath));
  if (ctx?.enabled) {
    for (const s of ctx.skills()) {
      if (!s.enabled) continue;
      if (s.repo && !repos.has(resolve(s.repo))) continue;
      const name = s.exposedAs ?? s.name;
      if (out.has(name)) continue;
      const dir = s.repo ? untilde(s.sources[0]?.path ?? "") : join(ctx.registry, s.name);
      if (!dir || !isSkill(dir)) continue;
      const sources = s.repo ? ["repo"] : [...new Set(s.sources.map((x) => x.harness))];
      out.set(name, { name, description: s.description, dir, sources, installed: !s.repo });
    }
  }
  // Repo skills from both conventions are always offered, whatever the harness reads natively.
  scan(upward(projectPath).flatMap((d) => [".claude/skills", ".agents/skills"].map((sub) => ({ dir: join(d, sub), source: "repo" }))), out);
  scan(harnessSkillDirs(harness, projectPath), out);
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
  if (skill.installed) return "native";
  // In one of its dirs, or linked into one under the same name.
  const found = harnessSkillDirs(harness, projectPath).some((d) => under(skill.dir, d.dir) || (isSkill(join(d.dir, skill.name)) && under(join(d.dir, skill.name), skill.dir)));
  return found ? "native" : "expand";
}

const MAX_FILES = 60;

/** Absolute paths of a skill's files other than SKILL.md. */
export function skillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
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
      const st = statSync(p, { throwIfNoEntry: false });
      if (st?.isDirectory()) walk(p);
      else if (st?.isFile() && p !== join(dir, "SKILL.md")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** The message for a harness that can't run the skill: SKILL.md and its files in front of the request. */
export function expandSkill(skill: Pick<SkillInfo, "name" | "dir">, args: string): string {
  const location = join(skill.dir, "SKILL.md");
  const body = splitFrontMatter(readFileSync(location, "utf8")).body;
  return skillBlock({ name: skill.name, location, body, files: skillFiles(skill.dir), args });
}

export interface ResolveContext {
  harness: HarnessId;
  projectPath: string;
  skills: SkillInfo[];
  native: Set<string> | undefined;
  /** the harness's own syntax for running one of its skills */
  nativeText: (name: string, args: string) => string;
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
    // A harness that reads `/name` itself would still run it: keep the escape there so it doesn't.
    const name = parseInvocation(inv.literal);
    return name && "name" in name && c.native?.has(name.name) ? text : inv.literal;
  }
  const skill = c.skills.find((s) => s.name === inv.name);
  if (!skill) return text;
  if (decide(c.harness, skill, c.native, c.projectPath) === "native") return c.nativeText(skill.name, inv.args);
  try {
    return expandSkill(skill, inv.args);
  } catch {
    return text; // SKILL.md went away: send as typed
  }
}

/** The `/` menu: skills first (with how they'll run here), then the harness's other commands. */
export function slashMenu(skills: SkillInfo[], commands: SlashCommand[], native: Set<string> | undefined, harness: HarnessId, projectPath: string): SlashCommand[] {
  const names = new Set(skills.map((s) => s.name));
  return [
    ...skills.map(
      (s): SlashCommand => ({ name: s.name, description: s.description, kind: "skill", sources: s.sources, native: decide(harness, s, native, projectPath) === "native" }),
    ),
    ...commands.filter((c) => !names.has(c.name)).map((c): SlashCommand => ({ ...c, kind: "command" })),
  ];
}

// ---------------- where sessions get their skills ----------------

type ContextSource = () => { enabled: boolean; registry: string; skills: () => ContextSkill[] };
let contextSource: ContextSource | undefined;

/** runner/src/index.ts: skills come from the master context once it has been imported. */
export function useContextSkills(fn: ContextSource) {
  contextSource = fn;
}

/** A session's skills, plus the ones its harness reported (with a path) that the dirs didn't show. */
export function skillsFor(harness: HarnessId, projectPath: string, native?: NativeSkill[]): SkillInfo[] {
  let ctx: ReturnType<ContextSource> | undefined;
  try {
    ctx = contextSource?.();
  } catch {}
  const list = sessionSkills(harness, projectPath, ctx);
  const have = new Set(list.map((s) => s.name));
  for (const n of native ?? []) {
    if (!n.path || have.has(n.name)) continue;
    const dir = n.path.endsWith("SKILL.md") ? dirname(n.path) : n.path;
    if (!isSkill(dir)) continue;
    have.add(n.name);
    list.push({ name: n.name, description: n.description ?? readDescription(dir), dir, sources: [harness === "claude-code" ? "claude" : harness] });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}
