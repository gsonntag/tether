// A small JSON store for Tether's libraries (custom commands, subagent definitions), kept in the
// runner's config dir (mode 600: they're your prompts) like hooks.json. Entries are keyed by name;
// `dismissed` holds names you deleted, so the next import doesn't bring them back (adding one by
// hand does).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Mutex } from "./context/git";
import { writeAtomic } from "./context/store";

export interface LibraryEntry {
  id: string;
  /** what you type (`/name`) or the harness calls it by */
  name: string;
  description: string;
  enabled: boolean;
  /** "you", or where it was imported from ("claude:~/.claude/commands/fix.md") */
  sources: string[];
  addedAt: number;
}

export interface LibraryData<T extends LibraryEntry> {
  items: T[];
  dismissed: string[];
}

/** A name a `/` command or a subagent can have (no spaces, quotes, slashes). */
export const isEntryName = (n: string) => n.length <= 64 && /^[A-Za-z0-9][\w.:-]*$/.test(n);

export class Library<T extends LibraryEntry> {
  private cache?: { mtime: number; data: LibraryData<T> };
  private lock = new Mutex();

  constructor(
    readonly file: () => string,
    private prefix: string,
    private valid: (v: any) => v is T,
  ) {}

  load(): LibraryData<T> {
    let mtime = -1;
    try {
      mtime = statSync(this.file()).mtimeMs;
    } catch {}
    if (this.cache && this.cache.mtime === mtime && mtime >= 0) return this.cache.data;
    let data: LibraryData<T> = { items: [], dismissed: [] };
    try {
      const v = JSON.parse(readFileSync(this.file(), "utf8"));
      if (v && Array.isArray(v.items)) data = { items: v.items.filter(this.valid), dismissed: Array.isArray(v.dismissed) ? v.dismissed.filter((x: unknown) => typeof x === "string") : [] };
    } catch {}
    this.cache = mtime >= 0 ? { mtime, data } : undefined;
    return data;
  }

  mutate<R>(fn: (d: LibraryData<T>) => R): Promise<R> {
    return this.lock.run(async () => {
      const d = structuredClone(this.load());
      const r = fn(d);
      writeAtomic(this.file(), JSON.stringify(d, null, 2) + "\n", 0o600);
      this.cache = undefined;
      return r;
    });
  }

  reset() {
    this.cache = undefined;
  }

  newId() {
    return `${this.prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Merges found entries: a new name is added (unless you deleted it before and this is an import),
   * the same name with the same content gains the source, the same name with other content is
   * skipped with a warning. One you add by hand replaces the entry of that name wholesale (its id,
   * on/off and sources kept). Returns the names added.
   */
  merge(d: LibraryData<T>, found: Omit<T, "id" | "enabled" | "addedAt">[], same: (a: T, b: Omit<T, "id" | "enabled" | "addedAt">) => boolean, byHand: boolean, warnings: string[]): string[] {
    const added: string[] = [];
    const dismissed = new Set(d.dismissed);
    for (const f of found) {
      const cur = d.items.find((x) => x.name === f.name);
      if (cur) {
        if (byHand) {
          const keep = { id: cur.id, enabled: cur.enabled, addedAt: cur.addedAt, sources: [...new Set([...cur.sources, ...f.sources])] };
          d.items[d.items.indexOf(cur)] = { ...(f as any), ...keep };
        } else if (same(cur, f)) {
          for (const s of f.sources) if (!cur.sources.includes(s)) cur.sources.push(s);
        } else warnings.push(`${f.name} (${f.sources.join(", ")}) differs from the ${f.name} Tether already has; kept Tether's.`);
        continue;
      }
      if (!byHand && dismissed.has(f.name)) continue;
      if (byHand) d.dismissed = d.dismissed.filter((x) => x !== f.name);
      d.items.push({ ...(f as any), id: this.newId(), enabled: true, addedAt: Date.now() });
      added.push(f.name);
    }
    return added;
  }

  /** On/off or delete; deleting an imported one remembers its name for the next import. */
  set(id: string, change: { enabled?: boolean; remove?: boolean }) {
    return this.mutate((d) => {
      const it = d.items.find((x) => x.id === id);
      if (!it) throw new Error("It isn't there any more.");
      if (change.remove) {
        d.items = d.items.filter((x) => x.id !== id);
        if (it.sources.some((s) => s !== "you")) d.dismissed = [...new Set([...d.dismissed, it.name])];
        return;
      }
      if (change.enabled !== undefined) it.enabled = change.enabled;
    });
  }
}

/** `*.md` files in a dir (and, with `depth`, its subdirs), sorted; [] when it isn't there. */
export function mdFiles(dir: string, depth = 0): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const p = join(dir, n);
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) {
      if (depth > 0) out.push(...mdFiles(p, depth - 1));
    } else if (st?.isFile() && n.endsWith(".md") && st.size <= 256 * 1024) out.push(p);
  }
  return out;
}

/** One key's raw value from a file's front matter (`argument-hint: [a] [b]` isn't a YAML list). */
export function rawFrontMatter(text: string, key: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ""));
  if (!m) return undefined;
  const line = m[1]!.split(/\r?\n/).find((l) => new RegExp(`^${key.replace(/[-]/g, "\\-")}\\s*:`).test(l));
  if (!line) return undefined;
  const v = line.slice(line.indexOf(":") + 1).trim();
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v || undefined;
}
