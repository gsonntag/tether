// MCP OAuth for the registry's http/sse servers, per the MCP authorization spec: the server's 401
// points at its protected-resource metadata (RFC 9728), that names the authorization server
// (RFC 8414 metadata), Tether registers itself there when no client id is configured (RFC 7591),
// and the browser signs in with PKCE (S256). The redirect is a route on the Tether app
// (server/: /api/mcp-oauth/callback), which relays code and state back to this runner.
//
// Decision 8: the tokens live here only, in the runner's config dir (mcp/tokens.json, mode 600),
// keyed by registry server id. They reach a harness as an Authorization header at session launch
// (registry.ts sessionMcp); the global export writes the server without them, and the CLIs sign in
// by themselves. The PKCE verifier never leaves this process: the state names the runner (for the
// relay) and a random key into `pending`, used once, for ten minutes.
//
// The protocol pieces are @modelcontextprotocol/sdk's client/auth helpers; Tether keeps the
// bookkeeping (which server, which redirect, when to refresh).

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  selectResourceURL,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InvalidClientError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  UnauthorizedClientError,
  UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpAuthStart, McpAuthStatus, McpTransport } from "../../../web/src/shared/protocol";
import { Mutex } from "../context/git";
import { writeAtomic } from "../context/store";
import { normalizeUrl } from "./formats";
import { tokensFile } from "./paths";
import type { RegistryServer } from "./store";

/** The app route the authorization server sends the browser back to (server/src/index.ts). */
export const CALLBACK_PATH = "/api/mcp-oauth/callback";

/** Refresh this long before the access token runs out. */
const EARLY_MS = 2 * 60_000;
/** A token without a stated lifetime is checked against the server (and refreshed on 401) this often. */
const VERIFY_MS = 10 * 60_000;
/** How long a started sign-in can be finished. */
const PENDING_MS = 10 * 60_000;
const FETCH_MS = 10_000;
/** A refresh that failed for a passing reason (network, 5xx, 429) is tried again after this, doubling up to VERIFY_MS. */
const RETRY_FIRST_MS = 30_000;

interface StoredTokens {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  scope?: string;
  /** ms epoch; absent when the server didn't say */
  expiresAt?: number;
  /** last time the server took it (tokens without expiresAt) */
  verifiedAt?: number;
}

export interface OAuthRecord {
  /** the server URL (normalized) this is for: a changed URL needs a new sign-in */
  url: string;
  /** the server answered 401 without credentials (true), or took the request without any (false) */
  required?: boolean;
  checkedAt?: number;
  /** from the 401's WWW-Authenticate */
  resourceMetadataUrl?: string;
  scope?: string;
  authServer?: string;
  metadata?: AuthorizationServerMetadata;
  /** the RFC 8707 resource indicator, as the server's metadata spells it */
  resource?: string;
  client?: OAuthClientInformationMixed;
  /** the redirect URI a registered client is for (a different app URL registers again) */
  redirectUri?: string;
  /** the client id was entered by hand: never registered again */
  manualClient?: boolean;
  /** a sign-in with this client finished (a hand-entered one is only reused then; a typo asks again) */
  clientOk?: boolean;
  tokens?: StoredTokens;
  /** why the last refresh was refused (shown as Expired until the next sign-in) */
  failed?: string;
}

interface TokenFile {
  servers: Record<string, OAuthRecord>;
}

// ---------------- the store (tokens.json, mode 600) ----------------

export function readTokens(): TokenFile {
  try {
    const v = JSON.parse(readFileSync(tokensFile(), "utf8"));
    if (v && typeof v.servers === "object" && v.servers) return v;
  } catch {}
  return { servers: {} };
}

const lock = new Mutex();

/** A read-modify-write of one server's record; `fn` returning undefined deletes it. */
function update(id: string, fn: (cur: OAuthRecord | undefined) => OAuthRecord | undefined): Promise<OAuthRecord | undefined> {
  return lock.run(async () => {
    const data = readTokens();
    const next = fn(data.servers[id] ? structuredClone(data.servers[id]) : undefined);
    if (next) data.servers[id] = next;
    else delete data.servers[id];
    writeAtomic(tokensFile(), JSON.stringify(data, null, 2) + "\n", 0o600);
    return next;
  });
}

