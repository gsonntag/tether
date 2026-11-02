# Azure settings acceptance

Settings › Azure (`#/settings/azure`, SPEC §10 **Azure**): Azure's key, its resource and a list of
deployments, each with the model it runs, its type, and rates from Tether's dated table or its Override. Codex sessions on Azure pick a deployment
as their Model and keep it.

## Setup

A private stack with a fake Azure upstream (`scripts/fake-responses.ts`, HTTPS with a throwaway
certificate). Ports, config dir and tmux socket are the test's own; hold `flock -o
/tmp/claude-1001/e2e.lock` for the whole run and start from an empty config dir.

```sh
D=/tmp/claude-1001/azure/keys/dev; mkdir -p $D
echo '{"runnerId":"tether-dev-azure","name":"tether-dev-azure"}' > $D/runner.json
cd server && env -u TETHER_URL -u TETHER_TOKEN -u PORT PORT=8905 bun src/index.ts
bun scripts/fake-responses.ts /tmp/claude-1001/azure/fake.log 8906 cert.pem key.pem
cd runner && env -u TETHER_URL -u TETHER_TOKEN -u INVOCATION_ID NODE_TLS_REJECT_UNAUTHORIZED=0 TETHER_DEV=1 \
  TETHER_URL=http://localhost:8905 TETHER_TOKEN=dev TETHER_CONFIG_DIR=$D TETHER_TMUX_SOCKET=tether-dev-azure bun src/index.ts
cd web && TETHER_SERVER=http://127.0.0.1:8905 bunx vite --port 5305 --strictPort
BASE=http://127.0.0.1:5305 RUNNER_ID=tether-dev-azure KEYS_ROOT=/tmp/claude-1001/azure/keys \
  CREDENTIAL_FILE=$D/credentials.json RUNNER_PID_FILE=… RESTART_RUNNER=… TMUX_SOCKET=tether-dev-azure \
  FAKE_ENDPOINT=https://127.0.0.1:8906/openai/v1 FAKE_LOG=/tmp/claude-1001/azure/fake.log \
  [ONLY_AZURE=1] node scripts/e2e-keys.mjs
```

Compare `sha256sum ~/.codex/config.toml` before and after.

## Checks

1. **The page** [e2e] Settings' nav has Credentials and Azure; Azure is `#/settings/azure` and marked.
   Credentials has no Azure slot. Desktop and 375 px without sideways scroll.
2. **Resource** [e2e, unit] A name (`e2e-res`) is saved as `https://e2e-res.openai.azure.com/openai/v1`,
   shown under the field, and comes back as the name. A full HTTPS URL is kept; a bare host gets
   `/openai/v1`. `http:`, credentials, a query or a fragment are refused.
3. **Key** [e2e, unit] Write-only: the field clears, status is Set and the last four, and the key is
   in no frame to the browser, no argv, no file but `credentials.json`. Unsetting it keeps the resource
   and deployments; settings can be saved before the key.
4. **Deployments** [e2e, unit] Add, edit and remove rows: name, model (suggested from Codex's list,
   free text allowed), Type (Global by default, Data Zone, Regional). A model and type in the table
   show its rates read-only and greyed, short and long, the table's date in the tooltip; Override
   gives input, cached and output (all three or none) and an optional cache write. A Regional row or
   an unlisted model shows those fields directly. Duplicate names, bad names and a key in any field are
   refused in a few words. Saved together with the resource; they come back after a reload.
5. **Not a source until whole** [e2e, unit] Azure is offered only with its key, a resource and a
   deployment.
6. **Test** [e2e, unit] Disabled with no key or unsaved changes. Clicked, one request to
   `<endpoint>/responses` with the row's name as `model` and the key in `api-key`: "OK · luna-a" from
   the fake, "Deployment not found" for a 404. Nothing runs by itself.
7. **New session and Move** [e2e] With Source Azure, Model lists "luna-a · gpt-6-luna" and "luna-b ·
   gpt-6-luna", at desktop and 375 px. The session made is on the one picked (`runner.json`
   `sessions.<id>.deployment`), its request names it, and a moved session too.
8. **Cost** [e2e, unit] luna-a's Override shows `est. $0.02` for the fake's 10 + 2 tokens at
   2000/2000 per 1M; luna-b, on the table (gpt-6-luna Global), `est. <$0.0001` with "dated 2026-11-01;
   your agreement may differ" in the tooltip. Through the fake, whose usage the deployment's name sets:
   gpt-6.1-sol short with writes `est. $0.24`, long (300k input) `est. $1.23`, Data Zone `est. $0.23`;
   gpt-5.5 with a write "cache writes have no rate for this model"; DeepSeek-V4 on Regional
   "deepseek-v4 has no published price"; an Override with a write rate `est. $0.25`; service tier
   priority "isn't confirmed as Standard". A request naming another deployment isn't priced with
   these rates.
9. **Kept** [e2e with RESTART_RUNNER, unit] After a runner restart the session's next request names
   the same deployment. Another deployment's change doesn't restart it; its own rates changing does.
10. **Removed** [e2e, unit] Its session's send fails with "This session's Azure deployment luna-b was
    removed…" in the op and the chat, no request reaches the fake, and luna-a's session still answers.
11. **Migration** [unit] A version 2 file with Azure's endpoint, deployment and rates reads as a list of
    one with those rates and the same revision, and is written as version 3 at the next change. One
    without a deployment has none; one without Azure (the prod shape) shows nothing. Rows from before types read as Global; saved rates are their Override, numbers kept; rows
    without rates use the table.

## Record (2026-11-01)

All of the above passed on the private stack with fake keys and the fake upstream, desktop and 375 px
screenshots inspected (`/tmp/claude-1001/azure/shots/azure-*`). No real Azure key was available.

**A real key must confirm:** that Codex 0.164 accepts a deployment name that isn't a known model slug
as its `model` against real Azure (it did against the fake), that a real resource answers v1
`/responses` with `api-key` and no `api-version`, Test's "OK" and its model name on a reasoning
deployment with `max_output_tokens` 16, the error words for a real 401/404/429, a Foundry
(`services.ai.azure.com`) endpoint, and that a real response's usage prices with the entered rates.

## Record (2026-11-01, table rates)

Checks 4, 8 and 11 above, on the private stack with fake keys and the fake upstream, desktop and
375 px screenshots inspected. No real Azure key was available: a real response's `usage` (whether it
reports `cache_write_tokens`, with or without a lifetime breakdown, and `service_tier`) and the owner's
invoice against the table are unconfirmed.
