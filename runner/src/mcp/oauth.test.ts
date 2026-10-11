// MCP OAuth against a local fake MCP server + authorization server (Bun.serve on 127.0.0.1, no real
// network): discovery from the 401, dynamic registration, PKCE, the state's binding to this runner
// and one sign-in, the token store's 600 mode, refresh before expiry and on 401, a refused refresh,
// header injection at launch (also over Tether's own tokenless export), and an export that never
// carries a token.

import { resetHome } from "../testenv";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchWith } from "../connectors/launch";
import { put } from "../context/fixtures";
import { harness } from "../context/paths";
import { exportRegistry } from "./export";
import { argvSafeMcp } from "../connectors/claude";
import { authorized, check, fresh, readTokens, resetOAuth } from "./oauth";
import { serversFile, tokensFile } from "./paths";
import { addServers, finishServerAuth, sessionMcp, sessionServers, setServer, startServerAuth, views } from "./registry";
import { load, resetCache, type RegistryServer } from "./store";

if (!harness.claudeJson().startsWith(tmpdir())) throw new Error("refusing to run: ~/.claude.json is not in a temp home");

const REDIRECT = "https://tether.example/api/mcp-oauth/callback";

// ---------------- the fake servers ----------------

const fake = {
  dcr: true,
  expiresIn: 3600 as number | undefined,
  /** access tokens the MCP server takes */
  valid: new Set<string>(),
  refreshValid: new Set<string>(),
  codes: new Map<string, { challenge: string; redirect: string; client: string; resource?: string }>(),
  registered: [] as any[],
  tokenRequests: [] as Record<string, string>[],
  n: 0,
  issParam: false,
  /** the token endpoint answers this status with an HTML page (a gateway's 502) */
  tokenDown: undefined as number | undefined,
  /** the token endpoint refuses the client */
  badClient: false,
  /** the token endpoint waits for this first */
  tokenGate: undefined as Promise<void> | undefined,
};

const srv = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req): Promise<Response> {
    const u = new URL(req.url);
    const base: string = `http://127.0.0.1:${srv.port}`;
    switch (u.pathname) {
      case "/mcp": {
        const auth = req.headers.get("authorization") ?? "";
        if (fake.valid.has(auth.replace(/^Bearer /, ""))) return Response.json({ jsonrpc: "2.0", id: 0, result: {} });
        return new Response("unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="read write"` },
        });
      }
      case "/.well-known/oauth-protected-resource/mcp":
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      case "/.well-known/oauth-authorization-server":
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(fake.dcr ? { registration_endpoint: `${base}/register` } : {}),
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          ...(fake.issParam ? { authorization_response_iss_parameter_supported: true } : {}),
        });
      case "/register": {
        const body: any = await req.json();
        fake.registered.push(body);
        return Response.json({ ...body, client_id: `client-${fake.registered.length}` }, { status: 201 });
      }
      case "/authorize": {
        const q = u.searchParams;
        const code = `code-${++fake.n}`;
        fake.codes.set(code, { challenge: q.get("code_challenge")!, redirect: q.get("redirect_uri")!, client: q.get("client_id")!, resource: q.get("resource") ?? undefined });
        const to = new URL(q.get("redirect_uri")!);
        to.searchParams.set("code", code);
        to.searchParams.set("state", q.get("state")!);
        return Response.redirect(to.href, 302);
      }
      case "/token": {
        const f = Object.fromEntries(new URLSearchParams(await req.text()));
        fake.tokenRequests.push(f);
        await fake.tokenGate;
        if (fake.tokenDown) return new Response("<html><body>Bad Gateway</body></html>", { status: fake.tokenDown, headers: { "Content-Type": "text/html" } });
        if (fake.badClient) return Response.json({ error: "invalid_client", error_description: "Unknown client" }, { status: 401 });
        const issue = () => {
          const at = `at-${++fake.n}`;
          const rt = `rt-${fake.n}`;
          fake.valid.add(at);
          fake.refreshValid.add(rt);
          return Response.json({ access_token: at, token_type: "Bearer", refresh_token: rt, ...(fake.expiresIn !== undefined ? { expires_in: fake.expiresIn } : {}) });
        };
        if (f.grant_type === "authorization_code") {
          const c = fake.codes.get(f.code);
          fake.codes.delete(f.code);
          const s256 = createHash("sha256").update(f.code_verifier ?? "").digest("base64url");
          if (!c || c.challenge !== s256 || c.redirect !== f.redirect_uri || c.client !== f.client_id) return Response.json({ error: "invalid_grant" }, { status: 400 });
          return issue();
        }
        if (f.grant_type === "refresh_token") {
          if (!fake.refreshValid.has(f.refresh_token)) return Response.json({ error: "invalid_grant", error_description: "Refresh token revoked" }, { status: 400 });
          // no new refresh token: the old one stays usable
          const at = `at-${++fake.n}`;
          fake.valid.add(at);
          return Response.json({ access_token: at, token_type: "Bearer", ...(fake.expiresIn !== undefined ? { expires_in: fake.expiresIn } : {}) });
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => srv.stop(true));

/** A public MCP server: no sign-in, no OAuth metadata anywhere. */
const plain = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (req) => (new URL(req.url).pathname === "/mcp" ? Response.json({ jsonrpc: "2.0", id: 0, result: {} }) : new Response("not found", { status: 404 })),
});
afterAll(() => plain.stop(true));