const urlOf = (s: RegistryServer) => (s.transport.type === "stdio" ? "" : normalizeUrl(s.transport.url));

/** This server's record, if it is for the server's current URL. */
export function recordFor(s: RegistryServer, data = readTokens()): OAuthRecord | undefined {
  const r = data.servers[s.id];
  return r && r.url === urlOf(s) ? r : undefined;
}

/** A server whose own headers already authorize it (a pasted token) doesn't need OAuth. */
export const hasStaticAuth = (t: McpTransport) => t.type !== "stdio" && Object.keys(t.headers).some((k) => k.toLowerCase() === "authorization");

/** Tether can sign in to it: an http or SSE server without its own Authorization header. */
export const authorizable = (s: RegistryServer) => s.transport.type !== "stdio" && !hasStaticAuth(s.transport);

/**
 * Connected: a token (refreshed at launch when it runs out). Expired: the token ran out with no
 * refresh token, or a refresh was refused. Needs authorization: the server answered 401 and there
 * is no token. Undefined: nothing known (or not an OAuth server).
 */
export function authStatus(s: RegistryServer, rec = recordFor(s), now = Date.now()): McpAuthStatus | undefined {
  if (!authorizable(s)) return undefined;
  const t = rec?.tokens;
  if (t) {
    if (rec!.failed) return "expired";
    if (t.expiresAt !== undefined && t.expiresAt <= now && !t.refresh_token) return "expired";
    return "connected";
  }
  return rec?.required ? "needs" : undefined;
}

/** Forgets a deleted server's record. */
export function forget(id: string) {
  pendingDrop((p) => p.serverId === id);
  stopTimer(id);
  return update(id, () => undefined);
}

/**
 * Sign out: drops the tokens, keeps the client registration and what discovery found. A refresh
 * already on its way doesn't bring them back (it only writes over the refresh token it used).
 */
export async function signOut(s: RegistryServer) {
  stopTimer(s.id);
  await update(s.id, (cur) => (cur ? { ...cur, tokens: undefined, failed: undefined } : undefined));
  changed(s.id);
}

/** Forgets a client the authorization server refused (invalid_client): the next Authorize registers again or asks for a client id. */
function dropClient(id: string, clientId: string) {
  return update(id, (c) => (c && c.client?.client_id === clientId ? { ...c, client: undefined, manualClient: undefined, clientOk: undefined, redirectUri: undefined } : c));
}

// ---------------- change listeners (live sessions that can swap their MCP config) ----------------

const listeners = new Set<(id: string) => void>();

/** Called with a server id whenever its token changes (signed in, refreshed, signed out). */
export function onTokens(fn: (id: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(id: string) {
  for (const fn of listeners) {
    try {
      fn(id);
    } catch (e: any) {
      console.error(`mcp oauth: listener failed: ${e?.message ?? e}`);
    }
  }
}

// ---------------- network ----------------

const timedFetch = (url: string | URL, init?: RequestInit) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(FETCH_MS) });

/**
 * One unauthenticated (or bearer) request the way an MCP client opens a session: an `initialize`
 * POST for streamable HTTP, an event-stream GET for SSE. Only the status and WWW-Authenticate matter.
 */
async function probe(t: Extract<McpTransport, { type: "http" | "sse" }>, token?: string): Promise<Response> {
  const headers: Record<string, string> = { ...t.headers };
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit =
    t.type === "sse"
      ? { method: "GET", headers: { ...headers, Accept: "text/event-stream" } }
      : {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tether", version: "1" } } }),
        };
  const res = await timedFetch(t.url, init);
  res.body?.cancel().catch(() => {});
  return res;
}

/**
 * Asks the server whether it wants OAuth (a 401 without credentials) and remembers the answer and
 * its WWW-Authenticate hints. With a token it checks that one instead and refreshes on 401.
 */
