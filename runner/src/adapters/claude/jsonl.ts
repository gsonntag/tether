// Claude Code's session JSONL, read by Tether itself (not the SDK's getSessionMessages, whose
// parentUuid walk stops at a compaction and drops everything before it).
//
// Each line is an entry with `uuid` and `parentUuid`; the conversation is the chain from the last
// message back. A compaction writes a `compact_boundary` whose parentUuid is null, so the chain
// after it ends there. Its `logicalParentUuid` can't be trusted to lead back (in real files it
// names an entry written after the boundary), so the walk carries on from the last main-thread
// message written before the boundary: the conversation as it stood when it was compacted. An
// entry is shown once, where it first happened.
//
// Files are read incrementally: a watched session that grows by a few lines parses only those
// (a 27 MB transcript reparsed on every change took ~250 ms). A file that shrank or was replaced
// is read again from the start.

import { open, stat } from "node:fs/promises";

export interface Entry {
  uuid: string;
  parentUuid?: string | null;
  logicalParentUuid?: string;
  type: string;
  subtype?: string;
  message?: any;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  origin?: any;
  /** a prompt delivered mid-turn (a queued_command attachment), read as a user turn */
  queued?: boolean;
  /** the id Claude Code gives that prompt's message (its source_uuid) */
  messageId?: string;
  timestamp?: string;
  /** its place in the file (line count) */
  order: number;
}

/** What is kept of a line: the chain fields always, content only for messages. */
function entryOf(line: string): Entry | undefined {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!e || typeof e.uuid !== "string" || typeof e.type !== "string") return undefined;
  const out: Entry = { uuid: e.uuid, parentUuid: e.parentUuid ?? null, type: e.type, order: 0 };
  if (e.logicalParentUuid) out.logicalParentUuid = e.logicalParentUuid;
  if (e.isSidechain) out.isSidechain = true;
  if (e.timestamp) out.timestamp = e.timestamp;
  if (e.type === "user" || e.type === "assistant") {
    // An API error reply (rate limit, auth) is marked on the entry, not the message: carried along.
    out.message = e.isApiErrorMessage && e.message ? { ...e.message, apiError: e.error || true } : e.message;
    if (e.isMeta) out.isMeta = true;
    if (e.isCompactSummary) out.isCompactSummary = true;
    if (e.origin) out.origin = e.origin;
  } else if (e.type === "attachment" && e.attachment?.type === "queued_command" && (typeof e.attachment.prompt === "string" || Array.isArray(e.attachment.prompt))) {
    // A prompt (yours, a task's report, another agent's message) delivered while a turn ran, where
    // it reached Claude: a user turn, as Claude Code shows it.
    const a = e.attachment;
    out.type = "user";
    out.queued = true;
    if (typeof a.source_uuid === "string" && a.source_uuid) out.messageId = a.source_uuid;
    out.message = { role: "user", content: a.prompt };
    // Your own message reaching a running subagent is marked meta; Claude Code shows it all the same.
    if (a.isMeta && a.origin?.kind !== "human") out.isMeta = true;
    if (a.origin) out.origin = a.origin;
    else if (a.commandMode === "task-notification") out.origin = { kind: "task-notification" };
  } else if (e.type === "system") {
    out.subtype = e.subtype;
    // A slash command's output (/context, /cost, …), shown as a notice.
    if (e.subtype === "local_command" && typeof e.content === "string") out.message = { content: e.content };
  }
  return out;
}

export class StoreFile {
  /** bytes consumed (always just after a newline) */
  offset = 0;
  private ino = -1;
  readonly entries = new Map<string, Entry>();
  /** user and assistant entries of the main thread, in file order */
  private messages: Entry[] = [];
  /** entries by parent, in file order */
  private children = new Map<string, Entry[]>();
  private lines = 0;

  /** a subagent's own file (subagents/agent-*.jsonl): every entry is its thread, all marked sidechain */
  private readonly subagent: boolean;

  constructor(readonly path: string) {
    this.subagent = /\/subagents\/agent-[^/]+\.jsonl$/.test(path);
  }

