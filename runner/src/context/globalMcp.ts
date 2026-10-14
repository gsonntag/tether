// Global `tether-context` registrations in config files Tether shares with the user and the
// harness itself: Claude Code's ~/.claude.json (user-scope `mcpServers`) and opencode's
// ~/.config/opencode/opencode.json(c) (`mcp`). These files hold far more than MCP servers (Claude
// rewrites ~/.claude.json constantly; opencode configs carry comments), so the edits here are
// surgical: jsonc-parser edits touch only the one key, everything else stays byte for byte. Each
// write is atomic and keeps the file's mode; the export snapshots the original first (export.ts).
//
// Called only from the user's import (register) and from turning the context off (unregister).

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type FormattingOptions, type ParseError } from "jsonc-parser";
import { mcpLaunch, MCP_SCRIPT } from "./launch";
import { harness, tilde } from "./paths";

export const SERVER = "tether-context";

export interface GlobalMcpResult {
  dryRun?: boolean;
  written: string[];
  mcpConfigs: string[];
  warnings: string[];
}

/** Indentation of the file as it is, so inserted text matches the user's style. */
function formatting(text: string): FormattingOptions {
  const m = /\n([ \t]+)\S/.exec(text);
  const indent = m?.[1] ?? "  ";
  return { insertSpaces: !indent.includes("\t"), tabSize: indent.includes("\t") ? 1 : indent.length, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function parseConfig(text: string, jsonc: boolean): { value: any; ok: boolean } {
  if (!text.trim()) return { value: {}, ok: true };
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: jsonc, disallowComments: !jsonc });
  return { value, ok: !errors.length && !!value && typeof value === "object" && !Array.isArray(value) };
}

/** Sets (or with `value` undefined, removes) one key path, leaving the rest of the text alone. */
export function editJson(text: string, path: string[], value: unknown): string {
  const base = text.trim() ? text : "{}\n";
  const out = applyEdits(base, modify(base, path, value, { formattingOptions: formatting(base) }));
  return text.trim() || value !== undefined ? out : text;
}

/** Leading whitespace of the line `offset` is on, when nothing but whitespace precedes it there. */
function lineIndent(text: string, offset: number): string | undefined {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const lead = text.slice(start, offset);
  return /^[ \t]*$/.test(lead) ? lead : undefined;
}

/**
 * editJson for one entry among the user's own (the MCP registry's export): jsonc-parser's formatter
 * reformats whole lines around an edit, which would expand a sibling written on one line. Here an
 * entry is added after the last sibling, replaced in place, or removed together with its separator
 * only, so adding and then removing an entry gives back the same bytes. An empty object or entries
 * sharing a line get the entry compact (jsonc-parser unformatted); a missing parent goes to editJson.
 */
export function editJsonEntry(text: string, path: string[], value: unknown): string {
  const unformatted = () => applyEdits(text, modify(text, path, value, {}));
  if (value === undefined) return unformatted();
  const root = parseTree(text, [], { allowTrailingComma: true });
  const f = formatting(text);
  const unit = f.insertSpaces ? " ".repeat(f.tabSize ?? 2) : "\t";
  const pretty = (indent: string) => JSON.stringify(value, null, unit).split("\n").join(f.eol + indent);
  const cur = root && findNodeAtLocation(root, path);
  const prop = cur?.parent;
  const propIndent = prop ? lineIndent(text, prop.offset) : undefined;
  if (cur) return propIndent !== undefined ? text.slice(0, cur.offset) + pretty(propIndent) + text.slice(cur.offset + cur.length) : unformatted();
  const parent = root ? findNodeAtLocation(root, path.slice(0, -1)) : undefined;
  const last = parent?.type === "object" ? parent.children?.at(-1) : undefined;
  const indent = last ? lineIndent(text, last.offset) : undefined;
  if (parent?.type !== "object") return editJson(text, path, value);
  // An empty object, or entries sharing a line (minified JSON): compact, like the line it joins.
  if (!last || indent === undefined) return unformatted();
  const entry = `${JSON.stringify(path.at(-1))}: ${pretty(indent)}`;
  let at = last.offset + last.length;
  const comma = /^\s*,/.exec(text.slice(at, parent!.offset + parent!.length - 1)); // a trailing comma (JSONC)
  if (comma) {
    at += comma[0].length;
    return text.slice(0, at) + f.eol + indent + entry + "," + text.slice(at);
  }
  return text.slice(0, at) + "," + f.eol + indent + entry + text.slice(at);
}

