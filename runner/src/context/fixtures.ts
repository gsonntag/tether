// Fixture homes for the context tests, modeled on real harness layouts.

import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resetHome } from "./testenv";

export function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export const claudeMemory = (name: string, description: string, type: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;

/** A home with Claude auto-memory (one global project, one repo), global instruction files and a Codex DB. */
export function seedHome(): { home: string; repo: string } {
  resetHome();
  const home = process.env.HOME!;
  const repo = join(home, "proj");
  mkdirSync(repo, { recursive: true });
  const globalDir = join(home, ".claude", "projects", home.replace(/[/.]/g, "-"), "memory");
  put(join(globalDir, "MEMORY.md"), "- [User background](user-background.md) — ex AWS\n");
  put(join(globalDir, "user-background.md"), claudeMemory("user-background", "former AWS KMS intern; strong on auth", "user", "Former AWS KMS intern and Cognito developer."));
  const repoDir = join(home, ".claude", "projects", repo.replace(/[/.]/g, "-"));
  put(join(repoDir, "s1.jsonl"), JSON.stringify({ type: "user", cwd: repo }) + "\n");
  put(join(repoDir, "memory", "deploy-flow.md"), claudeMemory("deploy-flow", "deploys go through fol deploy from the repo root", "project", "Deploy with `fol deploy` from the repo root."));
  put(join(home, ".claude", "CLAUDE.md"), "# Global Guidance\n\n## Skills\n\n- grill-me: relentless design interviews.\n");
  put(join(home, ".codex", "AGENTS.md"), "## Tooling\n\nPrefer bun over npm for scripts.\n");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  return { home, repo };
}

export function seedCodexDb(rows: { thread: string; raw: string; summary?: string; at: number }[]) {
  const p = join(process.env.HOME!, ".codex", "memories_1.sqlite");
  mkdirSync(dirname(p), { recursive: true });
  const db = new Database(p, { create: true });
  db.run(`CREATE TABLE IF NOT EXISTS stage1_outputs (thread_id TEXT PRIMARY KEY, source_updated_at INTEGER NOT NULL, raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, rollout_slug TEXT, generated_at INTEGER NOT NULL)`);
  for (const r of rows) db.run(`INSERT OR REPLACE INTO stage1_outputs VALUES (?, ?, ?, ?, NULL, ?)`, [r.thread, r.at, r.raw, r.summary ?? "", r.at]);
  db.close();
}