const MCP_URL = () => `http://127.0.0.1:${srv.port}/mcp`;

beforeEach(() => {
  resetHome();
  resetCache();
  resetOAuth();
  Object.assign(fake, { dcr: true, expiresIn: 3600, issParam: false, registered: [], tokenRequests: [], tokenDown: undefined, badClient: false, tokenGate: undefined });
  fake.valid.clear();
  fake.refreshValid.clear();
  fake.codes.clear();
});

const server = () => load().servers.find((s) => s.name === "docs")!;

async function addDocs() {
  await addServers(MCP_URL(), { name: "docs" });
  return server();
}

/** What the browser does: open the authorization URL, follow it to the app's callback. */
async function browse(url: string): Promise<URLSearchParams> {
  const res = await fetch(url, { redirect: "manual" });
  return new URL(res.headers.get("location")!).searchParams;
}

async function signIn(s: RegistryServer, runnerId = "runner-a") {
  const start = await startServerAuth(s.id, { runnerId, redirectUri: REDIRECT });
  if (!("url" in start)) throw new Error("expected a sign-in URL");
  const q = await browse(start.url);
  return finishServerAuth({ state: q.get("state")!, code: q.get("code")! });
}

/** Makes the stored access token look about to run out. */
function expireSoon(id: string) {
  const data = readTokens();
  data.servers[id].tokens!.expiresAt = Date.now() + 30_000;
  writeFileSync(tokensFile(), JSON.stringify(data));
}

// ---------------- tests ----------------

