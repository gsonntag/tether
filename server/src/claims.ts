// The Foliation identity token's claim rules (contracts/identity.md), as Foliation's own verifiers
// apply them (internal/identity, @foliation/sdk). jose checks the signature, issuer, audience and
// times; this refuses a token whose claims disagree with each other, so nothing half-trusted gets
// in. That includes app user tokens (`tok`, contracts/app-user-tokens.md §5): a person's
// command-line access with their current role, never together with svc, anon, pub or caller.
// identity.test.ts runs Foliation's published vectors (testdata/identity-vectors.json) through it.

import { decodeProtectedHeader } from "jose";

const MEMBER_ROLES = new Set(["owner", "editor", "viewer"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CALL_DEPTH = 4;
const MAX_TOKEN_LENGTH = 8192;

/** Who a valid identity token says is calling. */
export interface Claims {
  sub: string;
  email: string;
  name: string;
  role: string;
  picture: string;
  anon: boolean;
  pub: boolean;
  svc: boolean;
  /** an app user token: the person's command-line tool, not their browser */
  tok: boolean;
  /** an app-to-app call */
  app: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** base64url exactly as encoded: no padding or stray characters, and no unused trailing bits. */
function canonicalBytes(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.toString("base64url") === s ? b : null;
}

/**
 * The checks jose leaves to us before it verifies: a canonical compact JWS of sane size, with a
 * header that is EdDSA, typ JWT (or none) and no `crit`. True when the token may go on to jose.
 */
export function wellFormed(token: string): boolean {
  if (!token || token.length > MAX_TOKEN_LENGTH) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const bytes = parts.map(canonicalBytes);
  if (bytes.some((b) => !b)) return false;
  // JSON segments are plain UTF-8 JSON: a byte order mark is malformed, though JSON.parse would skip it.
  if (bytes.slice(0, 2).some((b) => b![0] === 0xef && b![1] === 0xbb && b![2] === 0xbf)) return false;
  let h: Record<string, unknown>;
  try {
    h = decodeProtectedHeader(token) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (h.kid !== undefined && typeof h.kid !== "string") return false;
  return h.alg === "EdDSA" && (h.typ === undefined || h.typ === "JWT") && h.crit === undefined;
}

/**
 * A verified payload's claims, or null when they break Foliation's rules. `audience` is the one
 * the token was checked against: a `fol dev` token (`dev`) only ever for a dev audience.
 */
export function checkClaims(c: Record<string, unknown>, audience: string, nowSec = Date.now() / 1000): Claims | null {
  for (const k of ["iss", "aud", "sub", "email", "name", "org", "app", "role", "jti"]) if (typeof c[k] !== "string") return null;
  for (const k of ["iat", "exp"]) if (!Number.isSafeInteger(c[k])) return null;
  // Issued in the future beyond the skew (jose leaves iat alone).
  if ((c.iat as number) > nowSec + 5) return null;
  for (const k of ["anon", "pub", "svc", "tok", "dev"]) if (c[k] !== undefined && typeof c[k] !== "boolean") return null;
  if (c.picture !== undefined && typeof c.picture !== "string") return null;
  if (c.sid !== undefined && typeof c.sid !== "string") return null;
  const sub = c.sub as string;
  const role = c.role as string;
  const email = c.email as string;
  const anon = c.anon === true;
  const pub = c.pub === true;
  const svc = c.svc === true;
  const tok = c.tok === true;

  const call = appCall(c, anon, pub, svc);
  if (call === null) return null;
  // Visitors: anon, the role "anonymous" and an anon:<16 bytes> subject go together.
  if (sub === "") return null;
  if (anon !== (role === "anonymous") || anon !== sub.startsWith("anon:")) return null;
  if (anon) {
    if (!pub || email !== "" || canonicalBytes(sub.slice(5))?.length !== 16) return null;
  } else {
    if (!MEMBER_ROLES.has(role)) return null;
    if (pub && role !== "viewer") return null;
  }
  // Service tokens: svc and an svc:<uuid> subject go together; no email, a viewer or editor.
  if (svc !== sub.startsWith("svc:")) return null;
  if (svc && (!UUID.test(sub.slice(4)) || email !== "" || anon || pub || (role !== "viewer" && role !== "editor"))) return null;
  // App user tokens: a person with an email, never anything else at once.
  if (tok && (anon || pub || svc || call || "obo" in c || email === "")) return null;
  const dev = c.dev === true;
  const sid = (c.sid as string | undefined) ?? "";
  if (dev !== (sid !== "") || (dev && (svc || tok || call))) return null;
  if (dev !== audience.endsWith("#dev")) return null;
  return { sub, email, name: c.name as string, role, picture: (c.picture as string | undefined) ?? "", anon, pub, svc, tok, app: call };
}

/** True for a valid app-to-app call, false for none, null when its claims are broken. */
function appCall(c: Record<string, unknown>, anon: boolean, pub: boolean, svc: boolean): boolean | null {
  const sub = c.sub as string;
  if (c.caller !== undefined && !isObj(c.caller)) return null;
  if (c.obo !== undefined && !isObj(c.obo)) return null;
  const caller = c.caller as Record<string, unknown> | undefined;
  const obo = c.obo as Record<string, unknown> | undefined;
  if ((caller !== undefined) !== sub.startsWith("app:")) return null;
  if (obo !== undefined && caller === undefined) return null;
  if (caller === undefined) return false;
  const id = sub.slice(4);
  if (!UUID.test(id)) return null;
  if (c.email !== "" || anon || pub || svc || (c.picture !== undefined && c.picture !== "")) return null;
  if (c.role !== "viewer" && c.role !== "editor") return null;
  const { org, app, id: callId, depth, chain, public: isPublic } = caller;
  if (isPublic !== undefined && typeof isPublic !== "boolean") return null;
  if (typeof org !== "string" || typeof app !== "string" || typeof callId !== "string" || !org || !app || !callId) return null;
  if (!Number.isSafeInteger(depth) || !Array.isArray(chain) || !chain.every((a) => typeof a === "string" && UUID.test(a))) return null;
  const n = depth as number;
  if (n < 1 || n > MAX_CALL_DEPTH || chain.length !== n || chain[n - 1] !== id) return null;
  if (obo === undefined) return true;
  const { sub: oboSub, email, name, role, picture, tok } = obo;
  if (typeof oboSub !== "string" || typeof email !== "string" || typeof name !== "string" || typeof role !== "string") return null;
  if (picture !== undefined && typeof picture !== "string") return null;
  if (tok !== undefined && typeof tok !== "boolean") return null;
  if (!UUID.test(oboSub) || email === "" || !["owner", "editor", "viewer", "none"].includes(role)) return null;
  return true;
}