export async function check(s: RegistryServer): Promise<McpAuthStatus | undefined> {
  if (!authorizable(s) || s.transport.type === "stdio") return undefined;
  const rec = recordFor(s);
  if (rec?.tokens) {
    await fresh(s, { verify: true });
    return authStatus(s);
  }
  const res = await probe(s.transport);
  const www = res.status === 401 ? extractWWWAuthenticateParams(res) : {};
  await update(s.id, (cur) => ({
    ...(cur && cur.url === urlOf(s) ? cur : { url: urlOf(s) }),
    // Unknown (undefined) when it answered neither 401 nor OK: Authorize stays offered.
    required: res.status === 401 ? true : res.ok ? false : undefined,
    checkedAt: Date.now(),
    ...(www.resourceMetadataUrl ? { resourceMetadataUrl: www.resourceMetadataUrl.href } : {}),
    ...(www.scope ? { scope: www.scope } : {}),
  }));
  return authStatus(s);
}

/** Checks the servers nothing is known about yet, waiting at most `waitMs` (the rest finish in the background). */
export async function checkUnknown(servers: RegistryServer[], waitMs: number): Promise<void> {
  const data = readTokens();
  const now = Date.now();
  const todo = servers.filter(
    (s) => s.enabled && authorizable(s) && !recordFor(s, data)?.checkedAt && !recordFor(s, data)?.tokens && !checking.has(s.id) && now - (unreachable.get(s.id) ?? 0) > RETRY_MS,
  );
  if (!todo.length) return;
  const all = Promise.all(
    todo.map((s) => {
      checking.add(s.id);
      return check(s)
        .catch(() => void unreachable.set(s.id, Date.now()))
        .finally(() => checking.delete(s.id));
    }),
  );
  await Promise.race([all, Bun.sleep(waitMs)]);
}
const checking = new Set<string>();
/** servers that didn't answer the check, and when: not asked again for a while (each list would wait on them) */
const unreachable = new Map<string, number>();
const RETRY_MS = 10 * 60_000;

// ---------------- refresh ----------------

const refreshing = new Map<string, Promise<void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** failed refresh attempts in a row (passing failures), for the backoff */
const retries = new Map<string, number>();

function stopTimer(id: string) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  retries.delete(id);
}

/** The client is no good: the refresh token can't be used with it either. */
const clientRefused = (e: unknown) => e instanceof InvalidClientError || e instanceof UnauthorizedClientError;
/**
 * A refusal retrying won't change. Everything else (a network error, ServerError, which the SDK also
 * makes of any non-JSON error page such as a gateway's 502, temporarily_unavailable, 429) is passing.
 */
const refused = (e: unknown) =>
  e instanceof InvalidGrantError || clientRefused(e) || e instanceof InvalidScopeError || e instanceof UnsupportedGrantTypeError || e instanceof InvalidTargetError;

/** An error message short enough for a log line and tokens.json (error pages can be long). */
const brief = (e: any) => String(e?.message || e?.errorCode || e).replace(/\s+/g, " ").slice(0, 200);

const toStored = (t: OAuthTokens, prev?: StoredTokens): StoredTokens => ({
  access_token: t.access_token,
  token_type: t.token_type,
  // A refresh that doesn't return a new refresh token keeps the old one.
  refresh_token: t.refresh_token ?? prev?.refresh_token,
  scope: t.scope ?? prev?.scope,
  expiresAt: typeof t.expires_in === "number" && Number.isFinite(t.expires_in) ? Date.now() + t.expires_in * 1000 : undefined,
});

/**
 * Trades the refresh token for a new access token. A refusal (invalid_grant, invalid_client…) marks
 * the record failed (Expired); a passing failure keeps the token and tries again later. The result
 * is only written while the record still holds the refresh token used (not after a sign-out).
 */