  /** Reads what was appended since the last call. True when anything changed. */
  async update(): Promise<boolean> {
    const s = await stat(this.path);
    if (s.ino !== this.ino || s.size < this.offset) this.reset(s.ino);
    if (s.size === this.offset) return false;
    const fh = await open(this.path, "r");
    let changed = false;
    try {
      const CHUNK = 8 * 1024 * 1024;
      let carry = Buffer.alloc(0);
      while (this.offset + carry.length < s.size) {
        const want = Math.min(CHUNK, s.size - this.offset - carry.length);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, this.offset + carry.length);
        if (!bytesRead) break;
        const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
        const end = data.lastIndexOf(0x0a);
        if (end < 0) {
          carry = data;
          continue;
        }
        for (const line of data.subarray(0, end).toString("utf8").split("\n")) if (line.trim()) changed = this.add(line) || changed;
        this.offset += end + 1;
        carry = data.subarray(end + 1);
      }
      // A last line without its newline is still being written: read again next time.
    } finally {
      await fh.close();
    }
    return changed;
  }

  private reset(ino: number) {
    this.ino = ino;
    this.offset = 0;
    this.entries.clear();
    this.messages = [];
    this.children.clear();
    this.lines = 0;
  }

  private add(line: string): boolean {
    const e = entryOf(line);
    if (!e) return false;
    e.order = ++this.lines;
    this.entries.set(e.uuid, e);
    if (e.parentUuid) {
      const list = this.children.get(e.parentUuid);
      if (list) list.push(e);
      else this.children.set(e.parentUuid, [e]);
    }
    // Conversation entries (a slash command's output too: it can be the last thing written).
    if (((e.type === "user" || e.type === "assistant") && (!e.isSidechain || this.subagent)) || (e.type === "system" && e.subtype === "local_command")) this.messages.push(e);
    return true;
  }

  /** The conversation, oldest first, across every compaction. */
  chain(): Entry[] {
    const walk: Entry[] = [];
    const visited = new Set<string>();
    let cur: Entry | undefined = this.messages.at(-1);
    while (cur && !visited.has(cur.uuid)) {
      visited.add(cur.uuid);
      walk.push(cur);
      if (cur.parentUuid) cur = this.entries.get(cur.parentUuid);
      else if (cur.type === "system" && cur.subtype === "compact_boundary") cur = this.lastMessageBefore(cur.order);
      else cur = undefined;
    }
    // Branches written beside the conversation, not instead of it: a prompt queued while a turn
    // ran (or a task notification) hangs off the running turn, and its reply hangs off it.
    for (const b of this.sideBranches(visited)) walk.push(...b);
    // Parallel tool calls are written as a chain of assistant entries (one call each), and each
    // result is parented to its own call: all but one result sit beside the chain. Results for
    // calls in the conversation belong to it wherever they hang.
    walk.push(...this.offChainResults(new Set(walk.map((e) => e.uuid)), walk));
    // Each entry once, in the order it was written (a child is always written after its parent).
    const seen = new Set<string>();
    const out: Entry[] = [];
    for (const e of walk) {
      if (seen.has(e.uuid)) continue;
      seen.add(e.uuid);
      out.push(e);
    }
    return out.sort((a, b) => a.order - b.order);
  }

  /**
   * User turns off the main chain whose parent is on it (a prompt queued mid-turn, a task
   * notification arriving beside a subagent's report), each with what followed it. Except those
   * abandoned: an edit, retry or rewind continues the chain from the same parent with a newer
   * prompt you typed, and Claude Code no longer shows the old branch.
   */
  /**
   * The prompt the chain continues with after `parent`, past what Claude Code writes before a
   * prompt (a slash command's caveat, attachments).
   */
  private nextPromptOnChain(parent: string, onChain: Set<string>): Entry | undefined {
    let cur = (this.children.get(parent) ?? []).find((c) => onChain.has(c.uuid));
    for (let i = 0; cur && i < 20; i++) {
      if (!cur.queued) {
        if (isPrompt(cur) && !cur.isMeta) return cur;
        if (cur.type === "assistant" || (cur.type === "user" && !cur.isMeta)) return undefined;
      }
      cur = (this.children.get(cur.uuid) ?? []).find((c) => onChain.has(c.uuid));
    }
    return undefined;
  }

  private sideBranches(onChain: Set<string>): Entry[][] {
    const out: Entry[][] = [];
    for (const e of this.messages) {
      if (onChain.has(e.uuid) || !isPrompt(e) || !e.parentUuid || !onChain.has(e.parentUuid)) continue;
      const main = this.nextPromptOnChain(e.parentUuid, onChain);
      if (main && typed(main) && main.order > e.order) continue;
      const branch: Entry[] = [];
      const seen = new Set<string>();
      for (let cur: Entry | undefined = e; cur && !seen.has(cur.uuid) && !onChain.has(cur.uuid); cur = this.children.get(cur.uuid)?.at(-1)) {
        seen.add(cur.uuid);
        branch.push(cur);
      }
      out.push(branch);
    }
    return out;
  }

  /**
   * User entries with only tool results, off the conversation, for calls in it that have no result
   * in it.
   */
  private offChainResults(onChain: Set<string>, conversation: Entry[]): Entry[] {
    const calls = new Set<string>();
    for (const e of conversation) {
      const c = e.type === "assistant" ? e.message?.content : undefined;
      if (Array.isArray(c)) for (const b of c) if (b?.type === "tool_use" && typeof b.id === "string") calls.add(b.id);
    }
    for (const e of conversation) {
      const c = e.type === "user" ? e.message?.content : undefined;
      if (Array.isArray(c)) for (const b of c) if (b?.type === "tool_result") calls.delete(b.tool_use_id);
    }
    if (!calls.size) return [];
    const out: Entry[] = [];
    for (const e of this.messages) {
      if (e.type !== "user" || onChain.has(e.uuid)) continue;
      const c = e.message?.content;
      if (!Array.isArray(c) || !c.length) continue;
      if (c.every((b: any) => b?.type === "tool_result" && calls.has(b.tool_use_id))) out.push(e);
    }
    return out;
  }

  /** The last main-thread message written before line `order`. */
  private lastMessageBefore(order: number): Entry | undefined {
    let lo = 0;
    let hi = this.messages.length - 1;
    let hit: Entry | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.messages[mid]!.order < order) {
        hit = this.messages[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return hit;
  }
}

