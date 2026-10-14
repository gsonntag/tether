// Reading MCP servers out of every harness's own config: for the registry's import ("Find
// servers" and the master context's Import) and for a session's "already there natively" check
// (Decision 2). Read only: nothing here writes.
//
//   claude       ~/.claude.json mcpServers (global) and projects.<path>.mcpServers (that repo)
//   repo         <project>/.mcp.json (that repo; Claude Code and pi-mcp-adapter read it)
//   codex        ~/.codex/config.toml [mcp_servers.*]
//   opencode     ~/.config/opencode/opencode.json(c) `mcp`
//   pi           ~/.pi/agent/mcp.json (pi's own MCP) and mcp-adapter.json (pi-mcp-adapter)
//   kiro         ~/.kiro/settings/mcp.json
//   antigravity  ~/.gemini/config/mcp_config.json (and its old ~/.gemini/antigravity path)
//   gemini       ~/.gemini/settings.json
//
// `tether-context` (Tether's own memory server) is never a registry server. Entries Tether
// exported itself are marked `ours`: an import skips them, the native check counts them.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { upward } from "../connectors/shared";
import { isOurs, opencodeConfigPath, SERVER } from "../context/globalMcp";
import { harness, home, tilde } from "../context/paths";
import { fromEntry, type Flavor } from "./formats";
import { isExported, readLedger, type Ledger } from "./ledger";
import type { McpTransport } from "../../../web/src/shared/protocol";

/** One server entry found in a harness config. */
export interface Found {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** "global", or the project path whose repo it belongs to */
  scope: "global" | { path: string };
  /** provenance: "<kind>:<~path>" */
  source: string;
  file: string;
  /** an entry Tether exported there (export.ts) */
  ours: boolean;
}

export interface Scan {
  found: Found[];
  warnings: string[];
}

/** The managed block Codex's registry servers live in (the `tether` block holds tether-context). */
export const CODEX_BLOCK = "tether-mcp";

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function readJson(path: string, warnings: string[]): any {
  const text = readText(path);
  if (text === undefined || !text.trim()) return undefined;
  const errors: ParseError[] = [];
  const v = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !v || typeof v !== "object" || Array.isArray(v)) {
    warnings.push(`${tilde(path)} couldn't be read as JSON; its MCP servers were skipped.`);
    return undefined;
  }
  return v;
}

const isTetherContext = (name: string, entry: unknown) => name === SERVER || isOurs(entry);

/** The servers in one `{ name: entry }` group of a JSON config. */
function group(out: Scan, ledger: Ledger, file: string, servers: unknown, flavor: Flavor, kind: string, scope: Found["scope"], suffix = "") {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return;
  for (const [name, entry] of Object.entries(servers)) {
    if (isTetherContext(name, entry)) continue;
    const p = fromEntry(entry, flavor);
    if (!p) continue;
    out.found.push({ name, ...p, scope, source: `${kind}:${tilde(file)}${suffix}`, file, ours: isExported(ledger, file, name, entry) });
  }
}

function jsonFile(out: Scan, ledger: Ledger, file: string, key: string, flavor: Flavor, kind: string, scope: Found["scope"] = "global") {
  const cfg = readJson(file, out.warnings);
  if (cfg) group(out, ledger, file, cfg[key], flavor, kind, scope);
}

const scan = (): Scan => ({ found: [], warnings: [] });

// ---------------- per harness ----------------

/** ~/.claude.json: user scope, plus each project's own servers (that project's repo). */
export function claudeServers(opts: { projects?: boolean; projectPath?: string } = {}, ledger = readLedger()): Scan {
  const out = scan();
  const file = harness.claudeJson();
  const cfg = readJson(file, out.warnings);
  if (!cfg) return out;
  group(out, ledger, file, cfg.mcpServers, "claude", "claude", "global");
  const projects = cfg.projects && typeof cfg.projects === "object" ? cfg.projects : {};
  for (const [path, p] of Object.entries<any>(projects)) {
    if (opts.projects || path === opts.projectPath) group(out, ledger, file, p?.mcpServers, "claude", "claude", { path }, `#${path}`);
  }
  return out;
}

/** Every project ~/.claude.json knows (Claude records a repo's .mcp.json approvals there, not its servers). */
export function claudeProjects(): string[] {
  const cfg = readJson(harness.claudeJson(), []);
  return cfg?.projects && typeof cfg.projects === "object" && !Array.isArray(cfg.projects) ? Object.keys(cfg.projects) : [];
}

/** A project's .mcp.json (read only, never written: it belongs to the repo). */
export function repoServers(projectPath: string, ledger = readLedger()): Scan {
  const out = scan();
  jsonFile(out, ledger, join(projectPath, ".mcp.json"), "mcpServers", "claude", "repo", { path: projectPath });
  return out;
}

/**
 * The text of ~/.codex/config.toml without Tether's managed blocks, and the `tether-mcp` block's own
 * text. A begin marker without its end claims only its own line (as blocks.ts upsertTomlBlock), and
 * an end marker without its begin is just a comment of the user's.
 */
export function splitCodexToml(text: string): { user: string; ours: string } {
  const lines = text.split("\n");
  const user: string[] = [];
  const ours: string[] = [];
  let inside: string | undefined;
  lines.forEach((l, i) => {
    const t = l.trim();
    const b = /^# (tether(?:-mcp)?):begin/.exec(t);
    if (!inside && b) {
      if (lines.some((x, j) => j > i && x.trim() === `# ${b[1]}:end`)) inside = b[1];
      return;
    }
    if (inside && t === `# ${inside}:end`) {
      inside = undefined;
      return;
    }
    if (inside === CODEX_BLOCK) ours.push(l);
    else if (!inside) user.push(l);
  });
  return { user: user.join("\n"), ours: ours.join("\n") };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Tether's servers that ended up outside its block, taken out (`[mcp_servers.<name>]` and its
 * subtables, up to the next table), and a `tether-mcp` end marker left without its begin. Codex's
 * own `codex mcp add/remove` rewrites the whole mcp_servers table and loses the begin marker; the
 * export then writes the block again.
 */
