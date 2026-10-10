// The skill registry: one library in context/skills/, symlinked into every harness's skill dir.
// Skills found in harness dirs are imported; the copies they replace are moved to
// context/backup/<date>/… first ("back up, then symlink"). Copies that differ keep the newest
// one and record the drift. Harness-owned dirs (~/.claude/skills/synced, ~/.codex/skills/.system,
// dot dirs) are never touched, and a registry skill named like a Codex builtin is exposed as
// `<name>-tether`.
//
// Data safety:
//  - Each skill is applied on its own: registry copy (via a temp dir), then for each harness copy
//    move-to-backup immediately followed by the symlink. A failure rolls that copy back and leaves
//    the other skills alone.
//  - Only symlinks that resolve into the registry are ever removed or replaced.
//  - Every link location is recorded in skills.json, so a crash, a disable/enable or a lost link is
//    repaired on the next pass, and the whole thing can be undone (unlinkAll).

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
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ContextSkill } from "../../../web/src/shared/protocol";
import { splitFrontMatter } from "./format";
import { harness, tilde, untilde } from "./paths";
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

const MAX_FILES = 5000;

/**
 * Files under a skill dir, for hashing. Symlinks are never followed into directories (a link to
 * `.` or a parent would loop); a linked file counts by its content, a linked dir by its target.
 */
function walk(dir: string, base = dir, out: { rel: string; link?: string }[] = [], depth = 0) {
  if (depth > 20 || out.length > MAX_FILES) return out;
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    if (n === ".git" || n === "node_modules") continue;
    const p = join(dir, n);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      const t = statSync(p, { throwIfNoEntry: false });
      if (t?.isFile()) out.push({ rel: relative(base, p) });
      else out.push({ rel: relative(base, p), link: readlinkSync(p) });
    } else if (st.isDirectory()) walk(p, base, out, depth + 1);
    else if (st.isFile()) out.push({ rel: relative(base, p) });
  }
  return out;
}

export function dirStamp(dir: string): { hash: string; mtime: number } {
  const h = createHash("sha256");
  let mtime = 0;
  for (const f of walk(dir)) {
    const p = join(dir, f.rel);
    h.update(f.rel + "\0");
    if (f.link !== undefined) {
      h.update("link:" + f.link);
      continue;
    }
    try {
      h.update(readFileSync(p));
      mtime = Math.max(mtime, statSync(p).mtimeMs);
    } catch {}
  }
  return { hash: h.digest("hex").slice(0, 16), mtime };
}

const isSkill = (p: string) => existsSync(join(p, "SKILL.md"));

const isLink = (p: string) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Whether `p` is a symlink into the registry (one of ours), dangling or not. */
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
export function findCopies(registry: string, warnings: string[] = []): Map<string, SkillCopy[]> {
  const out = new Map<string, SkillCopy[]>();
  const seen = new Set<string>(); // the same entry reached through two harness dirs (a linked dir)
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
      try {
        const real = realpathSync(p); // throws for dangling links: left alone
        if (!statSync(real).isDirectory() || !isSkill(real)) continue;
        const entryKey = join(realpathSync(sd.dir), n);
        if (seen.has(entryKey)) continue;
        seen.add(entryKey);
        // The registry itself (someone linked a harness dir to it) is not a copy.
        if (real === registry || real.startsWith(registry + "/")) continue;
        const name = n.replace(/-tether$/, "");
        const { hash, mtime } = dirStamp(real);
        const list = out.get(name) ?? [];
        list.push({ harness: sd.harness, path: p, real, mtime, hash });
        out.set(name, list);
      } catch (e: any) {
        warnings.push(`${tilde(p)}: ${e?.code ?? e?.message ?? e}`);
      }
    }
  }
  return out;
}

export interface SkillPlan {
  skills: { name: string; exposedAs?: string; from?: SkillCopy; copies: SkillCopy[]; drift: string[] }[];
  backups: { path: string; skill: string; to: string }[];
  symlinks: { path: string; target: string; skill?: string }[];
  warnings?: string[];
}

const label = (dir: string) => tilde(dir).replace(/^~\/?/, "").replace(/[/]+/g, "-") || "home";

/** What occupies a link location: nothing, our link, or something of the user's. */
function occupant(p: string, registry: string): "free" | "ours" | "user" {
  if (isOurLink(p, registry)) return "ours";
  return existsSync(p) || isLink(p) ? "user" : "free";
}

/**
 * What syncing skills would do now: which copy wins per skill, which dirs move to the backup,
 * which symlinks appear. Pure: reads the filesystem, changes nothing.
 */
