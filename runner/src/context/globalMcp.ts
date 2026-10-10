// Global `tether-context` registrations in config files Tether shares with the user and the
// harness itself: Claude Code's ~/.claude.json (user-scope `mcpServers`) and opencode's
// ~/.config/opencode/opencode.json(c) (`mcp`). These files hold far more than MCP servers (Claude
// rewrites ~/.claude.json constantly; opencode configs carry comments), so the edits here are
// surgical: jsonc-parser edits touch only the one key, everything else stays byte for byte. Each
// write is atomic, keeps the file's mode, and leaves a `.tether-backup` copy of the previous text.
//
// Called only from the user's import (register) and from turning the context off (unregister).

import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from "jsonc-parser";
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

/** Atomic replace that keeps the file's permissions; the previous text goes to `<path>.tether-backup`. */
export function writeConfigAtomic(path: string, text: string) {
  let mode = 0o600;
  if (existsSync(path)) {
    mode = statSync(path).mode & 0o777;
    copyFileSync(path, `${path}.tether-backup`);
  }
  const tmp = `${path}.tether-tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

/** Read-modify-write, retried if the harness rewrote the file meanwhile (Claude writes ~/.claude.json often). */
function update(path: string, jsonc: boolean, edit: (text: string, cfg: any) => string | undefined, out: GlobalMcpResult): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const { value, ok } = parseConfig(text, jsonc);
    if (!ok) {
      out.warnings.push(`${tilde(path)} couldn't be parsed; register tether-context there by hand.`);
      return false;
    }
    const next = edit(text, value);
    if (next === undefined || next === text) return true;
    if (out.dryRun) {
      out.written.push(path);
      return true;
    }
    const again = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (again !== text) continue; // changed under us: redo the edit on the new text
    writeConfigAtomic(path, next);
    out.written.push(path);
    return true;
  }
  out.warnings.push(`${tilde(path)} kept changing; tether-context wasn't registered there.`);
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

function claudeInstalled() {
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

export function register(path: string, key: string, want: object, jsonc: boolean, out: GlobalMcpResult) {
  const done = update(
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
  );
  if (done) out.mcpConfigs.push(path);
}

function unregister(path: string, key: string, jsonc: boolean, out: GlobalMcpResult) {
  if (!existsSync(path)) return;
  update(
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

/** Registers tether-context for native Claude Code and opencode CLI sessions (installed harnesses only). */
export function registerGlobalMcp(opts: { dryRun?: boolean } = {}): GlobalMcpResult {
  const out: GlobalMcpResult = { dryRun: opts.dryRun, written: [], mcpConfigs: [], warnings: [] };
  if (claudeInstalled()) register(harness.claudeJson(), "mcpServers", claudeEntry(), false, out);
  if (existsSync(harness.opencodeDir())) register(opencodeConfigPath(), "mcp", opencodeEntry(), true, out);
  return out;
}

/** Undoes registerGlobalMcp: removes only entries Tether wrote. */
export function unregisterGlobalMcp(opts: { dryRun?: boolean } = {}): GlobalMcpResult {
  const out: GlobalMcpResult = { dryRun: opts.dryRun, written: [], mcpConfigs: [], warnings: [] };
  unregister(harness.claudeJson(), "mcpServers", false, out);
  for (const f of ["opencode.jsonc", "opencode.json"]) unregister(`${harness.opencodeDir()}/${f}`, "mcp", true, out);
  // The plain-JSON configs the regular export writes (pi, Kiro, Antigravity old and new paths).
  for (const p of [harness.piMcp(), harness.kiroMcp(), harness.agyMcp(), harness.agyMcpLegacy()]) unregister(p, "mcpServers", true, out);
  return out;
}