describe("sign-in", () => {
  test("a 401 marks it Needs authorization; discovery, registration, PKCE and the code exchange connect it", async () => {
    const s = await addDocs();
    expect(views().find((v) => v.id === s.id)).toMatchObject({ oauth: true, auth: "needs" });

    const start = await startServerAuth(s.id, { runnerId: "runner-a", redirectUri: REDIRECT });
    if (!("url" in start)) throw new Error("expected a URL");
    const u = new URL(start.url);
    expect(u.pathname).toBe("/authorize");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(u.searchParams.get("resource")).toBe(MCP_URL());
    expect(u.searchParams.get("scope")).toBe("read write"); // from the 401's WWW-Authenticate
    // Registered once, as a public client for the app's callback.
    expect(fake.registered).toHaveLength(1);
    expect(fake.registered[0]).toMatchObject({ client_name: "Tether", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    // The state names the runner (the app server's relay reads it) and nothing else readable.
    const state = u.searchParams.get("state")!;
    expect(Buffer.from(state.split(".")[0], "base64url").toString()).toBe("runner-a");
    expect(state.split(".")[1].length).toBeGreaterThanOrEqual(40);

    const q = await browse(start.url);
    expect(await finishServerAuth({ state: q.get("state")!, code: q.get("code")! })).toEqual({ id: s.id, name: "docs" });
    expect(views().find((v) => v.id === s.id)?.auth).toBe("connected");
    // The verifier went to the token endpoint, never into the URL.
    expect(fake.tokenRequests[0].code_verifier).toBeTruthy();
    expect(start.url).not.toContain(fake.tokenRequests[0].code_verifier);
  });

  test("tokens.json (and servers.json) are mode 600; the view carries no token", async () => {
    const s = await addDocs();
    await signIn(s);
    expect(statSync(tokensFile()).mode & 0o777).toBe(0o600);
    expect(statSync(serversFile()).mode & 0o777).toBe(0o600);
    const at = readTokens().servers[s.id].tokens!.access_token;
    expect(JSON.stringify(views())).not.toContain(at);
    // The verifier is never stored.
    expect(readFileSync(tokensFile(), "utf8")).not.toMatch(/verifier/i);
  });

  test("a second sign-in reuses the registration for the same redirect, registers again for another", async () => {
    const s = await addDocs();
    await signIn(s);
    await signIn(s);
    expect(fake.registered).toHaveLength(1);
    await startServerAuth(s.id, { runnerId: "runner-a", redirectUri: "http://localhost:5173/api/mcp-oauth/callback" });
    expect(fake.registered).toHaveLength(2);
  });

  test("no registration endpoint: asks for a client id, then signs in with it", async () => {
    fake.dcr = false;
    const s = await addDocs();
    expect(await startServerAuth(s.id, { runnerId: "r", redirectUri: REDIRECT })).toEqual({ needsClient: true, redirectUri: REDIRECT });
    const start = await startServerAuth(s.id, { runnerId: "r", redirectUri: REDIRECT, clientId: "my-app" });
    if (!("url" in start)) throw new Error("expected a URL");
    expect(new URL(start.url).searchParams.get("client_id")).toBe("my-app");
    const q = await browse(start.url);
    await finishServerAuth({ state: q.get("state")!, code: q.get("code")! });
    expect(views()[0].auth).toBe("connected");
    // Kept for next time.
    expect("url" in (await startServerAuth(s.id, { runnerId: "r", redirectUri: REDIRECT }))).toBe(true);
  });

  test("a server that answers without credentials isn't offered a sign-in", async () => {
    await addServers(`http://127.0.0.1:${plain.port}/mcp`, { name: "plain" });
    const v = views()[0];
    expect(v.oauth).toBeUndefined();
    expect(v.auth).toBeUndefined();
    await expect(startServerAuth(v.id, { runnerId: "r", redirectUri: REDIRECT })).rejects.toThrow("plain doesn't ask for a sign-in");
  });

  test("a hand-entered client id is asked for again until a sign-in with it finishes", async () => {
    fake.dcr = false;
    const s = await addDocs();
    const typo = await startServerAuth(s.id, { runnerId: "r", redirectUri: REDIRECT, clientId: "my-ap" });
    expect("url" in typo).toBe(true);
    // The authorization server showed its own error page; the user clicks Authorize again.
    expect(await startServerAuth(s.id, { runnerId: "r", redirectUri: REDIRECT })).toEqual({ needsClient: true, redirectUri: REDIRECT });
  });

  test("invalid_client from the callback or the code exchange forgets the client", async () => {
    const s = await addDocs();
    const a = await startServerAuth(s.id, { runnerId: "r", redirectUri: REDIRECT });
    if (!("url" in a)) throw new Error("expected a URL");
    await expect(finishServerAuth({ state: new URL(a.url).searchParams.get("state")!, error: "invalid_client" })).rejects.toThrow();
    expect(readTokens().servers[s.id].client).toBeUndefined();

    const b = await startServerAuth(s.id, { runnerId: "r", redirectUri: REDIRECT });
    if (!("url" in b)) throw new Error("expected a URL");
    expect(fake.registered).toHaveLength(2); // registered again
    const q = await browse(b.url);
    fake.badClient = true;
    await expect(finishServerAuth({ state: q.get("state")!, code: q.get("code")! })).rejects.toThrow(/Unknown client/);
    expect(readTokens().servers[s.id].client).toBeUndefined();
    fake.badClient = false;
    await signIn(server());
    expect(fake.registered).toHaveLength(3);
    expect(views()[0].auth).toBe("connected");
  });

  test("a stale dynamic registration (secret ran out) registers again", async () => {
    const s = await addDocs();
    await signIn(s);
    const data = readTokens();
    (data.servers[s.id].client as any).client_secret_expires_at = Math.floor(Date.now() / 1000) - 10;
    writeFileSync(tokensFile(), JSON.stringify(data));
    await startServerAuth(s.id, { runnerId: "r", redirectUri: REDIRECT });
    expect(fake.registered).toHaveLength(2);
  });

  test("a redirect that isn't the app's callback route is refused", async () => {
    const s = await addDocs();
    for (const bad of ["https://evil.example/steal", "javascript:alert(1)", `${REDIRECT}?x=1`]) await expect(startServerAuth(s.id, { runnerId: "r", redirectUri: bad })).rejects.toThrow(/redirect/i);
  });

  test("command servers and servers with their own Authorization header don't sign in", async () => {
    await addServers("npx -y some-mcp", { name: "cmd" });
    await addServers(JSON.stringify({ tok: { type: "http", url: `http://127.0.0.1:${srv.port}/other`, headers: { Authorization: "Bearer pasted" } } }));
    for (const v of views()) {
      expect(v.oauth).toBeUndefined();
      await expect(startServerAuth(v.id, { runnerId: "r", redirectUri: REDIRECT })).rejects.toThrow();
    }
  });
});

describe("state binding (CSRF)", () => {
  test("an unknown state, a used one, an error answer and a wrong issuer all fail; nothing is stored", async () => {
    const s = await addDocs();
    await expect(finishServerAuth({ state: `${Buffer.from("runner-a").toString("base64url")}.forged`, code: "x" })).rejects.toThrow(/expired|already used/);

    const start = await startServerAuth(s.id, { runnerId: "runner-a", redirectUri: REDIRECT });
    if (!("url" in start)) throw new Error("expected a URL");
    const q = await browse(start.url);
    // Someone else's code with this state: the PKCE verifier doesn't match theirs, so the exchange fails…
    const other = await startServerAuth(s.id, { runnerId: "runner-a", redirectUri: REDIRECT });
    if (!("url" in other)) throw new Error("expected a URL");
    const q2 = await browse(other.url);
    await expect(finishServerAuth({ state: q.get("state")!, code: q2.get("code")! })).rejects.toThrow();
    // …and the state is spent either way.
    await expect(finishServerAuth({ state: q.get("state")!, code: q.get("code")! })).rejects.toThrow(/expired|already used/);
    expect(readTokens().servers[s.id]?.tokens).toBeUndefined();

    const denied = await startServerAuth(s.id, { runnerId: "runner-a", redirectUri: REDIRECT });
    if (!("url" in denied)) throw new Error("expected a URL");
    await expect(finishServerAuth({ state: new URL(denied.url).searchParams.get("state")!, error: "access_denied", errorDescription: "The user said no" })).rejects.toThrow("docs: The user said no");

    fake.issParam = true;
    const iss = await startServerAuth(s.id, { runnerId: "runner-a", redirectUri: REDIRECT });
    if (!("url" in iss)) throw new Error("expected a URL");
    const q3 = await browse(iss.url);
    await expect(finishServerAuth({ state: q3.get("state")!, code: q3.get("code")!, iss: "https://evil.example" })).rejects.toThrow(/wrong server/);
    expect(readTokens().servers[s.id]?.tokens).toBeUndefined();
  });

  test("a server whose URL changed mid sign-in isn't given the token", async () => {
    const s = await addDocs();
    const start = await startServerAuth(s.id, { runnerId: "r", redirectUri: REDIRECT });
    if (!("url" in start)) throw new Error("expected a URL");
    const q = await browse(start.url);
    await setServer(s.id, { remove: true });
    await expect(finishServerAuth({ state: q.get("state")!, code: q.get("code")! })).rejects.toThrow(/expired|changed or was removed/);
  });
});

describe("refresh", () => {
  test("near expiry: refreshed at launch, the refresh token kept when none comes back", async () => {
    const s = await addDocs();
    await signIn(s);
    const before = readTokens().servers[s.id].tokens!;
    expireSoon(s.id);
    const [srvEntry] = await sessionServers("claude-code", join(process.env.HOME!, "proj"));
    const after = readTokens().servers[s.id].tokens!;
    expect(after.access_token).not.toBe(before.access_token);
    expect(after.refresh_token).toBe(before.refresh_token);
    expect(srvEntry.transport).toMatchObject({ headers: { Authorization: `Bearer ${after.access_token}` } });
    expect(fake.tokenRequests.at(-1)).toMatchObject({ grant_type: "refresh_token", resource: MCP_URL() });
  });

  test("no stated lifetime: a 401 from the server refreshes it", async () => {
    fake.expiresIn = undefined;
    const s = await addDocs();
    await signIn(s);
    const old = readTokens().servers[s.id].tokens!.access_token;
    expect(await fresh(server(), { verify: true })).toBe(old);
    fake.valid.delete(old); // the server stops taking it
    const next = await fresh(server(), { verify: true });
    expect(next).toBeTruthy();
    expect(next).not.toBe(old);
    expect(await check(server())).toBe("connected");
  });

  test("a refused refresh shows Expired, and the session gets a notice instead of a header", async () => {
    const s = await addDocs();
    await signIn(s);
    fake.refreshValid.clear();
    expireSoon(s.id);
    const t = await authorized(server());
    expect(t.token).toBe(false);
    expect(t.status).toBe("expired");
    expect(views()[0].auth).toBe("expired");
    const { servers, auth } = await sessionMcp("claude-code", join(process.env.HOME!, "proj"));
    expect(auth).toEqual([{ id: s.id, name: "docs", status: "expired" }]);
    expect(JSON.stringify(servers)).not.toContain("Bearer");
    // A new sign-in clears it.
    await signIn(server());
    expect(views()[0].auth).toBe("connected");
  });
});

describe("refresh failures", () => {
  test("a gateway's 502 keeps the token (still Connected) and stores no error page", async () => {
    const s = await addDocs();
    await signIn(s);
    const before = readTokens().servers[s.id].tokens!;
    expireSoon(s.id);
    fake.tokenDown = 502;
    const t = await authorized(server());
    // The old token is still good for 30 s: it goes out, and the record isn't marked failed.
    expect(t.token).toBe(true);
    expect(readTokens().servers[s.id].failed).toBeUndefined();
    expect(readFileSync(tokensFile(), "utf8")).not.toContain("Bad Gateway");
    expect(views()[0].auth).toBe("connected");
    // The server comes back: the next launch refreshes.
    fake.tokenDown = undefined;
    await authorized(server());
    expect(readTokens().servers[s.id].tokens!.access_token).not.toBe(before.access_token);
  });

  test("invalid_client on refresh: Expired, and the client is forgotten", async () => {
    const s = await addDocs();
    await signIn(s);
    expireSoon(s.id);
    fake.badClient = true;
    expect((await authorized(server())).status).toBe("expired");
    expect(readTokens().servers[s.id].client).toBeUndefined();
  });

  test("signing out while a refresh is in flight doesn't bring the token back", async () => {
    const s = await addDocs();
    await signIn(s);
    expireSoon(s.id);
    let release!: () => void;
    fake.tokenGate = new Promise((r) => (release = r));
    const inflight = fresh(server());
    while (fake.tokenRequests.at(-1)?.grant_type !== "refresh_token") await Bun.sleep(5);
    await setServer(s.id, { signOut: true });
    release();
    expect(await inflight).toBeUndefined();
    expect(readTokens().servers[s.id].tokens).toBeUndefined();
    expect(views()[0].auth).toBe("needs");
  });
});

describe("launch and export (Decision 8)", () => {
  test("the header goes into each harness's launch; Tether's own export never holds the token", async () => {
    // Claude and Codex set up: the add exports the server into both configs.
    put(harness.claudeJson(), "{}\n");
    put(harness.codexConfig(), "");
    const s = await addDocs();
    const claudeBefore = JSON.parse(readFileSync(harness.claudeJson(), "utf8"));
    expect(claudeBefore.mcpServers.docs).toEqual({ type: "http", url: MCP_URL() });

    // Not signed in: Tether's export already gives Claude the server, so nothing is injected; the notice is.
    const proj = join(process.env.HOME!, "proj");
    let m = await sessionMcp("claude-code", proj);
    expect(m.servers).toEqual([]);
    expect(m.auth).toEqual([{ id: s.id, name: "docs", status: "needs" }]);

    await signIn(s);
    const at = readTokens().servers[s.id].tokens!.access_token;
    // Signed in: the session's copy, with the token, goes in under the export's name.
    m = await sessionMcp("claude-code", proj);
    expect(m.auth).toEqual([]);
    const claude = launchWith("claude-code", { projectPath: proj, servers: m.servers });
    expect(claude.options.mcpServers.docs).toEqual({ type: "http", url: MCP_URL(), headers: { Authorization: `Bearer ${at}` } });
    // Claude's command line (--mcp-config) gets it without the header; the full set goes over stdin.
    const split = argvSafeMcp(claude.options.mcpServers);
    expect(JSON.stringify(split.launch)).not.toContain(at);
    expect(split.launch.docs).toEqual({ type: "http", url: MCP_URL() });
    expect(split.full).toBe(claude.options.mcpServers);
    expect(argvSafeMcp({ x: { type: "stdio", command: "x" } }).full).toBeUndefined();
    const codex = launchWith("codex", { projectPath: proj, servers: (await sessionMcp("codex", proj)).servers });
    expect(codex.options.config["mcp_servers.docs"]).toEqual({ url: MCP_URL(), http_headers: { Authorization: `Bearer ${at}` } });

    // Re-export after signing in (any registry change does one): still no token anywhere.
    exportRegistry(load().servers);
    await setServer(s.id, { trusted: true });
    await setServer(s.id, { enabled: false });
    await setServer(s.id, { enabled: true });
    for (const f of [harness.claudeJson(), harness.codexConfig(), serversFile()]) {
      const text = readFileSync(f, "utf8");
      expect(text).toContain(MCP_URL());
      expect(text).not.toContain(at);
      expect(text).not.toMatch(/Bearer|refresh_token|access_token/);
    }
  });

  test("the user's own native entry for the server is left alone (Decision 2), token or not", async () => {
    put(harness.claudeJson(), JSON.stringify({ mcpServers: { "my-docs": { type: "http", url: MCP_URL() } } }));
    const s = await addDocs();
    await signIn(s);
    expect(await sessionMcp("claude-code", join(process.env.HOME!, "proj"))).toEqual({ servers: [], auth: [] });
  });

  test("sign out drops the tokens, delete drops the record", async () => {
    const s = await addDocs();
    await signIn(s);
    await setServer(s.id, { signOut: true });
    expect(readTokens().servers[s.id].tokens).toBeUndefined();
    expect(readTokens().servers[s.id].client).toBeTruthy();
    expect(views()[0].auth).toBe("needs");
    await setServer(s.id, { remove: true });
    expect(readTokens().servers[s.id]).toBeUndefined();
  });
});