function refresh(s: RegistryServer): Promise<void> {
  const cur = refreshing.get(s.id);
  if (cur) return cur;
  const p = (async () => {
    const rec = recordFor(s);
    const rt = rec?.tokens?.refresh_token;
    if (!rec || !rt || !rec.client || !rec.authServer) return;
    const same = (c: OAuthRecord | undefined): c is OAuthRecord => c?.tokens?.refresh_token === rt;
    let wrote = false;
    try {
      const t = await refreshAuthorization(rec.authServer, {
        metadata: rec.metadata,
        clientInformation: rec.client,
        refreshToken: rt,
        resource: rec.resource,
        fetchFn: timedFetch,
      });
      await update(s.id, (c) => (same(c) ? ((wrote = true), { ...c, tokens: { ...toStored(t, c.tokens), verifiedAt: Date.now() }, failed: undefined }) : c));
      if (!wrote) return;
      retries.delete(s.id);
      schedule(s);
      changed(s.id);
    } catch (e: any) {
      if (refused(e)) {
        console.error(`mcp: ${s.name}: refresh refused (${e.errorCode}: ${brief(e)}); sign in again`);
        const noClient = clientRefused(e) ? { client: undefined, manualClient: undefined, clientOk: undefined, redirectUri: undefined } : {};
        await update(s.id, (c) => (same(c) ? ((wrote = true), { ...c, failed: brief(e), ...noClient }) : c));
        if (wrote) changed(s.id);
      } else {
        console.error(`mcp: ${s.name}: couldn't refresh its token: ${brief(e)}`);
        if (same(recordFor(s))) retryLater(s);
      }
    }
  })().finally(() => refreshing.delete(s.id));
  refreshing.set(s.id, p);
  return p;
}

/** After a passing failure: refresh again in 30 s, 1 min, 2 min… up to ten minutes. */
function retryLater(s: RegistryServer) {
  const n = retries.get(s.id) ?? 0;
  clearTimeout(timers.get(s.id));
  const timer = setTimeout(() => {
    timers.delete(s.id);
    void refresh(s);
  }, Math.min(RETRY_FIRST_MS * 2 ** n, VERIFY_MS));
  timer.unref?.();
  timers.set(s.id, timer);
  retries.set(s.id, n + 1);
}

/** Refreshes ahead of expiry while the runner runs, so live sessions that can swap headers (Claude) keep working. */
function schedule(s: RegistryServer) {
  clearTimeout(timers.get(s.id));
  timers.delete(s.id);
  const t = recordFor(s)?.tokens;
  if (!t?.expiresAt || !t.refresh_token) return;
  const timer = setTimeout(() => {
    timers.delete(s.id);
    void refresh(s);
  }, Math.min(Math.max(30_000, t.expiresAt - Date.now() - EARLY_MS), 2 ** 31 - 1));
  timer.unref?.();
  timers.set(s.id, timer);
}

/**
 * The access token to send, refreshed first when it runs out within two minutes. A token whose
 * lifetime wasn't stated is checked against the server every ten minutes (`verify`: now), and a
 * 401 refreshes it. Undefined when there's no usable token.
 */
export async function fresh(s: RegistryServer, opts: { verify?: boolean } = {}): Promise<string | undefined> {
  let rec = recordFor(s);
  let t = rec?.tokens;
  if (!t || rec!.failed || s.transport.type === "stdio") return undefined;
  if (t.expiresAt !== undefined) {
    if (t.expiresAt - Date.now() < EARLY_MS) await refresh(s);
    else if (!timers.has(s.id)) schedule(s);
  } else if (opts.verify || !t.verifiedAt || Date.now() - t.verifiedAt > VERIFY_MS) {
    const res = await probe(s.transport, t.access_token).catch(() => undefined);
    if (res?.status === 401) await refresh(s);
    else if (res) await update(s.id, (c) => (c?.tokens ? { ...c, tokens: { ...c.tokens, verifiedAt: Date.now() } } : c));
  }
  rec = recordFor(s);
  t = rec?.tokens;
  if (!t || rec!.failed) return undefined;
  if (t.expiresAt !== undefined && t.expiresAt <= Date.now()) return undefined;
  return t.access_token;
}

/**
 * The transport a session launch uses, with `Authorization: Bearer <token>` when Tether holds one
 * (never written anywhere but the launch). `status` says whether the server still needs a sign-in.
 */
