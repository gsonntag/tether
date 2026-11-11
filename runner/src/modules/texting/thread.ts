// The iMessage thread is shared. Tether and the `textme` CLI (the text-me skill,
// github.com/gsonntag/text-me) text the same phone from the same Photon number, and each one hears
// every reply. So that a reply goes to exactly one of them, each one publishes what it last sent to
// a folder both can read (THREAD_DIR, one JSON file per process):
//   textme-<pid>.json  a textme waiting for a reply: { kind, pid, sentAt, until, id?, tag? }
//   tether-<pid>.json  a runner with texting on:     { kind, pid, lastOut, open: [{ n, until }], sent: [ids] }
// and both apply the same rule (router.ts here, scripts/thread.ts in text-me):
//   1. A threaded reply belongs to whoever sent the message it answers.
//   2. "[my-app] ..." (a waiting textme's tag) belongs to that textme; "3 ..." where [3] is one of
//      Tether's open sessions belongs to Tether.
//   3. Anything else belongs to whoever texted last.
// A file whose process is gone, or a textme past its wait, counts for nothing (and is removed).

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** A textme process waiting for the person's reply. */
export interface Waiter {
  pid: number;
  /** when its text went out (ms) */
  sentAt: number;
  /** when it stops waiting (ms) */
  until: number;
  /** its text's message id, when Photon gave one */
  id?: string;
  /** the first word of its text's leading [tag], lowercased: "[foliation #90] ..." → "foliation" */
  tag?: string;
}

/** What Tether publishes for textme. */
export interface TetherNote {
  lastOut: number;
  open: { n: number; until: number }[];
  sent: string[];
}

export interface Thread {
  /** the textme processes waiting now */
  waiters(now: number): Waiter[];
  publish(note: TetherNote): void;
  clear(): void;
}

export function threadDir(env: Record<string, string | undefined> = process.env): string {
  return env.IMESSAGE_THREAD_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "imessage-thread");
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export class FileThread implements Thread {
  constructor(
    readonly dir: string = threadDir(),
    private isAlive: (pid: number) => boolean = alive,
  ) {}

  private get mine() {
    return join(this.dir, `tether-${process.pid}.json`);
  }

  waiters(now: number): Waiter[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: Waiter[] = [];
    for (const name of names) {
      if (!/^textme-\d+\.json$/.test(name)) continue;
      const file = join(this.dir, name);
      try {
        const w = JSON.parse(readFileSync(file, "utf8"));
        const ok = typeof w?.sentAt === "number" && typeof w?.until === "number" && this.isAlive(w.pid);
        if (!ok) {
          rmSync(file, { force: true });
          continue;
        }
        if (w.until <= now) continue;
        out.push({ pid: w.pid, sentAt: w.sentAt, until: w.until, ...(typeof w.id === "string" ? { id: w.id } : {}), ...(typeof w.tag === "string" ? { tag: w.tag } : {}) });
      } catch {}
    }
    return out;
  }

  publish(note: TetherNote) {
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.mine}.tmp`;
      writeFileSync(tmp, JSON.stringify({ kind: "tether", pid: process.pid, ...note }), { mode: 0o600 });
      renameSync(tmp, this.mine);
    } catch {}
  }

  clear() {
    rmSync(this.mine, { force: true });
  }
}

/** Whether a reply starts with one of the waiters' tags ("[my-app] do x", "my-app: do x"). */
export function addressedToWaiter(reply: string, waiters: Waiter[]): boolean {
  const t = reply.trim().toLowerCase().replace(/^\[\s*/, "");
  return waiters.some((w) => !!w.tag && t.startsWith(w.tag) && /^($|[\s\]:,.-])/.test(t.slice(w.tag.length)));
}

/** For tests, and when texting is off: no textme anywhere. */
export const noThread: Thread = { waiters: () => [], publish: () => {}, clear: () => {} };
