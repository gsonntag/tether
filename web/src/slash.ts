import type { SlashCommand } from "./shared/protocol";
import { fuzzyFilter } from "./shared/skill";

/** What `/` in the message box is completing: the word after it, or null when the menu is closed. */
export function slashQuery(text: string): string | null {
  return text.startsWith("/") && !/\s/.test(text) ? text.slice(1) : null;
}

const MAX = 40;

/** The `/` menu for `query`: skills, then the harness's commands, each best match first. */
export function slashGroups(items: SlashCommand[], query: string): { skills: SlashCommand[]; commands: SlashCommand[]; flat: SlashCommand[] } {
  const skills = fuzzyFilter(items.filter((c) => c.kind === "skill"), query).slice(0, MAX);
  const commands = fuzzyFilter(items.filter((c) => c.kind !== "skill"), query).slice(0, MAX);
  return { skills, commands, flat: [...skills, ...commands] };
}
