// The skill registry: one library in context/skills/, symlinked into every harness's skill dir.
// Skills found in harness dirs are imported; the copies they replace are moved to
// context/backup/<date>/… first ("back up, then symlink"). Copies that differ keep the newest
// one and record the drift. Harness-owned dirs (~/.claude/skills/synced, ~/.codex/skills/.system,
// dot dirs) are never touched, and a registry skill named like a Codex builtin is exposed as
// `<name>-tether`.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ContextSkill } from "../../../web/src/shared/protocol";
import { splitFrontMatter } from "./format";
import { harness, tilde } from "./paths";
import { writeAtomic } from "./store";

export interface SkillDir {
  harness: string;
  dir: string;
  /** every registry skill gets a symlink here (otherwise only existing copies are replaced) */
  install: boolean;
  skip: string[];
}

export function skillDirs(): SkillDir[] {
  return [
    { harness: "claude", dir: harness.claudeSkills(), install: true, skip: ["synced"] },
    { harness: "agents", dir: harness.agentsSkills(), install: true, skip: [] },
    { harness: "antigravity", dir: harness.agySkills(), install: true, skip: [] },
    { harness: "gemini", dir: harness.geminiSkills(), install: true, skip: [] },
    { harness: "codex", dir: harness.codexSkills(), install: false, skip: [] },
    { harness: "pi", dir: harness.piSkills(), install: false, skip: [] },
    { harness: "opencode", dir: harness.opencodeSkills(), install: false, skip: [] },
  ];
}

/** Codex's bundled skills: a registry skill with the same name would shadow or be shadowed. */
export function builtinNames(): Set<string> {
  try {
    return new Set(readdirSync(join(harness.codexSkills(), ".system")).filter((n) => !n.startsWith(".")));
  } catch {
    return new Set();
  }
}

export interface SkillCopy {
  harness: string;
  /** the entry in the harness dir (a dir or a symlink) */
  path: string;
  /** resolved content dir */
  real: string;
  mtime: number;
  hash: string;
}

function walkFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const n of readdirSync(dir).sort()) {
    if (n === ".git" || n === "node_modules") continue;
    const p = join(dir, n);
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) walkFiles(p, base, out);
    else if (st?.isFile()) out.push(relative(base, p));
  }
  return out;
}

export function dirStamp(dir: string): { hash: string; mtime: number } {
  const h = createHash("sha256");
  let mtime = 0;
  for (const f of walkFiles(dir)) {
    const p = join(dir, f);
    h.update(f + "\0");
    h.update(readFileSync(p));
    mtime = Math.max(mtime, statSync(p).mtimeMs);
  }
  return { hash: h.digest("hex").slice(0, 16), mtime };
}

const isSkill = (p: string) => existsSync(join(p, "SKILL.md"));

/** Whether `p` is a symlink into the registry (one of ours). */
export function isOurLink(p: string, registry: string): boolean {
  try {
    if (!lstatSync(p).isSymbolicLink()) return false;
    const t = resolve(dirname(p), readlinkSync(p));
    return t === registry || t.startsWith(registry + "/");
  } catch {
    return false;
  }
}

/** Skills currently in harness dirs (not counting our own symlinks). */
export function findCopies(registry: string): Map<string, SkillCopy[]> {
  const out = new Map<string, SkillCopy[]>();
  for (const sd of skillDirs()) {
    let names: string[] = [];
    try {
      names = readdirSync(sd.dir).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (n.startsWith(".") || sd.skip.includes(n)) continue;
      const p = join(sd.dir, n);
      if (isOurLink(p, registry)) continue;
      let real: string;
      try {
        real = realpathSync(p);
      } catch {
        continue; // dangling link
      }
      if (!statSync(real).isDirectory() || !isSkill(real)) continue;
      const name = n.replace(/-tether$/, "");
      const { hash, mtime } = dirStamp(real);
      const list = out.get(name) ?? [];
      list.push({ harness: sd.harness, path: p, real, mtime, hash });
      out.set(name, list);
    }
  }
  return out;
}

export interface SkillPlan {
  skills: { name: string; exposedAs?: string; from?: SkillCopy; copies: SkillCopy[]; drift: string[] }[];
  backups: { path: string; skill: string; to: string }[];
  symlinks: { path: string; target: string }[];
}

const label = (dir: string) => tilde(dir).replace(/^~\/?/, "").replace(/[/]+/g, "-") || "home";

/**
 * What syncing skills would do now: which copy wins per skill, which dirs move to the backup,
 * which symlinks appear. Pure: reads the filesystem, changes nothing.
 */
export function planSkills(registry: string, backupRoot: string, disabled: Set<string> = new Set()): SkillPlan {
  const copies = findCopies(registry);
  const builtins = builtinNames();
  const names = new Set<string>(copies.keys());
  try {
    for (const n of readdirSync(registry)) if (!n.startsWith(".") && isSkill(join(registry, n))) names.add(n);
  } catch {}
  const plan: SkillPlan = { skills: [], backups: [], symlinks: [] };
  for (const name of [...names].sort()) {
    const found = copies.get(name) ?? [];
    const reg = join(registry, name);
    const regStamp = isSkill(reg) ? dirStamp(reg) : undefined;
    const newest = [...found].sort((a, b) => b.mtime - a.mtime)[0];
    // The registry's copy wins unless a harness copy is newer and different.
    const from = newest && (!regStamp || (newest.hash !== regStamp.hash && newest.mtime > regStamp.mtime)) ? newest : undefined;
    const keep = from?.hash ?? regStamp?.hash;
    const drift = [...new Set(found.filter((c) => c.hash !== keep).map((c) => tilde(c.path)))];
    const exposedAs = builtins.has(name) ? `${name}-tether` : undefined;
    plan.skills.push({ name, exposedAs, from, copies: found, drift });
    if (disabled.has(name)) continue;
    for (const c of found) plan.backups.push({ path: c.path, skill: name, to: join(backupRoot, label(dirname(c.path)), c.path.split("/").pop()!) });
    for (const sd of skillDirs()) {
      const replacing = found.some((c) => dirname(c.path) === sd.dir);
      if (!sd.install && !replacing) continue;
      if (!replacing && [name, exposedAs].some((n) => n && isOurLink(join(sd.dir, n), registry))) continue;
      const link = join(sd.dir, replacing ? found.find((c) => dirname(c.path) === sd.dir)!.path.split("/").pop()! : (exposedAs ?? name));
      if (isOurLink(link, registry)) continue;
      plan.symlinks.push({ path: link, target: reg });
    }
  }
  return plan;
}

