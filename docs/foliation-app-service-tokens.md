# Proposal: app service tokens (machine access to an app host)

Status: proposal for Foliation (`~/foliation`), written from Tether's needs. Shaped like a
`contracts/*.md` file so it can be dropped in as `contracts/service-tokens.md` once agreed.

## 0. Why

Today the only thing that can reach an app host is a signed-in browser. The access slot
(`internal/edge/slot_access.go`) needs an app session cookie or a public link, and
`sanitizeRequest` strips every Foliation credential (`fol_pat_`, `fol_dpl_`, `fol_mcp_`, …)
before the request reaches the app. So a daemon, a script, a webhook sender you control or
another machine can't talk to a restricted app at all. The only options are making the app
public, which hands auth over to app code, or building a tunnel back out, which needs
egress approval, a public hostname and a second auth system.

**Service tokens** give an app owner a bearer credential for **one app**, with a **fixed,
capped role**. The edge checks it, swaps it for a normal `X-Foliation-User` identity of
kind *service*, and never forwards it. Apps keep one auth model: verify the header, read
`role`.

First user: Tether's runner. It is a daemon on any machine that opens an outbound
WebSocket to `https://tether--<org>.<apps domain>/api/runner` and runs coding agents for
the signed-in owner.

### Non-goals

- Not a control-API credential. A service token never authenticates `/api/v1`, `/mcp`, the
  console or the files host.
- Not a person. It has no email and no org membership, it can't be shared with, and it
  never gets `owner`.
- Not a route around sharing. It grants only the role the owner picked, capped by the
  creator's own role, re-checked on every request.
- Not for preview deployments (§4.6).

## 1. Token

- Format: `fol_svc_` + `auth.NewSecret()` (256 bits, base64url). Constant
  `auth.ServiceTokenPrefix`, constructor `auth.NewServiceToken()`.
- `auth.IsAPIToken` (or a new `auth.IsPlatformToken` used by `isPlatformCredential`) also
  matches `fol_svc_`. That way the existing `filterAuthorization` strips it from every
  request on every host, including when it reaches an app the token is not for.
- Shown **once**, in the creating response. Only `store.HashSecret(token)` is stored.
- Accepted **only** as `Authorization: Bearer fol_svc_…` on an app host (default or
  custom). Never in a query string, cookie or `Sec-WebSocket-Protocol`. URLs end up in logs
  and referrers, and non-browser clients can always set headers.

## 2. Storage (`db/migrations/01xx_service_tokens.sql`)

A **separate table, not `api_tokens`**. `AuthenticateAPIToken` must never find these, so
the control API can't accept them even through a scope-check bug.

```sql
create table app_service_tokens (
  id            uuid primary key default gen_random_uuid(),
  app_id        uuid not null references apps(id) on delete cascade,
  name          text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  id_hash       bytea not null unique,
  role          text not null check (role in ('viewer', 'editor')),
  created_by    uuid not null references users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,                 -- null = no expiry (allowed, discouraged in UI)
  last_used_at  timestamptz,
  last_ip       inet,
  last_user_agent text not null default '',
  revoked_at    timestamptz,
  revoked_by    uuid references users(id) on delete set null,
  revoked_reason text check (revoked_reason in ('revoked', 'admin', 'creator_lost_role', 'app_trashed'))
);
create unique index app_service_tokens_live_name on app_service_tokens (app_id, name) where revoked_at is null;
create index app_service_tokens_app on app_service_tokens (app_id) where revoked_at is null;
```

Store API (`internal/store/service_tokens.go`):

- `CreateServiceToken(ctx, appID, name, role string, createdBy string, expiresAt *time.Time, hash []byte) (ServiceToken, error)`.
  Returns `ErrConflict` on a live duplicate name.
- `ListServiceTokens(ctx, appID) ([]ServiceToken, error)` returns live tokens plus those
  revoked or expired in the last 30 days (shown greyed).
- `RevokeServiceToken(ctx, appID, id, reason string, by *string) (ServiceToken, error)`
  returns `ErrNotFound` for another app's id.
