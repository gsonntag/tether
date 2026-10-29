// Parsing what comes off a socket. Browsers and runners are authenticated, but a malformed
// frame must still never throw inside the relay or reach a handler half-formed.

import type { BrowserToServer, HarnessInfo, OpName, RunnerInfo, RunnerToServer, SummaryUpdate } from "./protocol";
import { HARNESS_LABELS, type HarnessId, type SessionEvent } from "./transcript";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function json(raw: string | ArrayBuffer | Uint8Array): unknown {
  try {
    return JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    return undefined;
  }
}

const MAX_ID = 512;
const isId = (v: unknown): v is string => isStr(v) && v.length <= MAX_ID;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * A browser frame, or null when it isn't one the server understands. The result is rebuilt from
 * the fields the server uses, so nothing unexpected rides along.
 */
export function parseBrowserMessage(raw: string | ArrayBuffer | Uint8Array): BrowserToServer | null {
  const m = json(raw);
  if (!isObj(m)) return null;
  if (m.t === "ping") return { t: "ping" };
  if (m.t !== "rpc" || !isId(m.id) || !isId(m.runnerId) || !isId(m.op)) return null;
  // args is always an object: ops read named fields from it.
  if (m.args !== undefined && !isObj(m.args)) return null;
  return { t: "rpc", id: m.id, runnerId: m.runnerId, op: m.op as OpName, args: m.args ?? {} };
}

function parseHarness(v: unknown): HarnessInfo | null {
  if (!isObj(v) || !isStr(v.id) || !Object.hasOwn(HARNESS_LABELS, v.id) || typeof v.version !== "string") return null;
  return { id: v.id as HarnessId, version: v.version };
}

function parseRunnerInfo(v: unknown): Omit<RunnerInfo, "connectedAt"> | null {
  if (!isObj(v) || !isId(v.id) || typeof v.hostname !== "string" || typeof v.version !== "string" || !isNum(v.protocol) || !Array.isArray(v.harnesses)) return null;
  // Unknown harnesses (a newer runner) are left out rather than refusing the runner.
  const harnesses = v.harnesses.map(parseHarness).filter((h): h is HarnessInfo => !!h);
  const name = typeof v.name === "string" && v.name.trim() ? v.name : v.hostname || v.id;
  return { id: v.id, name, hostname: v.hostname, version: v.version, protocol: v.protocol, harnesses };
}

/** A runner frame, or null when it isn't one the server understands. Rebuilt like browser frames. */
export function parseRunnerMessage(raw: string | ArrayBuffer | Uint8Array): RunnerToServer | null {
  const m = json(raw);
  if (!isObj(m)) return null;
  switch (m.t) {
    case "hello": {
      const runner = parseRunnerInfo(m.runner);
      return runner ? { t: "hello", runner } : null;
    }
    case "result":
      if (!isId(m.id) || typeof m.ok !== "boolean") return null;
      return { t: "result", id: m.id, ok: m.ok, data: m.data, error: optStr(m.error) };
    case "event":
      if (!isId(m.sessionId) || !Number.isSafeInteger(m.seq) || !isObj(m.event) || !isStr(m.event.type)) return null;
      return { t: "event", sessionId: m.sessionId, seq: m.seq as number, event: m.event as unknown as SessionEvent };
    case "summary":
      if (!isObj(m.summary) || !["all", "upsert", "remove"].includes(m.summary.kind as string) || !Number.isSafeInteger(m.summary.seq) || !isId(m.summary.epoch)) return null;
      return { t: "summary", summary: m.summary as unknown as SummaryUpdate };
    case "term":
      return isId(m.attachId) && typeof m.data === "string" ? { t: "term", attachId: m.attachId, data: m.data } : null;
    case "termEnd":
      return isId(m.attachId) ? { t: "termEnd", attachId: m.attachId, reason: optStr(m.reason) } : null;
    case "ping":
      return { t: "ping" };
  }
  return null;
}

/** Terminal bytes travel as base64 inside JSON frames. */
export function encodeChunk(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeChunk(data: string): Uint8Array {
  const s = atob(data);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * The id of an rpc (from a browser) or result (from a runner) frame that didn't parse, so the
 * caller can answer it with an error instead of leaving it to time out.
 */
export function malformedId(raw: string | ArrayBuffer | Uint8Array, t: "rpc" | "result"): string | null {
  const m = json(raw);
  return isObj(m) && m.t === t && isId(m.id) ? m.id : null;
}