const cache = new Map<string, StoreFile>();
/** Files kept parsed besides the watched ones (a long session holds tens of MB). */
const CACHE_MAX = 4;
/** Watched files, by how many watchers: always cached, so each change parses only what was appended. */
const pinned = new Map<string, number>();

/** Keeps a file's parse while it's watched; returns the release. */
export function pinStore(path: string): () => void {
  pinned.set(path, (pinned.get(path) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (pinned.get(path) ?? 1) - 1;
    if (n > 0) pinned.set(path, n);
    else pinned.delete(path);
  };
}

/** The file, brought up to date (cached, so repeated reads parse only what was appended). */
export async function readStore(path: string): Promise<StoreFile> {
  let f = cache.get(path);
  if (f) cache.delete(path);
  else f = new StoreFile(path);
  cache.set(path, f);
  // Only unwatched files count against the cap, oldest first.
  const loose = [...cache.keys()].filter((p) => !pinned.has(p));
  for (const p of loose.slice(0, Math.max(0, loose.length - CACHE_MAX))) cache.delete(p);
  await f.update();
  return f;
}

/** For tests: what is cached. */
export const cachedStores = () => [...cache.keys()];

/** A user turn: a user entry with text or images (typed, or injected by Claude Code), not tool results. */
function isPrompt(e: Entry): boolean {
  if (e.type !== "user") return false;
  const c = e.message?.content;
  if (typeof c === "string") return true;
  return Array.isArray(c) && c.some((b: any) => b?.type === "text" || b?.type === "image") && !c.some((b: any) => b?.type === "tool_result");
}

/** A prompt you typed: Claude Code (and Tether's driver) mark it origin human, older files not at all. */
function typed(e: Entry): boolean {
  return isPrompt(e) && !e.isMeta && (!e.origin || e.origin.kind === "human");
}
