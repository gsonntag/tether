// Antigravity's subagents (SPEC §6a). `invoke_subagent` makes a conversation of its own (its own
// `.db`, never listed), whose first step is the parent's message: "[Message] … sender=<parent id> …
// content=<the prompt>" (checked on 1.5.13). ACP says nothing else about it: no id on the call, no
// updates for it. So the store is read for that one line, and the subagent's turns are replayed from
// its own conversation like any other.
//
// The step is a protobuf blob with no published schema. Tether reads only that readable line from it
// and only from a subagent's first step, and fails quietly (no subagent shown) if the line changes.

import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { agyHome } from "./store";

export interface ChildInfo {
  nativeId: string;
  parent: string;
  /** the prompt's start, as the first step has it (up to its first line break) */
  prompt: string;
  /** when its store was made (ms) */
  at: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const conversations = () => join(agyHome(), "conversations");

/** The parent's message in a first step's bytes; undefined if it isn't one. */
export function parentMessage(payload: Uint8Array): { parent: string; prompt: string } | undefined {
  const text = Buffer.from(payload).toString("latin1");
  const m = /\[Message\][^\x00-\x1f]*?\bsender=([0-9a-f-]{36})\b[^\x00-\x1f]*?\bcontent=([^\x00-\x1f]*)/.exec(text);
  if (!m || !UUID.test(m[1]!)) return undefined;
  return { parent: m[1]!, prompt: Buffer.from(m[2]!, "latin1").toString("utf8").trim() };
}

/** Each store's first step, read once: it never changes. `null`: not a subagent. */
const firstSteps = new Map<string, ChildInfo | null>();

/** Reads one conversation's first step: whether it is a subagent, and whose. */
export function childInfo(nativeId: string): ChildInfo | undefined {
  const known = firstSteps.get(nativeId);
  if (known !== undefined) return known ?? undefined;
  const file = join(conversations(), `${nativeId}.db`);
  let info: ChildInfo | null = null;
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    const row = db.query("select step_payload from steps where idx = 0").get() as { step_payload?: Uint8Array } | null;
    // Not written yet: ask again next time.
    if (!row?.step_payload) return undefined;
    const m = parentMessage(row.step_payload);
    if (m) info = { nativeId, ...m, at: statSync(file).birthtimeMs || statSync(file).mtimeMs };
  } catch {
    return undefined; // mid-write, or locked: next time
  } finally {
    db?.close();
  }
  firstSteps.set(nativeId, info);
  return info ?? undefined;
}

/** Conversations whose store changed at or after `since` (ms), newest last. */
function storesSince(since: number): string[] {
  const out: { id: string; at: number }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(conversations());
  } catch {
    return [];
  }
  for (const n of names) {
    if (!n.endsWith(".db")) continue;
    const id = n.slice(0, -3);
    if (!UUID.test(id)) continue;
    try {
      const at = statSync(join(conversations(), n)).mtimeMs;
      if (at >= since) out.push({ id, at });
    } catch {}
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.id);
}

/** A parent's subagents, as the store has them, oldest first. */
export function childrenOf(parent: string, since = 0): ChildInfo[] {
  return storesSince(since)
    .map((id) => childInfo(id))
    .filter((c): c is ChildInfo => !!c && c.parent === parent)
    .sort((a, b) => a.at - b.at);
}

/**
 * Which call started a subagent: the `invoke_subagent` call whose prompt starts with the subagent's
 * first line, taking calls in order so two with the same prompt pair up one to one.
 */
export function matchCalls<C extends { prompt: string }>(children: ChildInfo[], calls: C[]): Map<string, C> {
  const out = new Map<string, C>();
  const free = [...calls];
  for (const c of children) {
    const head = c.prompt.split("\n")[0]!.trim();
    const i = free.findIndex((k) => !!head && k.prompt.trim().startsWith(head));
    if (i < 0) continue;
    out.set(c.nativeId, free[i]!);
    free.splice(i, 1);
  }
  return out;
}

/** For tests: forget what was read. */
export const forgetFirstSteps = () => firstSteps.clear();
