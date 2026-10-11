// Global export (Decision 1): every enabled global-scope registry server is written into each
// installed harness's own global config, so the CLIs outside Tether see it too. Repo-scope servers
// are never written anywhere (least of all into the repo).
//
//   JSON configs (~/.claude.json, opencode, pi, Kiro, Antigravity, Gemini CLI): one key per server,
//     edited in place under the harness's lock (context/globalMcp.ts updateConfig), so every byte
//     outside Tether's entries stays as it was. The ledger (ledger.ts) records what was written:
//     only an entry that still holds exactly that is updated or removed later.
//   Codex config.toml: the `tether-mcp` managed block, Tether's alone (and in the ledger, for when
//     Codex's own `mcp add` rewrites the table without the block's begin marker).
//
// Decision 2: a harness whose own config already has the server (same command line or URL), or
// a different server under the same name, gets nothing; the user's entry is never touched.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { HarnessId } from "../../../web/src/shared/protocol";
import { connectorFor } from "../connectors";
import type { McpTarget } from "../connectors/types";
import { upsertTomlBlock } from "../context/blocks";
import { editJson, editJsonEntry, lockConfig, target, updateConfig, writeConfigAtomic, type GlobalMcpResult } from "../context/globalMcp";
import { tilde } from "../context/paths";
import { codexToml, fromEntry, identity, toEntry } from "./formats";
import { readLedger, sameValue, writeLedger, type Ledger, type LedgerFile } from "./ledger";
import { CODEX_BLOCK, dropCodexStrays, splitCodexToml } from "./sources";
import type { RegistryServer } from "./store";

const ORDER: HarnessId[] = ["claude-code", "codex", "pi", "opencode", "kiro", "antigravity"];

export interface RegistryExport {
  dryRun?: boolean;
  written: string[];
  warnings: string[];
}

/** The servers a config should hold: what it can take, minus what its user already has (by identity or name). */
function wanted(servers: RegistryServer[], t: McpTarget, theirs: [string, unknown][]): Map<string, Record<string, unknown>> {
  const ids = new Set(theirs.flatMap(([, v]) => {
    const p = fromEntry(v, t.flavor);
    return p ? [identity(p.transport)] : [];
  }));
  const names = new Set(theirs.map(([n]) => n));
  const want = new Map<string, Record<string, unknown>>();
  for (const s of servers) {
    if (ids.has(identity(s.transport)) || names.has(s.name)) continue;
    const e = toEntry(s.transport, t.flavor);
    if (e) want.set(s.name, e);
  }
  return want;
}

const hasSecrets = (s: RegistryServer) => Object.keys(s.transport.type === "stdio" ? s.transport.env : s.transport.headers).length > 0;

/**
 * Env and header values can be secrets (copied from a mode-600 ~/.claude.json, say): a config that
 * holds one of Tether's entries with them is made private to the user, as the registry itself is.
 */
function keepPrivate(file: string, servers: RegistryServer[], names: Iterable<string>, out: GlobalMcpResult) {
  if (out.dryRun) return;
  const held = new Set(names);
  if (!servers.some((s) => held.has(s.name) && hasSecrets(s))) return;
  try {
    const real = target(file);
    const mode = statSync(real).mode & 0o777;
    if (mode & 0o077) chmodSync(real, mode & 0o700);
  } catch {}
}

function exportJson(t: McpTarget, servers: RegistryServer[], ledger: Ledger, out: GlobalMcpResult) {
  const key = t.key!;
  const prev: LedgerFile = ledger[t.file] ?? { entries: {} };
  // Values written in this export: a retry (globalMcp's update re-runs the edit) still knows them as ours.
  const wrote = new Map<string, unknown>();
  let next: LedgerFile = prev;
  // The harness is set up but its config dir isn't there yet (Kiro's settings/, agy's config/).
  if (servers.length && !out.dryRun && !existsSync(dirname(t.file))) mkdirSync(dirname(t.file), { recursive: true });
  const done = updateConfig(
    t.file,
    !!t.jsonc,
    (text, cfg) => {
      const parent = cfg?.[key];
      if (parent !== undefined && (!parent || typeof parent !== "object" || Array.isArray(parent))) {
        out.warnings.push(`${tilde(t.file)} has an unexpected "${key}"; MCP servers weren't written there.`);
        return undefined;
      }
      const cur: Record<string, unknown> = parent ?? {};
      const ours = (n: string) => n in cur && ((n in prev.entries && sameValue(prev.entries[n], cur[n])) || (wrote.has(n) && sameValue(wrote.get(n), cur[n])));
      const theirs = Object.entries(cur).filter(([n]) => !ours(n));
      const want = wanted(servers, t, theirs);
      let s = text;
      let exists = parent !== undefined;
      let created = !!prev.created;
      for (const n of Object.keys(cur)) if (ours(n) && !want.has(n)) s = editJsonEntry(s, [key, n], undefined);
      const entries: Record<string, unknown> = {};
      for (const [n, v] of want) {
        entries[n] = v;
        wrote.set(n, v);
        if (n in cur && sameValue(cur[n], v)) continue;
        if (!exists) {
          s = editJson(s, [key], { [n]: v });
          exists = created = true;
        } else s = editJsonEntry(s, [key, n], v);
      }
      // The parent Tether added goes with its last entry (the file reads as before the first export).
      if (created && !want.size && !theirs.length && exists) {
        s = editJson(s, [key], undefined);
        created = false;
      }
      next = { ...(created && (want.size || theirs.length) ? { created: true } : {}), entries };
      return s === text ? undefined : s;
    },
    out,
    undefined,
    "MCP servers",
  );
  if (done && !out.dryRun) {
    ledger[t.file] = next;
    keepPrivate(t.file, servers, Object.keys(next.entries), out);
  }
}

