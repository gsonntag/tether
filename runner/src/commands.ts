// Tether's command library (docs/harness-platform.md, Phase 2 "later slots"): your custom `/`
// commands, prompt templates by another name, imported read-only from every harness that has them
// and offered as `/name` in every session's `/` menu:
//
//   Claude Code   ~/.claude/commands/**/*.md          ($ARGUMENTS, $ARGUMENTS[N], $N from 0)
//   Codex         ~/.codex/prompts/*.md               (older Codex; $1…$9, $ARGUMENTS)
//   opencode      ~/.config/opencode/command(s)/*.md and its config's `command` map ($ARGUMENTS, $1…)
//   pi            ~/.pi/agent/prompts/*.md            ($1, $@, $ARGUMENTS, ${1:-default}, ${@:N:L})
//
// Kept in the runner's config dir (commands.json, mode 600); never written into a repo or a
// harness's own command dirs. When you send `/name args` a harness that has the command itself (it
// lists it: its own file, or one Tether passed it for the session, like pi's --prompt-template and
// opencode's inline config) runs it natively; otherwise Tether expands the template, with the
// arguments filled in the way the harness it came from would (`style`), and sends the result.
// Shell lines (`!` + backtick) and `@file` references are left as written when Tether expands.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "jsonc-parser";
import type { CommandFindResult, HarnessId, LibraryCommandView } from "../../web/src/shared/protocol";
import { splitFrontMatter } from "./context/format";
import { opencodeConfigPath } from "./context/globalMcp";
import { configDir, harness, home, tilde } from "./context/paths";
import { writeAtomic } from "./context/store";
import { isEntryName, Library, mdFiles, rawFrontMatter, type LibraryEntry } from "./library";

/** How arguments fill a template: Claude Code's ($N from 0) or the shell-like one (pi, Codex, opencode: $1 is the first). */
export type ArgStyle = "claude" | "shell";

export interface StoredCommand extends LibraryEntry {
  /** the template, front matter removed */
  body: string;
  argumentHint?: string;
  /** the model its file asked for (shown only; not every harness can take it) */
  model?: string;
  style: ArgStyle;
}

type Found = Omit<StoredCommand, "id" | "enabled" | "addedAt">;

export const commandsFile = () => join(configDir(), "commands.json");

const valid = (v: any): v is StoredCommand => !!v && typeof v.name === "string" && typeof v.body === "string" && typeof v.id === "string";
export const commandLib = new Library<StoredCommand>(commandsFile, "cmd", valid);

/** The enabled commands. */
export const libraryCommands = (): StoredCommand[] => commandLib.load().items.filter((c) => c.enabled);

// ---------------- reading command files ----------------

const firstLine = (body: string) =>
  body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"))
    ?.slice(0, 200) ?? "";