export function planSkills(registry: string, backupRoot: string, disabled: Set<string> = new Set(), meta: SkillMeta = {}): SkillPlan {
  const warnings: string[] = [];
  const copies = findCopies(registry, warnings);
  const builtins = builtinNames();
  const names = new Set<string>(copies.keys());
  try {
    for (const n of readdirSync(registry)) if (!n.startsWith(".") && isSkill(join(registry, n))) names.add(n);
  } catch {}
  const plan: SkillPlan = { skills: [], backups: [], symlinks: [], warnings };
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
    const links = new Set<string>();
    for (const c of found) {
      plan.backups.push({ path: c.path, skill: name, to: join(backupRoot, label(dirname(c.path)), basename(c.path)) });
      links.add(c.path);
    }
    for (const sd of skillDirs()) {
      if (!sd.install) continue;
      const here = [name, exposedAs].filter(Boolean).map((n) => join(sd.dir, n!));
      if (here.some((p) => links.has(p) || isOurLink(p, registry))) continue;
      links.add(join(sd.dir, exposedAs ?? name));
    }
    // Places we linked before (replaced copies in codex/pi/opencode too): put back what's missing.
    for (const l of meta[name]?.links ?? []) links.add(untildePath(l.path));
    for (const path of [...links].sort()) {
      const occ = occupant(path, registry);
      const isBackedUp = found.some((c) => c.path === path);
      if (occ === "ours" || (occ === "user" && !isBackedUp)) continue;
      plan.symlinks.push({ path, target: reg, skill: name });
    }
  }
  return plan;
}

const untildePath = untilde;

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

/** A free name next to `to` (`to`, `to-2`, …): a backup never overwrites an earlier one. */
function freeName(to: string): string {
  let out = to;
  for (let i = 2; existsSync(out) || isLink(out); i++) out = `${to}-${i}`;
  return out;
}

/** Copies a skill dir into the registry through a temp dir, so a failed copy leaves the old one. */
function installCopy(src: string, dest: string) {
  const tmp = `${dest}.tether-tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(src, tmp, { recursive: true, dereference: true });
    const old = `${dest}.tether-old-${process.pid}`;
    if (existsSync(dest)) renameSync(dest, old);
    renameSync(tmp, dest);
    rmSync(old, { recursive: true, force: true });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

function recordLink(meta: SkillMeta, name: string, path: string, replaced: boolean) {
  const m = (meta[name] ??= { sources: [] });
  const links = (m.links ??= []);
  const t = tilde(path);
  const cur = links.find((l) => l.path === t);
  if (cur) cur.replaced ||= replaced;
  else links.push({ path: t, replaced });
}

/**
 * Applies a plan, one skill at a time: the winning copy into the registry, then each original to
 * the backup with its symlink right behind it. Returns the registry paths that changed (for the
 * commit) and what was done, for the feed. A skill that fails is rolled back and reported; the
 * others still go through.
 */
export function applySkillPlan(registry: string, plan: SkillPlan, meta: SkillMeta): { changed: string[]; log: string[]; errors: string[] } {
  const changed: string[] = [];
  const log: string[] = [];
  const errors: string[] = [];
  mkdirSync(registry, { recursive: true });
  for (const s of plan.skills) {
    const m = (meta[s.name] ??= { sources: [] });
    for (const c of s.copies) if (!m.sources.some((x) => x.path === tilde(c.path))) m.sources.push({ harness: c.harness, path: tilde(c.path) });
    if (s.drift.length) m.drift = [...new Set([...(m.drift ?? []), ...s.drift])];
  }
  for (const s of plan.skills) {
    const reg = join(registry, s.name);
    try {
      if (s.from) {
        installCopy(s.from.real, reg);
        changed.push(reg);
        log.push(`Imported skill ${s.name} from ${tilde(s.from.path)}`);
      }
      if (!isSkill(reg)) continue; // nothing to link to
      const backups = new Map(plan.backups.filter((b) => b.skill === s.name).map((b) => [b.path, b]));
      for (const l of plan.symlinks.filter((x) => (x.skill ?? basename(x.target)) === s.name)) {
        const b = backups.get(l.path);
        let movedTo: string | undefined;
        try {
          if (b && (existsSync(b.path) || isLink(b.path))) {
            movedTo = freeName(b.to);
            move(b.path, movedTo);
            log.push(`Backed up ${tilde(b.path)} to ${tilde(movedTo)}`);
          }
          const occ = occupant(l.path, registry);
          if (occ === "user") continue; // appeared meanwhile: theirs
          if (occ === "ours") unlinkSync(l.path);
          mkdirRecorded(registry, dirname(l.path));
          symlinkSync(l.target, l.path, "dir");
          recordLink(meta, s.name, l.path, !!b);
        } catch (e: any) {
          // Put the original back where it was, if we had moved it.
          if (movedTo && !existsSync(l.path) && !isLink(l.path)) {
            try {
              move(movedTo, l.path);
            } catch {}
          }
          errors.push(`${s.name}: ${tilde(l.path)}: ${e?.code ?? e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      errors.push(`${s.name}: ${e?.code ?? e?.message ?? e}`);
    }
  }
  return { changed, log, errors };
}