- `AppAccessByServiceToken(ctx, orgSlug, appSlug, host string, hash []byte, use TokenUse) (AppAccess, *ServiceToken, error)`.
  It is the service-token twin of `AppAccessBySessionOnHost` and does the whole lookup in
  one query: the app (live, not trashed), the token (hash match, same app, not revoked, not
  expired), the creator (enabled), and the creator's **current** effective role on the app
  (direct, group or org share, or org admin, as `contracts/groups.md` §3). The effective
  token role is `min(token.role, creator role)`, and the lookup fails when the creator role
  is `none`. It touches `last_used_at`/`last_ip`/`last_user_agent` with the same 60 s
  throttle as `contracts/cli-sessions.md` §4.

## 3. Edge

### 3.1 Access slot

At the top of `accessSlot`, before the session-cookie lookup:

1. If the request has an `Authorization` value whose bearer token starts with `fol_svc_`,
   it is a **service request**:
   - Cookies are **ignored** for identity. The token decides, and an app session cookie
     sent alongside it can't add rights or confuse the result.
   - More than one `fol_svc_` value, or a `fol_svc_` token mixed with an app session where
     the token fails, gives `401` (below). There is never a fallback to the cookie.
   - `AppAccessByServiceToken` → on success
     `ar.Viewer = &Viewer{Service: &ServiceViewer{ID, Name}, Role: effectiveRole}`.
   - The same-origin check (`sameOriginAppRequest`) does **not** apply. It exists because
     browsers attach cookies automatically, and a bearer token is never ambient.
2. Failure of any kind (unknown, revoked, expired, another app's token, creator disabled or
   without a role, app trashed, service tokens disabled for the org) gets **one** response:
   `401`, `Content-Type: application/json`,
   `{"error":{"code":"service_token_invalid","message":"This service token is not valid for this app."}}`,
   `Cache-Control: no-store`. It never redirects to a login, never shows the join or denied
   page, and never sets `__Host-fol_anon`. The reason is only logged on the server, so the
   endpoint doesn't say whether a token exists for another app.
3. Not a service request: unchanged.

The new `Viewer` field: `Service *ServiceViewer // non-nil for a service-token request; User is nil`.

### 3.2 Paths

- `/_foliation/*` (handoff, login, logout, switch) with a service token → `404`. None of it
  means anything without a browser session.
- Backend routes and static frontend: served as usual.
- WebSocket upgrades and SSE on backend routes: allowed (§3.5).
- The files host: not affected. It already refuses `Authorization`
  (`internal/edge/files.go`), and service tokens can't presign.

### 3.3 Identity minted for the app (`contracts/identity.md` addition)