/** A template that uses the shell-like forms only pi and opencode know. */
const shellish = (body: string) => /\$@|\$\{@|\$\{\d+:-/.test(body);

/** One command file. `style`: whose argument rules it was written for (undefined: worked out from the text). */
export function parseCommand(text: string, name: string, source: string, style?: ArgStyle): Found | undefined {
  if (!isEntryName(name)) return undefined;
  const { fm, body } = splitFrontMatter(text);
  if (!body.trim()) return undefined;
  const description = typeof fm.description === "string" && fm.description.trim() ? fm.description.trim().slice(0, 300) : firstLine(body);
  const argumentHint = rawFrontMatter(text, "argument-hint");
  const model = typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : undefined;
  return { name, description, body, style: style ?? (shellish(body) ? "shell" : "claude"), sources: [source], ...(argumentHint ? { argumentHint } : {}), ...(model ? { model } : {}) };
}

const read = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

const fromDir = (dir: string, harnessName: string, style: ArgStyle, depth = 0): Found[] =>
  mdFiles(dir, depth).flatMap((f) => {
    const text = read(f);
    const c = text !== undefined ? parseCommand(text, basename(f, ".md"), `${harnessName}:${tilde(f)}`, style) : undefined;
    return c ? [c] : [];
  });

export const claudeCommandsDir = () => join(harness.claudeDir(), "commands");
export const codexPromptsDir = () => join(harness.codexDir(), "prompts");
export const piPromptsDir = () => join(home(), ".pi", "agent", "prompts");
export const opencodeCommandDirs = () => [join(harness.opencodeDir(), "command"), join(harness.opencodeDir(), "commands")];

/** opencode's config `command` map ({ name: { template, description } }). */
function opencodeConfigCommands(): Found[] {
  const path = opencodeConfigPath();
  const text = read(path);
  if (!text) return [];
  const cfg = parse(text, [], { allowTrailingComma: true });
  const map = cfg?.command;
  if (!map || typeof map !== "object") return [];
  const out: Found[] = [];
  for (const [name, c] of Object.entries(map as Record<string, any>)) {
    if (!isEntryName(name) || typeof c?.template !== "string" || !c.template.trim()) continue;
    out.push({ name, description: typeof c.description === "string" ? c.description : firstLine(c.template), body: c.template.trim(), style: "shell", sources: [`opencode:${tilde(path)}`] });
  }
  return out;
}

/** Every harness's own commands, read only. Claude Code's subfolders only group (the name is the file's). */
export function scanCommands(): Found[] {
  return [
    ...fromDir(claudeCommandsDir(), "claude", "claude", 2),
    ...fromDir(codexPromptsDir(), "codex", "shell"),
    ...opencodeCommandDirs().flatMap((d) => fromDir(d, "opencode", "shell")),
    ...opencodeConfigCommands(),
    ...fromDir(piPromptsDir(), "pi", "shell"),
  ];
}

// ---------------- arguments ----------------

/** Arguments split like a shell: quotes group, a backslash escapes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | undefined;
  let any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (q) {
      if (ch === q) q = undefined;
      else if (ch === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      any = true;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = "";
      any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

/**
 * The template with `args` filled in.
 *   claude: `$ARGUMENTS` is everything typed, `$ARGUMENTS[N]` and `$N` one argument counting from 0.
 *   shell:  `$1`… one argument counting from 1, `$@` / `$ARGUMENTS` all of them, `${1:-default}`,
 *           `${@:-default}`, `${@:N}`, `${@:N:L}`, `$$` a dollar sign.
 * A template that uses none of them gets the arguments after it ("ARGUMENTS: …"), as Claude Code does.
 */
export function expandCommand(c: Pick<StoredCommand, "body" | "style">, args: string): string {
  const parts = splitArgs(args);
  let used = false;
  let out: string;
  if (c.style === "claude") {
    out = c.body.replace(/\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS|\$(\d+)(?!\w)/g, (_m, i?: string, n?: string) => {
      used = true;
      if (i !== undefined) return parts[Number(i)] ?? "";
      if (n !== undefined) return parts[Number(n)] ?? "";
      return args;
    });
  } else {
    out = c.body.replace(/\$\$|\$\{@:(\d+)(?::(\d+))?\}|\$\{@:-([^}]*)\}|\$\{(\d+):-([^}]*)\}|\$@|\$ARGUMENTS|\$([1-9]\d*)/g, (m, from?: string, len?: string, allDef?: string, n?: string, def?: string, pos?: string) => {
      if (m === "$$") return "$";
      used = true;
      if (from !== undefined) {
        const start = Math.max(0, Number(from) - 1);
        return parts.slice(start, len !== undefined ? start + Number(len) : undefined).join(" ");
      }
      if (allDef !== undefined) return parts.length ? parts.join(" ") : allDef;
      if (n !== undefined) return parts[Number(n) - 1] || def || "";
      if (pos !== undefined) return parts[Number(pos) - 1] ?? "";
      return parts.join(" ");
    });
  }
  return !used && args.trim() ? `${out.trimEnd()}\n\nARGUMENTS: ${args.trim()}` : out;
}

/**
 * Whether pi fills this template the way its author meant: shell-style ones, and Claude-style ones
 * that only use `$ARGUMENTS` (pi doesn't append unused arguments, nor count from 0).
 */
