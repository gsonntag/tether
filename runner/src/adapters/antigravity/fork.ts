// Forking an Antigravity session (SPEC §16). Antigravity has no fork call, so the fork is a copy of
// the conversation's store under a new id: a consistent snapshot (`VACUUM INTO`, safe while the
// original is live), the old id rewritten to the new one wherever it appears (rows and blobs; ids are
// the same length, so the protobuf framing around them holds), and, to end at a reply, every step
// from the next user input on removed. Checked on 1.5.13: the copy loads and is listed, it
// continues with only the kept turns, and the original is unchanged. Its brain folder (plans and
// other artifacts) is copied too.
//
// The fork is read back before it's handed over: its replay must end where it should, else it's deleted.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Msg } from "../../../../shared/transcript";
import type { AdapterFork, ForkRequest } from "../../core/adapter";
import { agyHome, conversationFile, reader } from "./store";

/** A user's prompt in Antigravity's steps (`step_type`); a subagent's first message is another type. */
export const USER_INPUT_STEP = 14;
/** Tables whose rows are steps, keyed by `idx`. */
const STEP_TABLES = ["steps", "gen_metadata", "executor_metadata", "parent_references", "battle_mode_infos"];

const brain = (id: string) => join(agyHome(), "brain", id);
const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** How many prompts the fork keeps: those up to and including the one `upTo` answers (all, with no `upTo`). */
export function promptsKept(msgs: Msg[], upTo?: string): number | undefined {
  if (!upTo) return undefined;
  const at = msgs.findIndex((m) => m.id === upTo);
  if (at < 0) throw new Error("That message isn't in the session any more.");
  return msgs.slice(0, at + 1).filter((m) => m.role === "user").length;
}

/** Copies `from`'s store to `to`, the id rewritten, cut before prompt number `keep` (0-based) when given. */
export function copyStore(from: string, to: string, keep?: number) {
  if (from.length !== to.length) throw new Error("Ids of different lengths can't be swapped in place.");
  const dst = conversationFile(to);
  const src = new Database(conversationFile(from), { readonly: true });
  try {
    src.exec(`VACUUM INTO ${sqlString(dst)}`);
  } finally {
    src.close();
  }
  const db = new Database(dst);
  try {
    const oldB = Buffer.from(from);
    const newB = Buffer.from(to);
    const swap = (b: Uint8Array): Buffer | undefined => {
      const buf = Buffer.from(b);
      let i = buf.indexOf(oldB);
      if (i < 0) return undefined;
      for (; i >= 0; i = buf.indexOf(oldB, i + newB.length)) newB.copy(buf, i);
      return buf;
    };
    db.exec("begin");
    const tables = db.query("select name from sqlite_master where type = 'table'").all() as { name: string }[];
    for (const { name } of tables) {
      const cols = (db.query(`pragma table_info(${JSON.stringify(name)})`).all() as { name: string; pk: number }[]);
      const key = cols.filter((c) => c.pk > 0).map((c) => c.name);
      const where = key.length ? key.map((k) => `${JSON.stringify(k)} = ?`).join(" and ") : "rowid = ?";
      const rows = db.query(`select rowid as __rowid, * from ${JSON.stringify(name)}`).all() as Record<string, unknown>[];
      for (const row of rows) {
        const set: Record<string, unknown> = {};
        for (const c of cols) {
          const v = row[c.name];
          if (v instanceof Uint8Array) {
            const n = swap(v);
            if (n) set[c.name] = n;
          } else if (typeof v === "string" && v.includes(from)) set[c.name] = v.split(from).join(to);
        }
        const names = Object.keys(set);
        if (!names.length) continue;
        const keys = key.length ? key.map((k) => row[k]) : [row.__rowid];
        db.query(`update ${JSON.stringify(name)} set ${names.map((n) => `${JSON.stringify(n)} = ?`).join(", ")} where ${where}`).run(...(names.map((n) => set[n]) as any[]), ...(keys as any[]));
      }
    }
    if (keep !== undefined) {
      const prompts = (db.query("select idx from steps where step_type = ? order by idx").all(USER_INPUT_STEP) as { idx: number }[]).map((r) => r.idx);
      const cut = prompts[keep];
      if (cut !== undefined) for (const t of STEP_TABLES) if (tables.some((x) => x.name === t)) db.query(`delete from ${t} where idx >= ?`).run(cut);
    }
    db.exec("commit");
  } catch (e) {
    try {
      db.exec("rollback");
    } catch {}
    throw e;
  } finally {
    db.close();
  }
  if (existsSync(brain(from))) cpSync(brain(from), brain(to), { recursive: true });
}

export function discardStore(nativeId: string) {
  for (const f of [conversationFile(nativeId), `${conversationFile(nativeId)}-wal`, `${conversationFile(nativeId)}-shm`]) rmSync(f, { force: true });
  rmSync(brain(nativeId), { recursive: true, force: true });
}

export const agyFork: AdapterFork = {
  async fork(r: ForkRequest) {
    const msgs = await reader.replay(r.nativeId, r.projectPath).then((x) => x.msgs);
    const keep = promptsKept(msgs, r.upTo);
    const id = randomUUID();
    copyStore(r.nativeId, id, keep);
    try {
      // Read back: the fork has the original's messages up to the fork point, under the same ids.
      const want = r.upTo ? msgs.slice(0, msgs.findIndex((m) => m.id === r.upTo) + 1) : msgs;
      const got = (await reader.replay(id, r.projectPath)).msgs;
      const same = got.length === want.length && got.every((m, i) => m.id === want[i]!.id && m.role === want[i]!.role);
      if (!same) throw new Error(`Antigravity read the fork back with ${got.length} messages, not ${want.length}.`);
    } catch (e) {
      discardStore(id);
      throw e;
    }
    reader.forget();
    return id;
  },
  async discard(nativeId) {
    discardStore(nativeId);
    reader.forget();
  },
};