const readOr = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

/** The file a (possibly symlinked, e.g. dotfile-managed) config really lives in. */
export function target(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Claude Code serializes its own ~/.claude.json writes with a proper-lockfile lock: a `<file>.lock`
 * directory, considered stale after 10s. Tether takes the same lock around its read-modify-write
 * (harmless for files nobody else locks). Returns the release function, or undefined when the
 * lock stayed busy.
 */
export function lockConfig(path: string, waitMs = 1_000): (() => void) | undefined {
  const lock = `${path}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (e: any) {
      if (e?.code !== "EEXIST") return () => {}; // can't lock here (read-only dir...): the compare below still guards
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) {
          rmSync(lock, { recursive: true, force: true }); // stale, as proper-lockfile would decide
          continue;
        }
      } catch {
        continue; // released meanwhile
      }
      if (Date.now() > deadline) return undefined;
      Bun.sleepSync(25);
    }
  }
}

/**
 * Atomic replace that keeps the file's permissions. `unchanged` is checked last, right before the
 * rename, so a concurrent writer's change is never overwritten: returns false and nothing is
 * replaced.
 */
export function writeConfigAtomic(path: string, text: string, unchanged: () => boolean = () => true): boolean {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const tmp = `${path}.tether-tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  try {
    const fd = openSync(tmp, "r");
    fsyncSync(fd);
    closeSync(fd);
    if (!unchanged()) {
      rmSync(tmp, { force: true });
      return false;
    }
    renameSync(tmp, path);
    return true;
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Read-modify-write of a config the harness itself writes (Claude rewrites ~/.claude.json all the
 * time, from every running process). Lost updates are kept out in three layers:
 *  1. Claude's own lock (`<file>.lock`, lockConfig) is held for the whole edit, so writers that
 *     take it (Claude Code does for ~/.claude.json) wait for us and we for them;
 *  2. the file is re-read and compared just before the rename (writeConfigAtomic), so a writer
 *     that skips the lock and lands between our read and our write makes us redo the edit on its
 *     text instead of being overwritten (a window of microseconds remains between that compare and
 *     the rename);
 *  3. after the rename, the result is read back: if another writer replaced it with a copy that
 *     lacks our change (a stale in-memory config written whole), the edit is retried.
 * The text outside our key is never re-serialized, so retries can't reformat anything. `what`
 * names the change in warnings (the MCP registry's export, runner/src/mcp/export.ts, uses this too).
 */
export function updateConfig(
  path: string,
  jsonc: boolean,
  edit: (text: string, cfg: any) => string | undefined,
  out: GlobalMcpResult,
  before?: (path: string) => void,
  what = "tether-context",
): boolean {
  const real = target(path);
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) Bun.sleepSync(50 * attempt);
    const text = readOr(real);
    const { value, ok } = parseConfig(text, jsonc);
    if (!ok) {
      out.warnings.push(`${tilde(path)} couldn't be parsed; change ${what} there by hand.`);
      return false;
    }
    const next = edit(text, value);
    if (next === undefined || next === text) return true;
    if (out.dryRun) {
      out.written.push(path);
      return true;
    }
    const release = lockConfig(real);
    if (!release) continue;
    let wrote: boolean;
    try {
      // Re-read under the lock: anything written before we got it is in `text` or forces a redo.
      if (readOr(real) !== text) wrote = false;
      else {
        before?.(path);
        wrote = writeConfigAtomic(real, next, () => readOr(real) === text);
      }
    } finally {
      release();
    }
    if (!wrote) continue;
    // Our change survived (a stale whole-file write by another process would have dropped it).
    const after = readOr(real);
    if (after !== next && edit(after, parseConfig(after, jsonc).value) !== undefined) continue;
    out.written.push(path);
    return true;
  }
  out.warnings.push(`${tilde(path)} kept changing; ${what} there wasn't updated. Try again in a moment.`);
  return false;
}

/** True for a server entry Tether wrote (its launcher points at our MCP script). */
export function isOurs(entry: any): boolean {
  if (!entry || typeof entry !== "object") return false;
  const parts = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].flat().map(String);
  return parts.some((p) => p === MCP_SCRIPT || p.endsWith("/context/mcp.ts"));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------- Claude Code ----------------

/** The `{"mcpServers": {...}}` shape (pi, Kiro, Antigravity). */
export function stdioEntry() {
  const l = mcpLaunch();
  return { command: l.command, args: l.args, env: l.env };
}

function claudeEntry() {
  const l = mcpLaunch();
  return { type: "stdio", command: l.command, args: l.args, env: l.env };
}

export function claudeInstalled() {
  return existsSync(harness.claudeJson()) || existsSync(harness.claudeDir());
}

// ---------------- opencode ----------------

function opencodeEntry() {
  const l = mcpLaunch();
  return { type: "local", command: [l.command, ...l.args], environment: l.env, enabled: true };
}

/** The global config file opencode reads: an existing opencode.jsonc / opencode.json, else a new opencode.json. */
export function opencodeConfigPath(): string {
  const dir = harness.opencodeDir();
  for (const f of ["opencode.jsonc", "opencode.json"]) if (existsSync(`${dir}/${f}`)) return `${dir}/${f}`;
  return `${dir}/opencode.json`;
}

// ---------------- register / unregister ----------------

export function register(path: string, key: string, want: object, jsonc: boolean, out: GlobalMcpResult, before?: (path: string) => void) {
  const done = updateConfig(
    path,
    jsonc,
    (text, cfg) => {
      const cur = cfg?.[key]?.[SERVER];
      if (cur && !isOurs(cur)) return undefined; // the user's own entry under our name
      if (same(cur, want)) return undefined;
      // A missing or non-object parent is created whole; otherwise only our entry is set.
      if (!cfg?.[key] || typeof cfg[key] !== "object") return editJson(text, [key], { [SERVER]: want });
      return editJson(text, [key, SERVER], want);
    },
    out,
    before,
  );
  if (done) out.mcpConfigs.push(path);
}

function unregister(path: string, key: string, jsonc: boolean, out: GlobalMcpResult) {
  if (!existsSync(path)) return;
  updateConfig(
    path,
    jsonc,
    (text, cfg) => {
      const parent = cfg?.[key];
      if (!parent || typeof parent !== "object" || !isOurs(parent[SERVER])) return undefined;
      // Our entry was the only one: drop the parent key too, so the file reads as before the import.
      if (Object.keys(parent).length === 1) return editJson(text, [key], undefined);
      return editJson(text, [key, SERVER], undefined);
    },
    out,
  );
}

/**
 * Registers tether-context for native Claude Code and opencode CLI sessions (installed harnesses
 * only). `before(path)` runs under the file's lock right before its first change is written (the
 * export snapshots the original there).
 */
export function registerGlobalMcp(opts: { dryRun?: boolean; before?: (path: string) => void } = {}): GlobalMcpResult {
  const out: GlobalMcpResult = { dryRun: opts.dryRun, written: [], mcpConfigs: [], warnings: [] };
  registerClaudeMcp(out, opts.before);
  registerOpencodeMcp(out, opts.before);
  return out;
}

/** Claude Code's half of registerGlobalMcp (its connector's global MCP export). */
export function registerClaudeMcp(out: GlobalMcpResult, before?: (path: string) => void) {
  if (claudeInstalled()) register(harness.claudeJson(), "mcpServers", claudeEntry(), false, out, before);
}

/** opencode's half of registerGlobalMcp. */
export function registerOpencodeMcp(out: GlobalMcpResult, before?: (path: string) => void) {
  if (existsSync(harness.opencodeDir())) register(opencodeConfigPath(), "mcp", opencodeEntry(), true, out, before);
}

/**
 * Undoes registerGlobalMcp: removes only entries Tether wrote, in place. Never a restore from a
 * snapshot: Claude has rewritten ~/.claude.json many times since, and that state must stay.
 */
export function unregisterGlobalMcp(): GlobalMcpResult {
  const out: GlobalMcpResult = { written: [], mcpConfigs: [], warnings: [] };
  for (const p of nativeMcpFiles()) unregister(p, p === harness.claudeJson() ? "mcpServers" : "mcp", p !== harness.claudeJson(), out);
  return out;
}

/** Every file registerGlobalMcp may have written. */
export const nativeMcpFiles = () => [harness.claudeJson(), ...["opencode.jsonc", "opencode.json"].map((f) => `${harness.opencodeDir()}/${f}`)];