export function shellCompatible(c: Pick<StoredCommand, "body" | "style">): boolean {
  if (c.style === "shell") return true;
  return /\$ARGUMENTS(?!\[)/.test(c.body) && !/\$ARGUMENTS\[\d+\]|\$\d+(?!\w)/.test(c.body);
}

/**
 * Whether opencode fills this template the way its author meant. opencode 1.18.35
 * (SessionPrompt.command) knows only `$ARGUMENTS` (everything typed) and `$1`…`$N`, where the
 * highest one takes the rest of the arguments, and appends the arguments to a template with
 * neither. So: templates whose only placeholder is `$ARGUMENTS`, or that have none; positional
 * ones and the shell forms (`$@`, `${…}`, `$$`) are filled in by Tether.
 */
export function opencodeCompatible(c: Pick<StoredCommand, "body" | "style">): boolean {
  return !/\$ARGUMENTS\[|\$\d|\$@|\$\{|\$\$/.test(c.body);
}

// ---------------- what a session gets ----------------

/**
 * pi: the enabled commands it can fill itself, as prompt-template files for `--prompt-template`
 * (in the runner's config dir, rewritten at each launch). Ones pi already has in its own prompts dir
 * are left to it.
 */
export function piPromptTemplates(): string[] {
  const own = new Set(mdFiles(piPromptsDir()).map((f) => basename(f, ".md")));
  const dir = join(configDir(), "run", "pi-prompts");
  const out: string[] = [];
  for (const c of libraryCommands()) {
    if (own.has(c.name) || !shellCompatible(c)) continue;
    const fm = [`description: ${JSON.stringify(c.description)}`, ...(c.argumentHint ? [`argument-hint: ${JSON.stringify(c.argumentHint)}`] : [])];
    const path = join(dir, `${c.name}.md`);
    try {
      writeAtomic(path, `---\n${fm.join("\n")}\n---\n${c.body}\n`, 0o600);
      out.push(path);
    } catch (e: any) {
      console.error(`commands: couldn't write pi's template for ${c.name}: ${e?.message ?? e}`);
    }
  }
  return out;
}

/** opencode's inline `command` map: the enabled commands it fills the same way (opencodeCompatible). */
export function opencodeCommands(): Record<string, { template: string; description: string }> {
  const own = new Set([...opencodeCommandDirs().flatMap((d) => mdFiles(d).map((f) => basename(f, ".md"))), ...opencodeConfigCommands().map((c) => c.name)]);
  const out: Record<string, { template: string; description: string }> = {};
  for (const c of libraryCommands()) if (opencodeCompatible(c) && !own.has(c.name)) out[c.name] = { template: c.body, description: c.description };
  return out;
}

/** `/name args` for a library command, when the harness can't run it itself: the filled-in template. */
export function resolveCommand(name: string, args: string, commands: StoredCommand[], native: Set<string>): string | undefined {
  const c = commands.find((x) => x.name === name);
  if (!c || native.has(name)) return undefined;
  return expandCommand(c, args);
}

/**
 * When the harness can't say which commands it has: Claude Code's command files (its own dirs and
 * the project's), pi's prompts and the templates Tether passed it; nothing for the others.
 */
export function offlineNativeCommands(h: HarnessId, projectPath: string): Set<string> {
  const names = (files: string[]) => files.map((f) => basename(f, ".md"));
  if (h === "claude-code") return new Set([...names(mdFiles(claudeCommandsDir(), 2)), ...names(mdFiles(join(projectPath, ".claude", "commands"), 2))]);
  if (h === "pi") return new Set([...names(mdFiles(piPromptsDir())), ...libraryCommands().filter(shellCompatible).map((c) => c.name)]);
  return new Set();
}

// ---------------- the web app ----------------

function view(c: StoredCommand): LibraryCommandView {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    body: c.body,
    ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
    style: c.style,
    enabled: c.enabled,
    sources: c.sources,
  };
}

export function listLibraryCommands(): LibraryCommandView[] {
  return commandLib
    .load()
    .items.map(view)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const same = (a: StoredCommand, b: Found) => a.body.trim() === b.body.trim();

/** "Find commands" and the master context's Import: every harness's command files, read only. */
export async function importCommands(): Promise<CommandFindResult> {
  const warnings: string[] = [];
  const found = scanCommands();
  const added = found.length ? await commandLib.mutate((d) => commandLib.merge(d, found, same, false, warnings)) : [];
  return { commands: listLibraryCommands(), added, warnings };
}

/**
 * A command you add or edit: a name and the template (front matter optional, as in a command file).
 * `style` defaults to Claude Code's argument rules unless the text uses the shell-like forms.
 */
export async function addLibraryCommand(name: string, text: string, style?: ArgStyle): Promise<LibraryCommandView[]> {
  const n = name.trim().replace(/^\//, "") || (splitFrontMatter(text).fm.name as string | undefined)?.toString().trim() || "";
  if (!isEntryName(n)) throw new Error("Give it a name: letters, digits, dashes and underscores, like fix-issue.");
  const c = parseCommand(text, n, "you", style);
  if (!c) throw new Error("The command has no text.");
  await commandLib.mutate((d) => commandLib.merge(d, [c], same, true, []));
  return listLibraryCommands();
}

export async function setLibraryCommand(id: string, change: { enabled?: boolean; remove?: boolean }): Promise<LibraryCommandView[]> {
  await commandLib.set(id, change);
  return listLibraryCommands();
}