function move(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Applies a plan: winning copies into the registry, originals to the backup, symlinks in place.
 * Returns the registry paths that changed (for the commit) and what was done, for the feed.
 */
export function applySkillPlan(registry: string, plan: SkillPlan, meta: SkillMeta): { changed: string[]; log: string[] } {
  const changed: string[] = [];
  const log: string[] = [];
  mkdirSync(registry, { recursive: true });
  for (const s of plan.skills) {
    if (!s.from) continue;
    const reg = join(registry, s.name);
    rmSync(reg, { recursive: true, force: true });
    cpSync(s.from.real, reg, { recursive: true, dereference: true });
    changed.push(reg);
    log.push(`Imported skill ${s.name} from ${tilde(s.from.path)}`);
  }
  for (const s of plan.skills) {
    const m = (meta[s.name] ??= { sources: [] });
    for (const c of s.copies) if (!m.sources.some((x) => x.path === tilde(c.path))) m.sources.push({ harness: c.harness, path: tilde(c.path) });
    if (s.drift.length) m.drift = [...new Set([...(m.drift ?? []), ...s.drift])];
  }
  for (const b of plan.backups) {
    if (!existsSync(b.path) && !isLink(b.path)) continue;
    let to = b.to;
    for (let i = 2; existsSync(to) || isLink(to); i++) to = `${b.to}-${i}`;
    move(b.path, to);
    log.push(`Backed up ${tilde(b.path)} to ${tilde(to)}`);
  }
  for (const l of plan.symlinks) {
    if (existsSync(l.path) || isLink(l.path)) {
      // Only ever replace our own (stale) links; anything else was in the plan's backups.
      if (!isLink(l.path)) continue;
      unlinkSync(l.path);
    }
    mkdirSync(dirname(l.path), { recursive: true });
    symlinkSync(l.target, l.path, "dir");
  }
  return { changed, log };
}

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Removes our symlinks for a skill (disabling it). */
export function unlinkSkill(registry: string, name: string) {
  for (const sd of skillDirs()) {
    for (const n of [name, `${name}-tether`]) {
      const p = join(sd.dir, n);
      if (isOurLink(p, registry)) unlinkSync(p);
    }
  }
}

/** skills.json in the store: provenance, drift and the enable switch per skill. */
export type SkillMeta = Record<string, { sources: { harness: string; path: string }[]; drift?: string[]; disabled?: boolean }>;

export const disabledSet = (meta: SkillMeta) => new Set(Object.entries(meta).filter(([, m]) => m.disabled).map(([n]) => n));

export function readMeta(path: string): SkillMeta {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function writeMeta(path: string, meta: SkillMeta) {
  writeAtomic(path, JSON.stringify(meta, null, 2) + "\n");
}

function description(dir: string): string | undefined {
  try {
    const d = splitFrontMatter(readFileSync(join(dir, "SKILL.md"), "utf8")).fm.description;
    return typeof d === "string" ? d : undefined;
  } catch {
    return undefined;
  }
}

/** The registry plus repo-scoped skills (repo .claude/skills, .agents/skills: listed, left in place). */
export function listSkills(registry: string, meta: SkillMeta, repos: string[] = []): ContextSkill[] {
  const disabled = disabledSet(meta);
  const builtins = builtinNames();
  const out: ContextSkill[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(registry).filter((n) => !n.startsWith(".") && isSkill(join(registry, n)));
  } catch {}
  for (const name of names.sort()) {
    const m = meta[name];
    out.push({
      name,
      exposedAs: builtins.has(name) ? `${name}-tether` : undefined,
      description: description(join(registry, name)),
      sources: m?.sources ?? [{ harness: "tether", path: tilde(join(registry, name)) }],
      drift: m?.drift?.length ? m.drift : undefined,
      enabled: !disabled.has(name),
    });
  }
  for (const repo of repos) {
    for (const sub of [".claude/skills", ".agents/skills"]) {
      const dir = join(repo, sub);
      let ns: string[] = [];
      try {
        ns = readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of ns.sort()) {
        const p = join(dir, n);
        if (n.startsWith(".") || !isSkill(p)) continue;
        out.push({ name: n, description: description(p), sources: [{ harness: sub.split("/")[0]!.slice(1), path: tilde(p) }], enabled: true, repo });
      }
    }
  }
  return out;
}

/** Path of a registry skill's SKILL.md, for skill_get. */
export function skillFile(registry: string, name: string): string | undefined {
  const p = join(registry, name.replace(/-tether$/, ""), "SKILL.md");
  return /^[\w.-]+$/.test(name) && existsSync(p) ? p : undefined;
}

