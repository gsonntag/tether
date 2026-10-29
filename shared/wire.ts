// Parsing what comes off a socket. Browsers and runners are authenticated, but a malformed
// frame must still never throw inside the relay or reach a handler half-formed.

import type { BrowserToServer, RunnerToServer } from "./protocol";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function json(raw: string | ArrayBuffer | Uint8Array): unknown {
  try {
    return JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
  } catch {
    return undefined;
  }
}

/** A browser frame, or null when it isn't one the server understands. */
export function parseBrowserMessage(raw: string | ArrayBuffer | Uint8Array): BrowserToServer | null {
  const m = json(raw);
  if (!isObj(m)) return null;
  if (m.t === "ping") return { t: "ping" };
  if (m.t === "rpc" && isStr(m.id) && isStr(m.runnerId) && isStr(m.op)) return m as BrowserToServer;
  return null;
}

/** A runner frame, or null when it isn't one the server understands. */
export function parseRunnerMessage(raw: string | ArrayBuffer | Uint8Array): RunnerToServer | null {
  const m = json(raw);
  if (!isObj(m)) return null;
  switch (m.t) {
    case "hello":
      return isObj(m.runner) && isStr(m.runner.id) ? (m as RunnerToServer) : null;
    case "result":
      return isStr(m.id) && typeof m.ok === "boolean" ? (m as RunnerToServer) : null;
    case "event":
      return isStr(m.sessionId) && Number.isInteger(m.seq) && isObj(m.event) ? (m as RunnerToServer) : null;
    case "summary":
      return isObj(m.summary) ? (m as RunnerToServer) : null;
    case "term":
      return isStr(m.attachId) && typeof m.data === "string" ? (m as RunnerToServer) : null;
    case "termEnd":
      return isStr(m.attachId) ? (m as RunnerToServer) : null;
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
