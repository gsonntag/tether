// Pieces several connectors share.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SkillDir } from "../context/skills";
import { harness } from "../context/paths";
import { secretEnv } from "../secrets";
import type { CapabilityLevel, SessionLaunch, Slot, SlotCapability } from "./types";

export const cap = (level: CapabilityLevel, note: string): SlotCapability => ({ level, note });

/** A slot Tether doesn't map yet: only its capability, for the matrix. */
export const slot = (level: CapabilityLevel, note: string): Slot => ({ capability: () => cap(level, note) });

/** The project folder and its parents up to the repo root (or /), nearest first. */
export function upward(projectPath: string): string[] {
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

/** `<dir>/<sub>` for the project folder and each parent up to the repo root, as repo skill dirs. */
export function repoDirs(projectPath: string, sub: string) {
  const up = upward(projectPath);
  return up.map((d) => ({ dir: join(d, sub), source: "repo", root: up[up.length - 1] }));
}

/** Your secrets (secrets.ts) in the harness process's environment; adapters add them at spawn (agentEnv). */
export const envSlot = (note: string): Slot => ({
  capability: () => cap("native", note),
  forSession: () => {
    const env = secretEnv();
    return Object.keys(env).length ? { env } : undefined;
  },
});

/** ~/.agents/skills: shared by Codex, pi and opencode; every registry skill is linked in. */
export const agentsSkillDir = (): SkillDir => ({ harness: "agents", dir: harness.agentsSkills(), install: true, skip: [] });

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Slot contributions in slot order: args in order, env merged, options merged one level deep (two
 * slots may both add to Codex's `config`), preambles joined.
 */
export function mergeLaunch(parts: (Partial<SessionLaunch> | undefined)[]): SessionLaunch {
  const out: SessionLaunch = { args: [], options: {}, env: {} };
  for (const p of parts) {
    if (!p) continue;
    if (p.args) out.args.push(...p.args);
    if (p.env) Object.assign(out.env, p.env);
    for (const [k, v] of Object.entries(p.options ?? {})) {
      const cur = out.options[k];
      out.options[k] = plain(cur) && plain(v) ? { ...cur, ...v } : Array.isArray(cur) && Array.isArray(v) ? [...cur, ...v] : v;
    }
    if (p.preamble) out.preamble = out.preamble ? `${out.preamble}\n\n${p.preamble}` : p.preamble;
  }
  return out;
}

/** One of pi's packages (settings.json `packages`: "npm:pi-mcp-adapter", a git URL, …) is installed. */
export function piHasPackage(name: string): boolean {
  try {
    const settings = JSON.parse(readFileSync(harness.piSettings(), "utf8"));
    const re = new RegExp(`(^|[:/])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(@|$|/|\\.git)`);
    return (settings.packages ?? []).some((p: unknown) => {
      const src = typeof p === "string" ? p : (p as any)?.source;
      return typeof src === "string" && re.test(src);
    });
  } catch {
    return false;
  }
}
