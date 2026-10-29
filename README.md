# Tether

Run coding agents (Claude Code, Codex) on your own machines and drive them from any browser,
desktop or phone. Close the tab and the agent keeps working; open the same session on several
devices and they stay in sync. The design is in [SPEC.md](SPEC.md).

```
browser ──wss──► server (Foliation app: UI + relay) ◄──wss── runner (your machine) ──► claude / codex
```

The **runner** owns everything live. The **server** is a stateless relay, so redeploying it never
interrupts an agent. Runners dial out, so your machines need no inbound port.

## Layout

| Dir | What |
|---|---|
| `shared/` | The wire protocol (`protocol.ts`), transcript model (`transcript.ts`), sync and parsing helpers. Used by all three |
| `server/` | Bun relay: Foliation identity, rpc forwarding, session subscriptions, summary broadcast, per-browser terminal routing (`relay.ts`) |
| `runner/` | Bun runner. `src/core/` connection, event bus, ops; `src/adapters/` harnesses; `src/terminal/` PTY and tmux; `src/modules/` features that subscribe to core events |
| `web/` | React + Vite + Astryx UI |
| `docs/` | `acceptance/P<n>.md` manual checks per phase, `notes/` findings |

## Local development

Three processes, each in its own terminal. The ports and config directory keep the dev stack
apart from a production runner on the same machine.

```sh
(cd server && bun install && bun --watch src/index.ts)   # :8790, dev mode

mkdir -p ~/.local/share/tether-dev && echo '{"runnerId":"tether-dev","name":"tether-dev"}' > ~/.local/share/tether-dev/runner.json
(cd runner && bun install && TETHER_URL=http://localhost:8790 TETHER_TOKEN=dev \
  TETHER_CONFIG_DIR=~/.local/share/tether-dev bun src/index.ts)

(cd web && bun install && bunx vite)                      # http://127.0.0.1:5180
```

Without `FOLIATION_ISSUER` the server runs in dev mode: it listens on loopback only, every
browser is treated as the owner, and runners authenticate with `Authorization: Bearer dev`
(`TETHER_DEV_RUNNER_TOKEN` changes it). Set `TETHER_URL` and `TETHER_TOKEN` explicitly for a
dev runner: your shell may carry production values.

Tests and type checks, per package:

```sh
for p in shared server runner web; do (cd $p && bun test && bunx tsc -p .); done
```

## Production (Foliation)

1. Deploy the app from this directory (`foliation.json`; `.folignore` leaves out `runner/` and
   `docs/`). The backend's build context is the repository root, not `server/`, because the
   server imports `shared/` at runtime; its dependencies install from `server/`. Only the app's owners can use the UI, because it runs commands on their machines.
2. Create a runner token (an app service token, `docs/foliation-app-service-tokens.md` in v1):
   `fol tokens create tether --service runner --role editor`. Its name must be `runner` or
   `runner-<name>`.
3. On each machine, put `TETHER_URL=https://tether--<org>.foliation.dev` and `TETHER_TOKEN=...`
   in `~/.config/tether/runner.env` and run the runner as a systemd user unit
   (`bun src/index.ts` in `runner/`). On first start the runner writes `~/.config/tether/runner.json`
   with a generated `runnerId`; set `"name"` there to change its label (default: the hostname).
   Never copy a `runner.json` between machines: two runners with one id replace each other.

## Runner environment

| Variable | Default | |
|---|---|---|
| `TETHER_URL` | `http://localhost:8790` | the app's base URL |
| `TETHER_TOKEN` | `dev` | the runner's service token |
| `TETHER_CONFIG_DIR` | `~/.config/tether` | where `runner.json` (mode 600) and module data live |

Server: `TETHER_ALLOWED_ORIGINS` (comma-separated) admits browser sockets from other origins;
by default only pages on the app's own host may open one.
| `CLAUDE_BIN`, `CODEX_BIN` | `claude`, `codex` | harness binaries, if not on `PATH` |

## End-to-end check

`scripts/e2e-p0.mjs` drives the web UI with Playwright at desktop and phone sizes against a
local stack (vite on :5180; it starts and stops the server and runners itself):
`PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-p0.mjs`.
