import { resetHome } from "./testenv";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { put } from "./fixtures";
import { harness } from "./paths";
import { applySkillPlan, isOurLink, listSkills, planSkills, type SkillMeta } from "./skills";

let home: string;
let registry: string;
let backup: string;

const skill = (dir: string, name: string, body: string, mtime?: number) => {
  put(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);
  if (mtime) utimesSync(join(dir, name, "SKILL.md"), mtime, mtime);
};

beforeEach(() => {
  resetHome();
  home = process.env.HOME!;
  registry = join(home, ".config", "tether", "context", "skills");
  backup = join(home, ".config", "tether", "context", "backup", "2026-10-10");
  // Claude: an older copy of "grill", a claude.ai-synced dir that must be left alone.
  skill(harness.claudeSkills(), "grill", "old instructions", 1_000_000);
  put(join(harness.claudeSkills(), "synced", "abc", "SKILL.md"), "synced");
  // Codex: a newer, different "grill", a builtin, and a skill named like the builtin elsewhere.
  skill(harness.codexSkills(), "grill", "new instructions", 2_000_000);
  skill(join(harness.codexSkills(), ".system"), "skill-creator", "builtin");
  skill(harness.geminiSkills(), "skill-creator", "user's own skill-creator", 1_500_000);
  mkdirSync(harness.agySkills(), { recursive: true });
});

describe("skill registry", () => {
  test("plan: newest copy wins, drift recorded, skip-listed dirs untouched", () => {
    const plan = planSkills(registry, backup);
    const grill = plan.skills.find((s) => s.name === "grill")!;
    expect(grill.from?.harness).toBe("codex");
    expect(grill.drift).toEqual(["~/.claude/skills/grill"]);
    expect(plan.skills.map((s) => s.name).sort()).toEqual(["grill", "skill-creator"]);
    expect(plan.backups.map((b) => b.path).some((p) => p.includes("synced") || p.includes(".system"))).toBe(false);
    // Builtin name: exposed as -tether in dirs where it is new.
    const sc = plan.skills.find((s) => s.name === "skill-creator")!;
    expect(sc.exposedAs).toBe("skill-creator-tether");
    expect(plan.symlinks.some((l) => l.path === join(harness.agentsSkills(), "skill-creator-tether"))).toBe(true);
  });

  test("apply: originals backed up, then replaced by symlinks into the registry", () => {
    const meta: SkillMeta = {};
    const plan = planSkills(registry, backup);
    const { changed } = applySkillPlan(registry, plan, meta);
    expect(changed).toContain(join(registry, "grill"));
    expect(readFileSync(join(registry, "grill", "SKILL.md"), "utf8")).toContain("new instructions");
    // Both originals are in the backup, by source dir.
    expect(readFileSync(join(backup, ".claude-skills", "grill", "SKILL.md"), "utf8")).toContain("old instructions");
    expect(readFileSync(join(backup, ".codex-skills", "grill", "SKILL.md"), "utf8")).toContain("new instructions");
    // Symlinks in every install dir, and in place of the replaced copies.
    for (const d of [harness.claudeSkills(), harness.agentsSkills(), harness.agySkills(), harness.geminiSkills(), harness.codexSkills()]) {
      const p = join(d, "grill");
      expect(lstatSync(p).isSymbolicLink()).toBe(true);
      expect(readlinkSync(p)).toBe(join(registry, "grill"));
    }
    // Not installed into dirs that only had nothing (pi, opencode) — ~/.agents/skills covers them.
    expect(existsSync(join(harness.piSkills(), "grill"))).toBe(false);
    // Skip-listed content untouched.
    expect(readFileSync(join(harness.claudeSkills(), "synced", "abc", "SKILL.md"), "utf8")).toBe("synced");
    expect(existsSync(join(harness.codexSkills(), ".system", "skill-creator", "SKILL.md"))).toBe(true);
    expect(meta.grill!.drift).toEqual(["~/.claude/skills/grill"]);
    expect(meta.grill!.sources.map((s) => s.harness).sort()).toEqual(["claude", "codex"]);
    // A second pass has nothing to do.
    const again = planSkills(registry, backup);
    expect(again.backups).toEqual([]);
    expect(again.symlinks).toEqual([]);
    expect(again.skills.every((s) => !s.from)).toBe(true);
  });

  test("a disabled skill is neither backed up nor linked", () => {
    const plan = planSkills(registry, backup, new Set(["grill"]));
    expect(plan.backups.some((b) => b.skill === "grill")).toBe(false);
    expect(plan.symlinks.some((l) => l.path.endsWith("/grill"))).toBe(false);
  });

  test("links that aren't ours are treated as copies (backed up, not followed into deletion)", () => {
    const elsewhere = join(home, "dotfiles", "skills");
    skill(elsewhere, "mine", "dotfiles skill");
    mkdirSync(harness.claudeSkills(), { recursive: true });
    symlinkSync(join(elsewhere, "mine"), join(harness.claudeSkills(), "mine"));
    const plan = planSkills(registry, backup);
    applySkillPlan(registry, plan, {});
    expect(isOurLink(join(harness.claudeSkills(), "mine"), registry)).toBe(true);
    expect(readFileSync(join(elsewhere, "mine", "SKILL.md"), "utf8")).toContain("dotfiles skill"); // target intact
    expect(lstatSync(join(backup, ".claude-skills", "mine")).isSymbolicLink()).toBe(true); // the old link itself
  });

  test("list: registry skills with provenance, plus repo skills left in place", () => {
    const meta: SkillMeta = {};
    applySkillPlan(registry, planSkills(registry, backup), meta);
    const repo = join(home, "proj");
    skill(join(repo, ".claude", "skills"), "repo-only", "x");
    const list = listSkills(registry, { ...meta, grill: { ...meta.grill!, disabled: true } }, [repo]);
    const grill = list.find((s) => s.name === "grill")!;
    expect(grill).toMatchObject({ enabled: false, description: "grill skill" });
    expect(list.find((s) => s.name === "skill-creator")!.exposedAs).toBe("skill-creator-tether");
    expect(list.find((s) => s.name === "repo-only")).toMatchObject({ repo, enabled: true });
  });
});