export async function authorized(s: RegistryServer): Promise<{ transport: McpTransport; token: boolean; status?: McpAuthStatus }> {
  if (!authorizable(s) || s.transport.type === "stdio") return { transport: s.transport, token: false };
  const token = await fresh(s).catch(() => undefined);
  if (!token) return { transport: s.transport, token: false, status: authStatus(s) };
  return { transport: { ...s.transport, headers: { ...s.transport.headers, Authorization: `Bearer ${token}` } }, token: true, status: "connected" };
}

// ---------------- sign-in ----------------

interface Pending {
  serverId: string;
  url: string;
  verifier: string;
  redirectUri: string;
  authServer: string;
  metadata?: AuthorizationServerMetadata;
  resource?: string;
  client: OAuthClientInformationMixed;
  manual: boolean;
  at: number;
}

/** state → a started sign-in. In memory only: the verifier never touches disk, and a restart means starting again. */
const pending = new Map<string, Pending>();

function pendingDrop(pred: (p: Pending) => boolean) {
  for (const [k, p] of pending) if (pred(p) || Date.now() - p.at > PENDING_MS) pending.delete(k);
}

/** The redirect URI must be an app's callback route (the browser passes its own origin). */
function checkRedirect(uri: string): string {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new Error("Bad redirect URL");
  }
  if (!/^https?:$/.test(u.protocol) || u.pathname !== CALLBACK_PATH || u.search || u.hash) throw new Error("Bad redirect URL");
  return u.href;
}

/**
 * Starts a sign-in: discovery, the client (a configured one, an earlier registration for this
 * redirect, or a new one), then the authorization URL with PKCE and a state bound to this runner.
 * `needsClient` when the authorization server can't register Tether by itself.
 */