/** Removes our symlinks for a skill (disabling it). Locations stay recorded for re-enabling. */
export function unlinkSkill(registry: string, name: string) {
  for (const sd of skillDirs()) {
    for (const n of [name, `${name}-tether`]) {
      const p = join(sd.dir, n);
      if (isOurLink(p, registry)) unlinkSync(p);
    }
  }
}

/**
 * Undoes the skill sync (turning the master context off): every symlink of ours goes away. Where
 * it had replaced the user's own copy, a real copy of the current registry version is put back,
 * so each harness keeps the skills it had; the backups stay where they are.
 */
export function unlinkAll(registry: string, meta: SkillMeta): { restored: string[]; removed: string[]; errors: string[] } {
  const replaced = new Set(Object.values(meta).flatMap((m) => (m.links ?? []).filter((l) => l.replaced).map((l) => untildePath(l.path))));
  const out = { restored: [] as string[], removed: [] as string[], errors: [] as string[] };
  for (const sd of skillDirs()) {
    let names: string[] = [];
    try {
      names = readdirSync(sd.dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(sd.dir, n);
      if (!isOurLink(p, registry)) continue;
      try {
        const target = resolve(dirname(p), readlinkSync(p));
        if (replaced.has(p) && isSkill(target)) {
          const tmp = `${p}.tether-tmp-${process.pid}`;
          rmSync(tmp, { recursive: true, force: true });
          cpSync(target, tmp, { recursive: true, dereference: true });
          unlinkSync(p);
          renameSync(tmp, p);
          out.restored.push(p);
        } else {
          unlinkSync(p);
          out.removed.push(p);
        }
      } catch (e: any) {
        out.errors.push(`${tilde(p)}: ${e?.code ?? e?.message ?? e}`);
      }
    }
  }
  // Skills disabled earlier have no link any more, but if they had replaced the user's own copy,
  // that copy has to come back too.
  for (const [name, m] of Object.entries(meta)) {
    for (const l of m.links ?? []) {
      const p = untildePath(l.path);
      const src = join(registry, name);
      if (!l.replaced || existsSync(p) || isLink(p) || !isSkill(src)) continue;
      try {
        const tmp = `${p}.tether-tmp-${process.pid}`;
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(dirname(p), { recursive: true });
        cpSync(src, tmp, { recursive: true, dereference: true });
        renameSync(tmp, p);
        out.restored.push(p);
      } catch (e: any) {
        out.errors.push(`${tilde(p)}: ${e?.code ?? e?.message ?? e}`);
      }
    }
  }
  for (const m of Object.values(meta)) delete m.links;
  // Skill dirs that only exist because of our links (e.g. ~/.agents/skills): gone if now empty.
  const created = readCreatedDirs(registry);
  for (const d of [...created].sort((a, b) => b.length - a.length)) {
    try {
      if (!readdirSync(d).length) rmdirSync(d);
    } catch {}
  }
  rmSync(createdDirsFile(registry), { force: true });
  return out;
}

const createdDirsFile = (registry: string) => join(dirname(registry), "skill-dirs.json");

function readCreatedDirs(registry: string): string[] {
  try {
    return JSON.parse(readFileSync(createdDirsFile(registry), "utf8")).map(untildePath);
  } catch {
    return [];
  }
}

/** mkdir -p that records each directory it had to create (for unlinkAll). */
function mkdirRecorded(registry: string, dir: string) {
  const made: string[] = [];
  for (let d = dir; !existsSync(d) && d !== dirname(d); d = dirname(d)) made.push(d);
  if (!made.length) return;
  mkdirSync(dir, { recursive: true });
  const all = new Set(readCreatedDirs(registry).map(tilde));
  for (const d of made) all.add(tilde(d));
  writeAtomic(createdDirsFile(registry), JSON.stringify([...all], null, 1));
}

/** skills.json in the store: provenance, drift, link locations and the enable switch per skill. */
export type SkillMeta = Record<
  string,
  {
    sources: { harness: string; path: string }[];
    drift?: string[];
    disabled?: boolean;
    /** symlinks we made (`~/…`); `replaced`: it took the place of the user's own copy */
    links?: { path: string; replaced: boolean }[];
  }
>;

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
    names = readdirSync(registry).filter((n) => !n.startsWith(".") && !n.includes(".tether-") && isSkill(join(registry, n)));
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
