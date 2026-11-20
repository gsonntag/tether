// The texting hub (SPEC §11 Texting, "One number for every computer"): one of a person's runners
// holds the link to their phone (iMessage, Discord) and texts for all of them. The others hand it
// their texts and get back the replies meant for their sessions, through the app:
//
//   spoke ──{t:"texting", to: hub, m}──► server ──{t:"texting", from: spoke, m}──► hub
//
// The server only checks that one end is the other's hub (server/src/relay.ts) and passes `m` on.
// What `m` holds is between the runners (runner/src/modules/texting/hub.ts):
//
// - `req` / `res`: a call and its answer, matched by `rid`. A req can carry files, sent before it
//   as `chunk` frames (the socket keeps their order, so they're all there when the req arrives).
// - `chunk`: up to HUB_CHUNK bytes of a file, base64; `x` names the file, `i` counts from 0, and
//   `end` marks the last one.

/** The hub as each of its spokes is told it (null: none connected). */
export interface TextingHubInfo {
  id: string;
  name: string;
  /** some connector on it is connected: texts can go */
  up: boolean;
  /** the connector texts go to takes images */
  images: boolean;
}

/** What a hub says about itself in its hello (RunnerInfo.textingHub). */
export interface TextingHubState {
  up: boolean;
  images: boolean;
}

/** One file's bytes travel in pieces this big (base64 makes each frame a third bigger). */
export const HUB_CHUNK = 256 * 1024;
/** One file at most this big (the biggest attachment, shared/limits.ts ATTACH_FILE_MAX). */
export const HUB_FILE_MAX = 25 * 1024 * 1024;
/** What one runner may have half-sent to another at once. */
export const HUB_PENDING_MAX = 64 * 1024 * 1024;
/** A file not finished (or not claimed by its req) this long after its last piece is dropped. */
export const HUB_FILE_TTL_MS = 2 * 60_000;
/** Sending waits while the socket's buffer holds more than this (the server closes a socket past 12 MB). */
export const HUB_BUFFER_MAX = 2 * 1024 * 1024;

/** A file a req carries: its bytes came first, as chunks of transfer `x`. */
export interface HubFileRef {
  x: string;
  name: string;
  mimeType: string;
}

export type HubFrame =
  | { k: "req"; rid: string; op: string; args: unknown; files?: HubFileRef[] }
  | { k: "res"; rid: string; ok: boolean; data?: unknown; error?: string }
  | { k: "chunk"; x: string; i: number; data: string; end?: boolean };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200;

/** A hub frame, or null when it isn't one. Rebuilt from the fields that count. */
export function parseHubFrame(v: unknown): HubFrame | null {
  if (!isObj(v)) return null;
  if (v.k === "req") {
    if (!isId(v.rid) || !isId(v.op)) return null;
    let files: HubFileRef[] | undefined;
    if (v.files !== undefined) {
      if (!Array.isArray(v.files) || v.files.length > 10) return null;
      files = [];
      for (const f of v.files) {
        if (!isObj(f) || !isId(f.x) || typeof f.name !== "string" || f.name.length > 300 || typeof f.mimeType !== "string" || f.mimeType.length > 200) return null;
        files.push({ x: f.x, name: f.name, mimeType: f.mimeType });
      }
    }
    return { k: "req", rid: v.rid, op: v.op, args: v.args, ...(files ? { files } : {}) };
  }
  if (v.k === "res") {
    if (!isId(v.rid) || typeof v.ok !== "boolean") return null;
    return { k: "res", rid: v.rid, ok: v.ok, ...(v.data !== undefined ? { data: v.data } : {}), ...(typeof v.error === "string" ? { error: v.error.slice(0, 2000) } : {}) };
  }
  if (v.k === "chunk") {
    if (!isId(v.x) || !Number.isSafeInteger(v.i) || (v.i as number) < 0 || typeof v.data !== "string" || v.data.length > Math.ceil(HUB_CHUNK / 3) * 4 + 4) return null;
    return { k: "chunk", x: v.x, i: v.i as number, data: v.data, ...(v.end === true ? { end: true } : {}) };
  }
  return null;
}

/** A hub state from a hello, or undefined. */
export function parseHubState(v: unknown): TextingHubState | undefined {
  return isObj(v) ? { up: v.up === true, images: v.images === true } : undefined;
}
