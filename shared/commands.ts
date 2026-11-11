// Slash commands and skills (SPEC §9 Commands): what a harness reports for a session, and how the
// text in the message box reads as one. Pure, for the runner and the page alike.

/** One entry of a session's menu. */
export interface HarnessCommand {
  /** without the slash */
  name: string;
  description: string;
  /** what it takes, as the harness words it ("<file>"): picking it waits for them */
  args?: string;
  /** a skill rather than a command */
  skill?: boolean;
  aliases?: string[];
}

/** "/name args" as a command: a path ("/tmp/x") or a word with other punctuation isn't one. */
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const m = text.trim().match(/^\/([A-Za-z0-9_][\w:.-]*)(?:\s+([\s\S]*))?$/);
  return m ? { name: m[1]!, args: (m[2] ?? "").trim() } : undefined;
}

/** What the box is searching the menu for: only "/" and the name so far, at the very start. */
export function menuQuery(text: string): string | undefined {
  return text.match(/^\/([\w:.-]*)$/)?.[1];
}

/** The entries for a search: names starting with it, then names holding it; a plugin's after the session's own. */
export function menuMatches(list: HarnessCommand[], query: string): HarnessCommand[] {
  const q = query.toLowerCase();
  const rank = (c: HarnessCommand) => {
    const name = c.name.toLowerCase();
    const others = (c.aliases ?? []).map((n) => n.toLowerCase());
    const hit = name === q ? -1 : !q || name.startsWith(q) ? 0 : others.some((n) => n.startsWith(q)) ? 1 : [name, ...others].some((n) => n.includes(q)) ? 2 : undefined;
    return hit === undefined ? -1 : hit * 2 + 2 + (c.name.includes(":") ? 1 : 0);
  };
  return list.map((c) => ({ c, r: rank(c) })).filter((x) => x.r >= 0).sort((a, b) => a.r - b.r).map((x) => x.c);
}

/** What picking an entry does: `fill` the box, or `send` it. Enter on a command that takes nothing, or typed in full, sends. */
export function menuPick(c: HarnessCommand, text: string, key: "Enter" | "Tab" | "tap"): "fill" | "send" {
  if (key === "Tab" || key === "tap") return "fill";
  return !c.args || text.trim() === `/${c.name}` ? "send" : "fill";
}

/** The Home agent's own commands (web HomeChat): both start a fresh chat, the old context dropped. */
export const HOME_COMMANDS: HarnessCommand[] = [
  { name: "new", description: "Start a new chat" },
  { name: "clear", description: "Clear the chat and start over" },
];

/** `/new` or `/clear`, alone (any case): what Home handles itself instead of sending. */
export const isHomeReset = (text: string) => /^\/(new|clear)$/i.test(text.trim());

export const needsTerminal = (name: string) => `/${name} needs the terminal.`;

/** What the core does itself with a typed command, instead of passing it on (Adapter.commandRoute). */
export type CommandRoute =
  /** one of Tether's own controls; no value: says what it's set to */
  | { setting: "model" | "effort" | "title"; value?: string }
  /** only the harness's TUI can do it */
  | { terminal: true };

/** The settings every harness shares with Tether's header. */
export function settingRoute(name: string, args: string): CommandRoute | undefined {
  if (name === "model" || name === "effort") return { setting: name, ...(args ? { value: args.split(/\s+/)[0] } : {}) };
  if (name === "rename" && args) return { setting: "title", value: args };
  return undefined;
}
