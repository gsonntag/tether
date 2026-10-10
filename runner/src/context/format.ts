// Memory files: Claude's auto-memory format (front matter + markdown body) plus scope and
// provenance. One fact per file.
//
//   ---
//   name: kebab-slug
//   description: one line, used for relevance
//   type: user | feedback | project | reference
//   scope: global | repo:<repo-key>
//   sources: [claude:~/.claude/projects/-home-ubuntu-foliation/memory/x.md, codex:memories#42]
//   updated: 2026-10-10T12:00:00Z
//   ---
//   body; `[[other-slug]]` links
//
// The parser reads the small YAML subset these files use (scalars, inline and dash lists, one
// level of nesting: newer Claude files put `type` under `metadata:`), and never throws.

import { createHash } from "node:crypto";

export type MemoryType = "user" | "feedback" | "project" | "reference";
export const MEMORY_TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];

export interface Memory {
  name: string;
  description: string;
  type: MemoryType;
  /** "global" or "repo:<repo-key>" */
  scope: string;
  sources: string[];
  /** ISO timestamp */
  updated: string;
  body: string;
}

export type FrontMatter = Record<string, string | string[] | Record<string, string | string[]>>;

const unquote = (s: string) => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) || (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
    const inner = t.slice(1, -1);
    return t[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return t;
};

function inlineList(v: string): string[] | undefined {
  const t = v.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) return undefined;
  const inner = t.slice(1, -1).trim();
  if (!inner) return [];
  // Split on commas outside quotes.
  const out: string[] = [];
  let cur = "";
  let q: string | undefined;
  for (const ch of inner) {
    if (q) {
      cur += ch;
      if (ch === q) q = undefined;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(unquote(cur));
      cur = "";
    } else cur += ch;
  }
  out.push(unquote(cur));
  return out.filter((x) => x !== "");
}

/** Splits `---` front matter from the body. Files without front matter are all body. */
export function splitFrontMatter(text: string): { fm: FrontMatter; body: string; hasFrontMatter: boolean } {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { fm: {}, body: src.trim(), hasFrontMatter: false };
  const fm: FrontMatter = {};
  let parent: Record<string, string | string[]> | undefined;
  let listKey: { obj: Record<string, any>; key: string } | undefined;
  for (const raw of m[1]!.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indented = /^\s+/.test(raw);
    const dash = /^\s*-\s+(.*)$/.exec(raw);
    if (dash && listKey) {
      const arr = Array.isArray(listKey.obj[listKey.key]) ? listKey.obj[listKey.key] : (listKey.obj[listKey.key] = []);
      arr.push(unquote(dash[1]!));
      continue;
    }
    const kv = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, value] = kv as unknown as [string, string, string];
    const target: Record<string, any> = indented && parent ? parent : fm;
    if (!indented) parent = undefined;
    if (value.trim() === "") {
      // Either a nested map (`metadata:`) or a dash list follows.
      if (!indented) {
        parent = {};
        fm[key] = parent;
      } else target[key] = [];
      listKey = { obj: indented ? target : fm, key };
      continue;
    }
    listKey = undefined;
    target[key] = inlineList(value) ?? unquote(value);
  }
  // A key that only collected dashes under it is a list, not a map.
  for (const [k, v] of Object.entries(fm)) if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) fm[k] = [];
  return { fm, body: src.slice(m[0].length).trim(), hasFrontMatter: true };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : []);

export function asType(v: unknown): MemoryType | undefined {
  return MEMORY_TYPES.includes(v as MemoryType) ? (v as MemoryType) : undefined;
}

/** Parses a memory file (Tether's or Claude's own). Missing fields get defaults from `fallback`. */
export function parseMemory(text: string, fallback: Partial<Memory> = {}): Memory {
  const { fm, body } = splitFrontMatter(text);
  const meta = (fm.metadata && typeof fm.metadata === "object" && !Array.isArray(fm.metadata) ? fm.metadata : {}) as Record<string, unknown>;
  const name = str(fm.name) ?? fallback.name ?? slugify(firstLine(body)) ?? "memory";
  return {
    name,
    description: str(fm.description) ?? fallback.description ?? firstLine(body) ?? "",
    type: asType(fm.type) ?? asType(meta.type) ?? fallback.type ?? "project",
    scope: str(fm.scope) ?? fallback.scope ?? "global",
    sources: fm.sources !== undefined ? list(fm.sources) : (fallback.sources ?? []),
    updated: str(fm.updated) ?? fallback.updated ?? new Date().toISOString(),
    body: body || fallback.body || "",
  };
}

/** YAML-safe scalar: quoted only when it has to be. */
function scalar(s: string): string {
  const one = s.replace(/\s*\n\s*/g, " ").trim();
  if (one === "" || /^[\s>|&*!%@`#'"[\]{},?-]|: | #|[:]$/.test(one) || /^(true|false|null|yes|no|~)$/i.test(one)) return JSON.stringify(one);
  return one;
}

function listItem(s: string): string {
  return /[,\[\]"']/.test(s) || /^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}

export function serializeMemory(m: Memory): string {
  return [
    "---",
    `name: ${scalar(m.name)}`,
    `description: ${scalar(m.description)}`,
    `type: ${m.type}`,
    `scope: ${scalar(m.scope)}`,
    `sources: [${m.sources.map(listItem).join(", ")}]`,
    `updated: ${m.updated}`,
    "---",
    m.body.trim(),
    "",
  ].join("\n");
}

export function slugify(s: string | undefined, max = 60): string | undefined {
  if (!s) return undefined;
  const slug = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || undefined;
}

export function firstLine(s: string): string | undefined {
  const line = s
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find(Boolean);
  return line ? line.slice(0, 200) : undefined;
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Normalized content hash: whitespace and case changes don't count as a change. */
export const contentHash = (s: string) => sha(s.replace(/\s+/g, " ").trim().toLowerCase());

/** Words for similarity scoring. */
export function words(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 2 && !STOP.has(w)) out.add(w);
  return out;
}

const STOP = new Set("the and for are but not you your with this that from have has was were will when what which into than then them they their there here use used using also only just about over more most some such very can should would could does did done its it's our out all any one two".split(" "));

/** Jaccard-ish overlap between two word sets, 0..1. */
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size) / 2 + n / (a.size + b.size - n) / 2;
}
