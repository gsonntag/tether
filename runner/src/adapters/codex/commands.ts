// What Codex offers a session (SPEC §9 Commands). Its skills come from the app-server (skills/list).
// Its commands are the TUI's own: the app-server has no list of them, and a "/word" in a turn is
// only text to the model, so each is a call of its own (driver.ts).

import { settingRoute, type CommandRoute, type HarnessCommand } from "../../../../shared/commands";

/** The TUI commands with an app-server call. Codex can't report these. */
export const CODEX_BUILTINS: HarnessCommand[] = [
  { name: "compact", description: "Summarize the conversation to free up context" },
  { name: "goal", description: "Set or view the goal for a long-running task", args: "[<objective> | clear | pause | resume]" },
  { name: "review", description: "Review your current changes", args: "[<instructions>]" },
];

/** TUI commands with no call in the app-server. Codex can't report these either; typed, they'd go to the model as text. */
const TERMINAL_ONLY = new Set(["apps", "approvals", "agent", "clear", "copy", "diff", "exit", "experimental", "fork", "keymap", "logout", "mcp", "mention", "new", "permissions", "plan", "plugins", "prompts", "ps", "quit", "resume", "skills", "statusline", "status", "stop", "theme", "title", "usage"]);

export function codexCommandRoute(name: string, args: string): CommandRoute | undefined {
  return TERMINAL_ONLY.has(name) ? { terminal: true } : settingRoute(name, args);
}

export interface CodexSkill {
  name: string;
  path: string;
  description?: string;
  shortDescription?: string;
  interface?: { shortDescription?: string | null } | null;
  enabled?: boolean;
}

/** skills/list's answer for one folder: the skills that are on. */
export const enabledSkills = (r: any): CodexSkill[] => ((r?.data?.[0]?.skills ?? []) as CodexSkill[]).filter((s) => s.enabled !== false);

export function commandList(skills: CodexSkill[]): HarnessCommand[] {
  const taken = new Set(CODEX_BUILTINS.map((c) => c.name));
  return [
    ...CODEX_BUILTINS,
    ...skills.filter((s) => !taken.has(s.name)).map((s) => ({ name: s.name, description: (s.interface?.shortDescription || s.shortDescription || s.description || "").replace(/\s+/g, " ").trim(), skill: true })),
  ];
}
