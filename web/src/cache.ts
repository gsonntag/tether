// Last-seen transcripts kept in IndexedDB, so a session reopens instantly from the saved copy
// while the runner resumes it. Best effort: any IndexedDB failure just means no cached copy.
import type { SessionSnapshot } from "./shared/protocol";

const KEEP = 40;

interface Entry {
  key: string;
  savedAt: number;
  snap: SessionSnapshot;
}

let db: Promise<IDBDatabase> | undefined;
function open() {
  db ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("tether", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("sessions", { keyPath: "key" }).createIndex("savedAt", "savedAt");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return db;
}

function req<T>(r: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function store(mode: IDBTransactionMode) {
  return (await open()).transaction("sessions", mode).objectStore("sessions");
}

export async function getCached(runnerId: string, sessionId: string): Promise<SessionSnapshot | undefined> {
  try {
    const e: Entry | undefined = await req((await store("readonly")).get(`${runnerId}:${sessionId}`));
    return e?.snap;
  } catch {
    return undefined;
  }
}

export async function putCached(runnerId: string, snap: SessionSnapshot) {
  try {
    const s = await store("readwrite");
    s.put({ key: `${runnerId}:${snap.session.id}`, savedAt: Date.now(), snap } satisfies Entry);
    // Drop the least recently saved beyond KEEP.
    const keys = await req(s.index("savedAt").getAllKeys());
    for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) s.delete(k);
  } catch {}
}

export async function dropCached(runnerId: string, sessionId: string) {
  try {
    (await store("readwrite")).delete(`${runnerId}:${sessionId}`);
  } catch {}
}