| Claim | Service-token value |
|---|---|
| `sub` | `svc:<token uuid>` (stable for the token's lifetime, never a user id) |
| `email` | `""` |
| `name` | the token name, e.g. `runner` |
| `role` | the effective role: `viewer` or `editor` |
| `svc` | `true` (new claim; present only for service requests) |
| `anon`, `pub` | absent |
| `org`, `app`, `iss`, `aud`, `iat`, `exp`, `jti` | as for everyone |

SDKs expose `user.isService` (TS) and `user.is_service` (Python). Docs for app authors
(`AGENTS.app.md` rule 6) need one added line: *"A request can come from a service token
(`svc: true`, `sub` starting with `svc:`, empty email). Treat it as a non-human principal
with the given role. If a route should only serve people, check `!user.isService`."*

`mintFor` gets the `svc` branch. Nothing else in the mint changes.

### 3.4 Header hygiene

- `sanitizeRequest` runs after the access slot as today, and the token is stripped by
  `filterAuthorization` (§1). **Test:** the app never sees `fol_svc_` in any header.
- Client-IP and `x-foliation-*` stripping: unchanged.

### 3.5 Long-lived connections

- The token is checked once per request. For a WebSocket that's the upgrade, and for SSE
  the initial request.
- **Re-check while open.** Every 60 s, a proxied WebSocket or streamed response made with a
  service token re-runs `AppAccessByServiceToken` (no touch). On failure the edge closes it:
  WebSocket close code `4401` reason `service_token_invalid`, or the stream ends. Revoking
  a token, the creator losing their role, or the app being trashed ends open connections
  within **60 s**, the same bound as `contracts/cli-sessions.md` §4.
- Cloudflare idles WebSockets out after about 100 s. Clients must ping at least every 30 s.
  The client docs say so (Tether's runner pings every 20 s).

### 3.6 Rate limits

- Per token: 1 200 requests/min across backend and static, and **16 concurrent**
  WebSocket/streaming connections. Over the limit → `429` with `Retry-After`, JSON body
  `{"error":{"code":"rate_limited"}}`.
- Failed service-token attempts are limited per client IP at the hostkind pre-limit (600/min).
  After 20 failures/min from one IP, that IP gets `429` on any `fol_svc_` request to any app
  host for 5 min, which stops brute force across apps.
- Counted in their own bucket, never in anonymous traffic (`contracts/frontdoor.md` §4.3).

### 3.7 Cloudflare

App hosts must not challenge non-browser clients that send `Authorization: Bearer fol_svc_…`.
`frontdoor.md` §6 step 5 already requires Bot Fight Mode off, or a skip rule. Add app hosts
with a `fol_svc_` bearer to that rule, and have `foliationd cloudflare check` warn when a
managed challenge or Bot Fight Mode covers `*.<apps domain>`. **Verify on day one:**
`curl -H "Authorization: Bearer fol_svc_x" https://<app host>/` reaches the edge and gets
the JSON `401`, not a Cloudflare challenge page.

## 4. Rules

1. **Who creates and revokes:** the app owner or an org admin. Editors can **list**, as
   with deploy tokens. Viewers see nothing.
2. **Role cap:** `role` ∈ {`viewer`, `editor`}, and the creator must hold at least that role
   when creating. While in use the effective role is `min(token.role, creator's current
   role)`. When the creator loses all access, the token stops (`401`) but is **not**
   revoked automatically, so it works again if access comes back. This matches the rule for
   deploy tokens' "trust creator lost editor role". A disabled creator → tokens stop
   (`users disable`); re-enabling restores them.
3. **Org policy:** `PATCH /orgs/{org}` `{"service_tokens": "allowed" | "disabled"}` (admin,
   default `allowed`). While disabled, every service request gets `401` at once (rows kept),
   and creating a token gets `403 service_tokens_disabled`.
4. **Limits:** at most 20 live tokens per app (`409 limit_service_tokens`).
5. **Trash and restore:** a trashed app refuses its tokens. Restoring brings them back
   unless they were revoked or expired meanwhile. Deleting the app cascades.
6. **Previews:** preview hosts (`<app>--pr-<n>--<org>`) refuse service tokens
   (`401 service_token_invalid`). A preview is a different app id, and a PR author must not
   be able to point a production runner at their branch.
7. **Public links:** independent. A token works the same whether or not the app is public,
   and a public app's anonymous visitors gain nothing from tokens existing.
8. **Never in the manifest.** `foliation.json` can't declare or create tokens, and
   `fol check` refuses a `service_tokens` key, as for sharing.

## 5. API (control, `/api/v1`)

| Method & path | Who | Body / result |
|---|---|---|
| `GET /orgs/{org}/apps/{app}/service-tokens` | editor+ | `[{id, name, role, created_by:{email,name}, created_at, expires_at, last_used_at, last_ip, revoked_at, revoked_reason, status: "live"\|"expired"\|"revoked"\|"suspended"}]`. `suspended` means the creator lost their role or the org policy is off. Never the token or its hash. |
| `POST /orgs/{org}/apps/{app}/service-tokens` | owner / org admin | `{name, role, expires_in_days?: 1..3650 \| null}` → `201 {…row, token: "fol_svc_…"}`. `Cache-Control: no-store`. Errors: `400 invalid_name`, `400 invalid_role`, `403 role_exceeds_yours`, `409 name_taken`, `409 limit_service_tokens`, `403 service_tokens_disabled`. |
| `DELETE /orgs/{org}/apps/{app}/service-tokens/{id}` | owner / org admin | `204`. Another app's id or an unknown id → `404`. |

Deploy tokens (`fol_dpl_`) and MCP tokens get `403 token_scope` on all three. Cookie calls
need the usual CSRF header.

## 6. CLI, dashboard, MCP

- CLI (`contracts/cli.md`), extending `fol tokens`:
  ```
  fol tokens create [app] --service <name> [--role viewer|editor] [--expires 90d|never]   prints the token once
  fol tokens ls [app]          lists deploy and service tokens with a KIND column
  fol tokens rm [app] <id>     revokes either kind
  ```
  Default role `viewer`, default expiry `365d`. `--expires never` asks for confirmation
  when run in a terminal.
- Dashboard: App → Settings → Access, a **Service tokens** card. Columns: name, role, last
  used, expires, status. The "New service token" dialog shows the token once with a copy
  button and the warning *"Anyone with this token can use <app> as <role>. Store it like a
  password."*
- MCP (`contracts/mcp.md`): `list_service_tokens` (read). `create_service_token` and
  `revoke_service_token` use the existing preview → `confirm: <app slug>` pattern, and the
  created token is returned only in the confirmed call's result.

## 7. Audit

Kind `app.service_token`:

| Action | `detail` |
|---|---|
| create | `{"action":"create","token_id","name","role","expires_at"}` |
| revoke | `{"action":"revoke","token_id","name","reason":"revoked"\|"admin"}` |
| first use from a new IP | `{"action":"new_ip","token_id","name","ip"}` (at most one per token per hour) |

Requests made with a token are not audited one by one. Logs record
`viewer=svc:<token id>` instead of a user id. Dashboard sentences: "created service token
*runner* (editor)", "revoked service token *runner*".

## 8. `fol check`

Extend the `login-token` rule (`internal/cli/check_login_tokens.go`) to `fol_svc_`. It's a
blocker in tracked files, `.env*` and CI workflows, and prints only `file:line`. Message:
*"A service token is committed. Revoke it (`fol tokens rm`) and load it from the
environment instead."*

## 9. Security tests (each one required)

1. A valid token gets the app with `X-Foliation-User` carrying `sub=svc:<id>`, `svc=true`,
   `role` = the token role, and an empty email.
2. The app never receives `fol_svc_` in any header, with one or several `Authorization`
   values, odd schemes, or comma lists.
3. A token for app A on app B's host → `401 service_token_invalid`, byte-identical to an
   unknown token.
4. Revoked, expired, creator disabled, creator unshared, app trashed, org policy disabled →
   `401` on the next request, and an open WebSocket is closed with `4401` within 60 s
   (fake clock).
5. Creator downgraded from owner to viewer → an `editor` token now mints `role=viewer`.
6. A token plus a valid owner app-session cookie → the identity is the token's. A bad token
   plus a valid cookie → `401` (no fallback).
7. Not accepted on `/api/v1/*`, `/mcp`, console pages, the files host, or preview hosts.
   `/_foliation/*` → 404.
8. Not accepted from `?token=`, a cookie, or `Sec-WebSocket-Protocol`.
9. A cross-origin `POST` with a token is served (no same-origin rule). A cross-origin
   `POST` with only a cookie is still refused as today.
10. A deploy token or MCP token can't call the service-token API (`403 token_scope`). An
    editor gets `403` on create and delete, a viewer `403` on list.
11. The `POST` response has `Cache-Control: no-store`. List responses never contain
    `token` or `id_hash`.
12. Rate limits: the 1 201st request in a minute → `429`. The 17th concurrent WebSocket →
    `429`. 21 bad tokens from one IP → that IP gets `429` on every app host for 5 min.
13. Throttled touch: 50 requests in a minute → at most one write to the token row.

## 10. Files touched (expected)

`internal/auth/secret.go` (prefix), `internal/edge/slot_access.go` (service branch),
`internal/edge/appchain.go` (`Viewer.Service`), `internal/edge/proxy.go`
(`isPlatformCredential`), `internal/edge/slot_ratelimit.go`, `internal/edge/proxy.go` or
the WebSocket proxy (60 s re-check), `internal/identity` (`svc` claim), `internal/store/service_tokens.go`
plus the migration, `internal/control` (routes, audit), `internal/cli` (`fol tokens`,
`fol check`), `web/` (Settings card, audit sentences), `sdk/ts` and `sdk/python`
(`isService`), `contracts/identity.md`, `contracts/frontdoor.md`, `contracts/cli.md`,
`docs/agents/AGENTS.app.md`, `docs/agents/migrate.md`, plus a new `docs/agents/service-tokens.md`
page registered in the README table, `llms.txt` and the skill install list.

## 11. How Tether uses it (acceptance check)

```sh
fol tokens create tether --service runner --role editor --expires 365d   # → fol_svc_…
# on the runner machine
TETHER_URL=https://tether--gavin-personal.foliation.dev \
TETHER_TOKEN=fol_svc_… tether-runner
```

- The runner opens `wss://…/api/runner` with `Authorization: Bearer fol_svc_…` and pings
  every 20 s.
- The app backend accepts the upgrade only when the verified viewer has `svc === true`,
  `name === "runner"` and `role === "editor"`. Browser routes require
  `!svc && role === "owner"`.
- Revoking the token in the dashboard disconnects the runner within 60 s.
