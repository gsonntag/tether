// The export ledger: every MCP entry Tether wrote into a harness's JSON config, with the exact
// value written. An entry is Tether's while the file still holds that value; once the user edits
// it, it's theirs and Tether leaves it alone. Harness configs carry no marks of their own (some
// validate their schema strictly); Codex's entries live in a managed TOML block instead.

import { readFileSync } from "node:fs";
import { writeAtomic } from "../context/store";
import { ledgerFile } from "./paths";

export interface LedgerFile {
  /** Tether added the parent key (`mcpServers` / `mcp`): it goes again with the last entry */
  created?: boolean;
  /** server name → the value written */
  entries: Record<string, unknown>;
}

export type Ledger = Record<string, LedgerFile>;

export function readLedger(): Ledger {
  try {
    const v = JSON.parse(readFileSync(ledgerFile(), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function writeLedger(l: Ledger) {
  for (const [k, f] of Object.entries(l)) if (!Object.keys(f.entries).length) delete l[k];
  writeAtomic(ledgerFile(), JSON.stringify(l, null, 2) + "\n", 0o600);
}

/** Key order doesn't matter (harnesses rewrite their configs with their own). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === (b as unknown[]).length && a.every((x, i) => sameValue(x, (b as unknown[])[i]));
  const ka = Object.keys(a).filter((k) => (a as any)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as any)[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue((a as any)[k], (b as any)[k]));
}

/** Whether `value` under `name` in `file` is what Tether wrote there. */
export function isExported(ledger: Ledger, file: string, name: string, value: unknown): boolean {
  const e = ledger[file]?.entries;
  return !!e && name in e && sameValue(e[name], value);
}