export function dropCodexStrays(text: string, names: string[]): string {
  const lines = text.split("\n");
  const begin = `# ${CODEX_BLOCK}:begin`;
  const end = `# ${CODEX_BLOCK}:end`;
  const strays = names.map((n) => new RegExp(`^\\[\\s*mcp_servers\\s*\\.\\s*("?)${escapeRe(n)}\\1\\s*[\\].]`));
  const out: string[] = [];
  let inside = false;
  let skipping = false;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!inside && t.startsWith(begin) && lines.some((x, j) => j > i && x.trim() === end)) {
      inside = true;
      skipping = false;
    } else if (t === end) {
      if (!inside) return; // its begin is gone
      inside = false;
    } else if (!inside && t.startsWith("[")) skipping = strays.some((re) => re.test(t));
    if (!skipping) out.push(l);
  });
  return out.join("\n");
}

function tomlServers(out: Scan, ledger: Ledger, file: string, text: string, ours: boolean) {
  let cfg: any;
  try {
    cfg = Bun.TOML.parse(text);
  } catch {
    out.warnings.push(`${tilde(file)} couldn't be read as TOML; its MCP servers were skipped.`);
    return;
  }
  for (const [name, e] of Object.entries<any>(cfg?.mcp_servers ?? {})) {
    if (isTetherContext(name, e)) continue;
    const p = fromEntry(e, "codex");
    if (!p) continue;
    // Outside the block, an entry still exactly as Tether wrote it is Tether's (the ledger).
    const mine = ours || isExported(ledger, file, name, e);
    if (!mine && (e?.bearer_token_env_var || e?.env_http_headers)) out.warnings.push(`${name} in ${tilde(file)} reads its token from an environment variable; add the header to it in Tether by hand.`);
    out.found.push({ name, ...p, scope: "global", source: `codex:${tilde(file)}`, file, ours: mine });
  }
}

/** ~/.codex/config.toml: the user's servers, and (`ours`) those in Tether's managed block or still as it wrote them. */
export function codexServers(ledger = readLedger()): Scan {
  const out = scan();
  const file = harness.codexConfig();
  const text = readText(file);
  if (!text) return out;
  const { user, ours } = splitCodexToml(text);
  tomlServers(out, ledger, file, user, false);
  if (ours.trim()) tomlServers(out, ledger, file, ours, true);
  return out;
}

export function opencodeServers(projectPath?: string, ledger = readLedger()): Scan {
  const out = scan();
  if (existsSync(harness.opencodeDir())) jsonFile(out, ledger, opencodeConfigPath(), "mcp", "opencode", "opencode");
  if (projectPath) for (const f of ["opencode.jsonc", "opencode.json"]) jsonFile(out, ledger, join(projectPath, f), "mcp", "opencode", "opencode", { path: projectPath });
  return out;
}

/** pi's own MCP config and pi-mcp-adapter's; with a project, the files the adapter also reads for it. */
export function piServers(projectPath?: string, ledger = readLedger()): Scan {
  const out = scan();
  jsonFile(out, ledger, harness.piMcp(), "mcpServers", "plain", "pi");
  jsonFile(out, ledger, harness.piMcpAdapter(), "mcpServers", "plain", "pi");
  if (projectPath) {
    jsonFile(out, ledger, join(home(), ".config", "mcp", "mcp.json"), "mcpServers", "plain", "pi");
    jsonFile(out, ledger, join(projectPath, ".pi", "mcp.json"), "mcpServers", "plain", "pi", { path: projectPath });
    for (const d of upward(projectPath)) jsonFile(out, ledger, join(d, ".mcp.json"), "mcpServers", "claude", "repo", { path: d });
  }
  return out;
}

export function kiroServers(projectPath?: string, ledger = readLedger()): Scan {
  const out = scan();
  jsonFile(out, ledger, harness.kiroMcp(), "mcpServers", "plain", "kiro");
  if (projectPath) jsonFile(out, ledger, join(projectPath, ".kiro", "settings", "mcp.json"), "mcpServers", "plain", "kiro", { path: projectPath });
  return out;
}

export function antigravityServers(ledger = readLedger()): Scan {
  const out = scan();
  jsonFile(out, ledger, harness.agyMcp(), "mcpServers", "agy", "antigravity");
  if (!existsSync(harness.agyMcp())) jsonFile(out, ledger, harness.agyMcpLegacy(), "mcpServers", "agy", "antigravity");
  return out;
}

export const geminiSettings = () => join(home(), ".gemini", "settings.json");

export function geminiServers(ledger = readLedger()): Scan {
  const out = scan();
  jsonFile(out, ledger, geminiSettings(), "mcpServers", "gemini", "gemini");
  return out;
}

/** Claude Code's servers for a session in `projectPath`: user scope, that project's, and its .mcp.json files. */
export function claudeSessionServers(projectPath: string): Scan {
  const ledger = readLedger();
  const out = claudeServers({ projectPath }, ledger);
  for (const d of upward(projectPath)) {
    const r = repoServers(d, ledger);
    out.found.push(...r.found);
    out.warnings.push(...r.warnings);
  }
  return out;
}

export function merge(...scans: Scan[]): Scan {
  return { found: scans.flatMap((s) => s.found), warnings: [...new Set(scans.flatMap((s) => s.warnings))] };
}