export async function startAuth(
  s: RegistryServer,
  opts: { runnerId: string; redirectUri: string; clientId?: string; clientSecret?: string },
): Promise<McpAuthStart> {
  if (s.transport.type === "stdio") throw new Error(`${s.name} runs as a command; only HTTP and SSE servers sign in`);
  if (hasStaticAuth(s.transport)) throw new Error(`${s.name} already sends its own Authorization header`);
  const redirectUri = checkRedirect(opts.redirectUri);
  let rec = recordFor(s);
  if (!rec?.checkedAt) {
    await check(s).catch(() => {});
    rec = recordFor(s);
  }
  const info = await discoverOAuthServerInfo(s.transport.url, {
    resourceMetadataUrl: rec?.resourceMetadataUrl ? new URL(rec.resourceMetadataUrl) : undefined,
    fetchFn: timedFetch,
  });
  const authServer = String(info.authorizationServerUrl);
  const metadata = info.authorizationServerMetadata;
  // The resource indicator: the metadata's own spelling, after checking it's this server's.
  const selected = await selectResourceURL(s.transport.url, {} as any, info.resourceMetadata);
  const resource = selected && info.resourceMetadata ? info.resourceMetadata.resource : undefined;
  const scope = rec?.scope || info.resourceMetadata?.scopes_supported?.join(" ") || undefined;
  // It took a request without credentials and publishes no OAuth metadata: nothing to sign in to.
  if (rec?.required === false && !info.resourceMetadata && !metadata) throw new Error(`${s.name} doesn't ask for a sign-in`);

  let client: OAuthClientInformationMixed | undefined;
  let manual = false;
  if (opts.clientId?.trim()) {
    client = { client_id: opts.clientId.trim(), ...(opts.clientSecret?.trim() ? { client_secret: opts.clientSecret.trim() } : {}) };
    manual = true;
  } else if (rec?.client && rec.authServer === authServer && (rec.manualClient ? rec.clientOk : rec.redirectUri === redirectUri) && !secretExpired(rec.client)) {
    client = rec.client;
    manual = !!rec.manualClient;
  } else if (!metadata || metadata.registration_endpoint) {
    try {
      client = await registerClient(authServer, {
        metadata,
        clientMetadata: {
          client_name: "Tether",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        scope,
        fetchFn: timedFetch,
      });
    } catch (e: any) {
      if (metadata?.registration_endpoint) throw new Error(`${s.name}: couldn't register Tether with its sign-in server: ${e?.message ?? e}`);
    }
  }
  if (!client) return { needsClient: true, redirectUri };

  // `<runner id>.<random>`: the app server's relay reads the runner (server/src/mcpOAuth.ts); the rest is the key here.
  const state = `${Buffer.from(opts.runnerId).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
  const { authorizationUrl, codeVerifier } = await startAuthorization(authServer, { metadata, clientInformation: client, redirectUrl: redirectUri, scope, state, resource });
  await update(s.id, (cur) => ({
    ...(cur && cur.url === urlOf(s) ? cur : { url: urlOf(s) }),
    authServer,
    metadata,
    resource,
    client,
    redirectUri,
    manualClient: manual || undefined,
    clientOk: cur?.client?.client_id === client.client_id ? cur.clientOk : undefined,
  }));
  pendingDrop(() => false);
  pending.set(state, { serverId: s.id, url: urlOf(s), verifier: codeVerifier, redirectUri, authServer, metadata, resource, client, manual, at: Date.now() });
  return { url: authorizationUrl.href };
}

/** A registered client whose secret ran out (RFC 7591 client_secret_expires_at, seconds; 0 is never). */
function secretExpired(c: OAuthClientInformationMixed): boolean {
  const exp = (c as { client_secret_expires_at?: number }).client_secret_expires_at;
  return typeof exp === "number" && exp > 0 && exp * 1000 <= Date.now() + 60_000;
}

/**
 * Finishes a sign-in from the app's callback: the state must be one this runner issued (once, within
 * ten minutes, for a server that still has that URL), the issuer must match when the server says it
 * sends one (RFC 9207), then the code is exchanged with the PKCE verifier.
 */
export async function finishAuth(
  p: { state: string; code?: string; error?: string; errorDescription?: string; iss?: string },
  servers: RegistryServer[],
): Promise<{ id: string; name: string }> {
  pendingDrop(() => false);
  const pend = pending.get(p.state);
  pending.delete(p.state);
  if (!pend) throw new Error("This sign-in has expired or was already used. Start it again from Tether.");
  const s = servers.find((x) => x.id === pend.serverId);
  if (!s || urlOf(s) !== pend.url) throw new Error("That MCP server changed or was removed while signing in.");
  if (p.error) {
    if (p.error === "invalid_client" || p.error === "unauthorized_client") await dropClient(s.id, pend.client.client_id);
    throw new Error(`${s.name}: ${p.errorDescription || p.error}`);
  }
  if (!p.code) throw new Error(`${s.name}: the sign-in returned no code.`);
  const issuer = pend.metadata?.issuer;
  const issPromised = (pend.metadata as any)?.authorization_response_iss_parameter_supported === true;
  if ((p.iss !== undefined && issuer && p.iss !== issuer) || (p.iss === undefined && issPromised)) {
    throw new Error(`${s.name}: the sign-in came back from the wrong server.`);
  }
  const t = await exchangeAuthorization(pend.authServer, {
    metadata: pend.metadata,
    clientInformation: pend.client,
    authorizationCode: p.code,
    codeVerifier: pend.verifier,
    redirectUri: pend.redirectUri,
    resource: pend.resource,
    fetchFn: timedFetch,
  }).catch(async (e) => {
    if (clientRefused(e)) await dropClient(s.id, pend.client.client_id);
    throw e;
  });
  // The tokens belong to the client that got them (another sign-in may have started meanwhile).
  await update(s.id, (cur) => ({
    ...(cur ?? { url: pend.url }),
    required: true,
    authServer: pend.authServer,
    metadata: pend.metadata,
    resource: pend.resource,
    client: pend.client,
    redirectUri: pend.redirectUri,
    manualClient: pend.manual || undefined,
    clientOk: true,
    tokens: { ...toStored(t), verifiedAt: Date.now() },
    failed: undefined,
  }));
  retries.delete(s.id);
  schedule(s);
  changed(s.id);
  return { id: s.id, name: s.name };
}

/** For tests: drops in-memory sign-ins and timers. */
export function resetOAuth() {
  pending.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  retries.clear();
  refreshing.clear();
  checking.clear();
  unreachable.clear();
}