/**
 * Codex: the `tether-mcp` block holds every server (the block is Tether's; the rest of the file is
 * the user's). The ledger keeps what was written too: `codex mcp add` rewrites the whole
 * mcp_servers table and loses the begin marker, and an entry outside the block that still holds
 * exactly Tether's value is moved back into it.
 */
function exportToml(t: McpTarget, servers: RegistryServer[], ledger: Ledger, out: GlobalMcpResult) {
  const real = target(t.file);
  const prev = ledger[t.file]?.entries ?? {};
  for (let attempt = 0; attempt < 5; attempt++) {
    const text = existsSync(real) ? readFileSync(real, "utf8") : "";
    let user: any;
    try {
      user = Bun.TOML.parse(splitCodexToml(text).user);
    } catch {
      out.warnings.push(`${tilde(t.file)} couldn't be parsed; MCP servers weren't written there.`);
      return;
    }
    const all = Object.entries<unknown>(user?.mcp_servers && typeof user.mcp_servers === "object" ? user.mcp_servers : {});
    const strays = all.filter(([n, v]) => n in prev && sameValue(prev[n], v)).map(([n]) => n);
    const theirs = all.filter(([n]) => !strays.includes(n));
    const want = wanted(servers, t, theirs);
    const done = () => {
      if (!out.dryRun) ledger[t.file] = { entries: Object.fromEntries(want) };
      keepPrivate(t.file, servers, want.keys(), out);
    };
    const base = dropCodexStrays(text, strays);
    const next = upsertTomlBlock(base, want.size ? codexToml([...want]) : undefined, CODEX_BLOCK);
    if (next === text) return done();
    try {
      Bun.TOML.parse(next);
    } catch {
      out.warnings.push(`${tilde(t.file)} would no longer parse with Tether's MCP servers in it (an inline mcp_servers table?); left as it was.`);
      return;
    }
    if (out.dryRun) {
      out.written.push(t.file);
      return;
    }
    const release = lockConfig(real);
    if (!release) continue;
    let wrote = false;
    try {
      const cur = existsSync(real) ? readFileSync(real, "utf8") : "";
      wrote = cur === text && writeConfigAtomic(real, next, () => (existsSync(real) ? readFileSync(real, "utf8") : "") === text);
    } finally {
      release();
    }
    if (wrote) {
      out.written.push(t.file);
      return done();
    }
  }
  out.warnings.push(`${tilde(t.file)} kept changing; MCP servers there weren't updated. Try again in a moment.`);
}

/**
 * Brings every installed harness's global config in line with the registry: enabled global servers
 * in, everything else Tether wrote out. Harnesses that aren't set up are skipped (their ledger
 * entries stay for when they are).
 */
export function exportRegistry(servers: RegistryServer[], opts: { dryRun?: boolean } = {}): RegistryExport {
  const out: GlobalMcpResult = { dryRun: opts.dryRun, written: [], mcpConfigs: [], warnings: [] };
  const global = servers.filter((s) => s.enabled && s.scope === "global");
  const ledger = readLedger();
  for (const h of ORDER) {
    for (const t of connectorFor(h).mcp.targets?.() ?? []) {
      if (!t.installed) continue;
      try {
        if (t.format === "toml") exportToml(t, global, ledger, out);
        else exportJson(t, global, ledger, out);
      } catch (e: any) {
        out.warnings.push(`${tilde(t.file)}: ${e?.code ?? e?.message ?? e}`);
      }
    }
  }
  if (!opts.dryRun) writeLedger(ledger);
  return { dryRun: opts.dryRun, written: out.written, warnings: out.warnings };
}

/** Where Tether's copy of `name` is in harness configs now (by the ledger and Codex's block). */
export function exportedTo(): Map<string, Set<string>> {
  const by = new Map<string, Set<string>>();
  const add = (name: string, file: string) => by.set(name, (by.get(name) ?? new Set()).add(file));
  const ledger = readLedger();
  for (const [file, f] of Object.entries(ledger)) for (const n of Object.keys(f.entries)) add(n, file);
  for (const t of connectorFor("codex").mcp.targets?.() ?? []) {
    try {
      const block = splitCodexToml(readFileSync(t.file, "utf8")).ours;
      for (const n of Object.keys((Bun.TOML.parse(block) as any)?.mcp_servers ?? {})) add(n, t.file);
    } catch {}
  }
  return by;
}
