// What Claude Code offers a session (SPEC §9 Commands). A live session asks its own process;
// otherwise a throwaway process in the session's folder is asked (no prompt, nothing saved).

import { query, type SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { open } from "node:fs/promises";
import { needsTerminal, settingRoute, type CommandRoute, type HarnessCommand } from "../../../../shared/commands";
import { CLAUDE_BIN } from "./bin";
import { claudeAuthSettings, claudeEnv } from "./credentials";

/**
 * Argument hints Claude Code can't report: it lists /goal's non-interactive form, which has none,
 * though the command takes a condition (2.1.316).
 */
const ARG_HINTS: Record<string, string> = { goal: "[<condition> | clear]" };

/**
 * Commands that change Claude Code's account or global settings, which Tether never runs from the
 * chat. Not reported as such by Claude Code: /config is listed like any other, and the rest aren't
 * listed at all.
 */
const TERMINAL_ONLY = new Set(["config", "settings", "login", "logout", "install", "plugin", "plugins"]);

export function claudeCommandRoute(name: string, args: string): CommandRoute | undefined {
  return TERMINAL_ONLY.has(name) ? { terminal: true } : settingRoute(name, args);
}

export { needsTerminal };

/** Claude Code's list as the menu shows it. `terminal`: what the init message says only suits a terminal. */
export function commandList(list: SlashCommand[], skills: ReadonlySet<string>, terminal: ReadonlySet<string> = new Set()): HarnessCommand[] {
  const out = new Map<string, HarnessCommand>();
  for (const c of list) {
    if (!c.name || c.name.startsWith("__") || TERMINAL_ONLY.has(c.name) || terminal.has(c.name)) continue;
    // Rows can share a name: the marked row is the one /name runs.
    if (out.has(c.name) && !c.builtin) continue;
    const args = c.argumentHint || ARG_HINTS[c.name];
    out.set(c.name, {
      name: c.name,
      description: c.description.replace(/\s+/g, " ").trim(),
      ...(args ? { args } : {}),
      ...(skills.has(c.name) ? { skill: true } : {}),
      ...(c.aliases?.length ? { aliases: c.aliases } : {}),
    });
  }
  return [...out.values()];
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; list: Promise<HarnessCommand[]> }>();

/** The list for a folder with no live process. */
export function claudeCommands(projectPath: string): Promise<HarnessCommand[]> {
  const had = cache.get(projectPath);
  if (had && Date.now() - had.at < CACHE_MS) return had.list;
  const list = fetchCommands(projectPath);
  cache.set(projectPath, { at: Date.now(), list });
  list.catch(() => cache.delete(projectPath));
  return list;
}

async function fetchCommands(cwd: string): Promise<HarnessCommand[]> {
  async function* idle(): AsyncGenerator<never> {
    await new Promise(() => {});
  }
  const q = query({
    prompt: idle(),
    options: { cwd, persistSession: false, tools: [], settingSources: ["user", "project", "local"], settings: claudeAuthSettings(), systemPrompt: { type: "preset", preset: "claude_code" }, env: claudeEnv(), pathToClaudeCodeExecutable: CLAUDE_BIN } as any,
  });
  try {
    const timeout = Bun.sleep(20_000).then(() => Promise.reject(new Error("Claude Code didn't list its commands.")));
    const [list, skills] = await Promise.race([Promise.all([q.supportedCommands(), q.reloadSkills().catch(() => ({ skills: [] }))]), timeout]);
    return commandList(list, new Set(skills.skills.map((s) => s.name)));
  } finally {
    try {
      q.close();
    } catch {}
  }
}

/** How a /goal stands in the session's store: its last evaluation, newest first in the tail. */
export async function lastGoalStatus(file: string | undefined): Promise<{ uuid: string; met: boolean; reason: string } | undefined> {
  if (!file) return undefined;
  const f = await open(file, "r").catch(() => undefined);
  if (!f) return undefined;
  try {
    const { size } = await f.stat();
    const length = Math.min(size, 256 * 1024);
    const { buffer } = await f.read(Buffer.alloc(length), 0, length, size - length);
    for (const line of buffer.toString("utf8").split("\n").reverse()) {
      if (!line.includes('"goal_status"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.attachment?.type === "goal_status" && !e.attachment.sentinel) return { uuid: e.uuid, met: !!e.attachment.met, reason: String(e.attachment.reason ?? "") };
      } catch {}
    }
    return undefined;
  } finally {
    await f.close();
  }
}
