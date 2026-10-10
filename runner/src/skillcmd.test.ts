import { HOME, resetHome } from "./testenv";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextSkill } from "../../web/src/shared/protocol";
import { displayText, invocationText, parseInvocation, splitSkills } from "../../web/src/shared/skill";
import { userParts } from "../../web/src/shared/bash";
import { codexInput } from "./adapters/codex";
import { harness } from "./context/paths";
import { decide, expandSkill, resolveMessage, sessionSkills, skillFiles, slashMenu, type ResolveContext } from "./skillcmd";

// The shared scratch HOME (src/testenv.ts), emptied before each test. Real skill dirs are never
// read or written.
const home = HOME;
let repo: string;

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const skill = (dir: string, name: string, body = `Do the ${name} thing.`) =>
  put(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}\n`);

beforeEach(() => {
  resetHome();
  repo = join(home, "work", "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  skill(join(repo, ".agents", "skills"), "haiku");
  put(join(repo, ".agents", "skills", "haiku", "scripts", "count.sh"), "wc -w\n");
  put(join(repo, ".agents", "skills", "haiku", "notes.md"), "notes\n");
  skill(join(repo, ".claude", "skills"), "claude-only");
  skill(harness.claudeSkills(), "grill");
  put(join(harness.claudeSkills(), "synced", "x", "SKILL.md"), "claude.ai-owned");
  skill(harness.codexSkills(), "cx-skill");
  skill(harness.agentsSkills(), "shared");
  skill(harness.piSkills(), "pi-skill");
});

describe("parseInvocation", () => {
  test("/name and /name args", () => {
    expect(parseInvocation("/haiku")).toEqual({ name: "haiku", args: "" });
    expect(parseInvocation("/haiku  about  the sea \n")).toEqual({ name: "haiku", args: "about  the sea" });
    expect(parseInvocation("/haiku\nline two")).toEqual({ name: "haiku", args: "line two" });
    expect(parseInvocation("/vercel:deploy prod")).toEqual({ name: "vercel:deploy", args: "prod" });
  });
  test("not an invocation", () => {
    expect(parseInvocation("hello /haiku")).toBeUndefined();
    expect(parseInvocation("/usr/bin/env is broken")).toBeUndefined();
    expect(parseInvocation("/")).toBeUndefined();
    expect(parseInvocation("/ haiku")).toBeUndefined();
    expect(parseInvocation(" /haiku")).toBeUndefined();
  });
  test("a backslash escapes the slash", () => {
    expect(parseInvocation("\\/haiku is a skill")).toEqual({ literal: "/haiku is a skill" });
  });
  test("invocationText round-trips", () => {
    expect(invocationText("a", "")).toBe("/a");
    expect(invocationText("a", "b c")).toBe("/a b c");
  });
});

describe("discovery", () => {
  test("without the master context: repo skills from both conventions + the harness's own dirs", () => {
    const names = (h: Parameters<typeof sessionSkills>[0]) => sessionSkills(h, repo).map((s) => s.name);
    expect(names("claude-code")).toEqual(["claude-only", "grill", "haiku"]);
    expect(names("codex")).toEqual(["claude-only", "cx-skill", "haiku", "shared"]);
    expect(names("pi")).toEqual(["claude-only", "haiku", "pi-skill", "shared"]);
    const haiku = sessionSkills("codex", repo).find((s) => s.name === "haiku")!;
    expect(haiku.sources).toEqual(["repo"]);
    expect(haiku.description).toBe("haiku skill");
  });

  test("with the master context: enabled registry skills, this repo's skills only", () => {
    const registry = join(home, "registry");
    skill(registry, "grill");
    skill(registry, "off");
    skill(registry, "creator");
    const ctx: ContextSkill[] = [
      { name: "grill", sources: [{ harness: "claude", path: "~/.claude/skills/grill" }, { harness: "codex", path: "~/.codex/skills/grill" }], enabled: true },
      { name: "off", sources: [], enabled: false },
      { name: "creator", exposedAs: "creator-tether", sources: [], enabled: true },
      { name: "haiku", sources: [{ harness: "agents", path: "~/work/repo/.agents/skills/haiku" }], enabled: true, repo },
      { name: "elsewhere", sources: [{ harness: "agents", path: "~/other/.agents/skills/elsewhere" }], enabled: true, repo: join(home, "other") },
    ];
    const list = sessionSkills("antigravity", repo, { enabled: true, registry, skills: () => ctx });
    expect(list.map((s) => s.name)).toEqual(["claude-only", "creator-tether", "grill", "haiku"]);
    const grill = list.find((s) => s.name === "grill")!;
    expect(grill).toMatchObject({ dir: join(registry, "grill"), sources: ["claude", "codex"], installed: true });
    expect(list.find((s) => s.name === "creator-tether")!.dir).toBe(join(registry, "creator"));
    expect(list.find((s) => s.name === "haiku")!).toMatchObject({ dir: join(repo, ".agents/skills/haiku"), sources: ["repo"] });
  });

  test("skillFiles lists everything but SKILL.md, as absolute paths", () => {
    const dir = join(repo, ".agents/skills/haiku");
    expect(skillFiles(dir)).toEqual([join(dir, "notes.md"), join(dir, "scripts/count.sh")]);
  });
});

describe("per-harness resolution", () => {
  const haiku = () => sessionSkills("codex", repo).find((s) => s.name === "haiku")!;
  test("the live harness's answer decides", () => {
    expect(decide("claude-code", haiku(), new Set(["haiku"]), repo)).toBe("native");
    expect(decide("claude-code", haiku(), new Set(["other"]), repo)).toBe("expand");
    expect(decide("antigravity", haiku(), new Set(), repo)).toBe("expand");
  });
  test("without one, the skill's location decides", () => {
    // repo .agents/skills: Codex and pi read it, Claude Code doesn't
    expect(decide("codex", haiku(), undefined, repo)).toBe("native");
    expect(decide("pi", haiku(), undefined, repo)).toBe("native");
    expect(decide("claude-code", haiku(), undefined, repo)).toBe("expand");
    const claudeOnly = sessionSkills("claude-code", repo).find((s) => s.name === "claude-only")!;
    expect(decide("claude-code", claudeOnly, undefined, repo)).toBe("native");
    expect(decide("codex", claudeOnly, undefined, repo)).toBe("expand");
    // a skill reached through a symlink in a harness dir counts as that harness's
    const linked = join(home, "linked");
    skill(linked, "via-link");
    symlinkSync(join(linked, "via-link"), join(harness.claudeSkills(), "via-link"));
    expect(decide("claude-code", { name: "via-link", dir: join(linked, "via-link") }, undefined, repo)).toBe("native");
    // registry skills are installed into every harness dir
    expect(decide("pi", { name: "x", dir: "/nowhere", installed: true }, undefined, repo)).toBe("native");
    // no native syntax: always expanded
    expect(decide("opencode", haiku(), undefined, repo)).toBe("expand");
    expect(decide("kiro", haiku(), undefined, repo)).toBe("expand");
  });

  const ctx = (harness: ResolveContext["harness"], native?: string[]): ResolveContext => ({
    harness,
    projectPath: repo,
    skills: sessionSkills(harness, repo),
    native: native && new Set(native),
    nativeText: (n, a) => `NATIVE(${n})(${a})`,
  });

  test("resolveMessage: native, expanded, unknown, escaped", () => {
    expect(resolveMessage("/haiku the sea", ctx("pi", ["haiku"]))).toBe("NATIVE(haiku)(the sea)");
    const expanded = resolveMessage("/haiku the sea", ctx("claude-code", ["grill"]));
    expect(expanded.startsWith('<skill name="haiku" location="')).toBe(true);
    expect(expanded.endsWith("</skill>\n\nUser request: the sea")).toBe(true);
    // unknown names go as typed: they may be the harness's own commands
    expect(resolveMessage("/compact now", ctx("claude-code", []))).toBe("/compact now");
    expect(resolveMessage("plain text", ctx("claude-code", []))).toBe("plain text");
    // escaped: the backslash goes, unless the harness would run `/name` itself
    expect(resolveMessage("\\/haiku is great", ctx("claude-code", []))).toBe("/haiku is great");
    expect(resolveMessage("\\/haiku is great", ctx("claude-code", ["haiku"]))).toBe("\\/haiku is great");
  });
});

describe("expansion format", () => {
  test("SKILL.md body, its files, then the request", () => {
    const dir = join(repo, ".agents/skills/haiku");
    const text = expandSkill({ name: "haiku", dir }, "about cats");
    expect(text).toBe(
      [
        `<skill name="haiku" location="${dir}/SKILL.md">`,
        `The user invoked the "haiku" skill. Follow its instructions below for the request after this block.`,
        `References are relative to ${dir}.`,
        "Supporting files (read them with your tools when the instructions refer to them):",
        `- ${dir}/notes.md`,
        `- ${dir}/scripts/count.sh`,
        "",
        "Do the haiku thing.",
        "</skill>",
        "",
        "User request: about cats",
      ].join("\n"),
    );
    // front matter is left out; no request → no trailer
    const bare = expandSkill({ name: "haiku", dir }, "");
    expect(bare).not.toContain("description:");
    expect(bare.endsWith("</skill>")).toBe(true);
  });

  test("the transcript shows a chip and the request as typed", () => {
    const dir = join(repo, ".agents/skills/haiku");
    const text = expandSkill({ name: "haiku", dir }, "about cats");
    const parts = userParts(text, "u1");
    expect(parts.map((p) => p.type)).toEqual(["skill", "text"]);
    expect(parts[0]).toMatchObject({ type: "skill", name: "haiku", location: `${dir}/SKILL.md` });
    expect((parts[0] as any).content).toContain("Do the haiku thing.");
    expect(parts[1]).toEqual({ type: "text", text: "about cats" });
    expect(displayText(text)).toBe("/haiku about cats");
    // joined with another waiting message, and pi's own block shape
    const pi = `<skill name="x" location="/s/x/SKILL.md">\nReferences are relative to /s/x.\n\nbody\n</skill>\n\nhello`;
    expect(splitSkills(`first\n\n${pi}`).map((s) => (typeof s === "string" ? s : `[${s.name}]`))).toEqual(["first\n\n", "[x]", "hello"]);
    expect(displayText(`first\n\n${pi}`)).toBe("first\n\n/x hello");
    expect(userParts("no skill here", "u2")).toEqual([{ type: "text", text: "no skill here" }]);
    // titles: pi's native syntax, and a block cut short by a harness's session name
    expect(displayText("/skill:x hi")).toBe("/x hi");
    expect(displayText('<skill name="x" location="/s/x/SKILL.md">\nThe user invoked the "x')).toBe("/x");
  });
});

describe("menu", () => {
  test("skills first with how they run here, commands without duplicates", () => {
    const skills = sessionSkills("claude-code", repo);
    const menu = slashMenu(skills, [{ name: "compact" }, { name: "grill", description: "dup" }], new Set(["grill", "compact"]), "claude-code", repo);
    expect(menu.map((m) => `${m.kind}:${m.name}:${m.native ?? ""}`)).toEqual([
      "skill:claude-only:false",
      "skill:grill:true",
      "skill:haiku:false",
      "command:compact:",
    ]);
  });
});

describe("codex input", () => {
  test("a native skill becomes $name plus a skill item", () => {
    const paths = new Map([["haiku", "/r/.agents/skills/haiku/SKILL.md"]]);
    expect(codexInput("/haiku the sea", paths)).toEqual([
      { type: "text", text: "$haiku the sea", text_elements: [] },
      { type: "skill", name: "haiku", path: "/r/.agents/skills/haiku/SKILL.md" },
    ]);
    expect(codexInput("first\n\n/haiku", paths)[0].text).toBe("first\n\n$haiku");
    expect(codexInput("/other x", paths)).toEqual([{ type: "text", text: "/other x", text_elements: [] }]);
  });
});
