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
| `runner/` | Bun runner. `src/core/` connection, event bus, ops, the session core (`sessions.ts` registry and stored mode, `live.ts` driving, `transcript.ts`, `summaries.ts`, `broker.ts`, `prefs.ts`); `src/adapters/claude/` Claude Code (discovery, history, Agent SDK driver, stream); `src/terminal/` PTY and tmux; `src/modules/` features that subscribe to core events |
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

Without `FOLIATION_ISSUER` the server runs in dev mode: it listens on loopback only, answers
only requests addressed to `localhost`/`127.0.0.1`, treats every browser as the owner, and runners authenticate with `Authorization: Bearer dev`
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
| `TETHER_URL` | required | the app's base URL |
| `TETHER_TOKEN` | required | the runner's service token |
| `TETHER_DEV` | | `1`: fall back to `http://localhost:8790` and token `dev` when the two above are unset |
| `TETHER_CONFIG_DIR` | `~/.config/tether` | where `runner.json` (mode 600) and module data live |
| `CLAUDE_BIN`, `CODEX_BIN` | `claude`, `codex` | harness binaries, if not on `PATH` |
| `TETHER_TMUX_SOCKET` | `tether` | the tmux socket terminals live on (`tmux -L <socket>`); give a dev runner its own |

Server: `TETHER_ALLOWED_ORIGINS` (comma-separated) admits browser sockets from other origins;
by default only pages on the app's own host may open one.

## Sessions (P1)

The runner discovers Claude Code sessions in `~/.claude/projects` (read-only; nothing starts until
you send). The sidebar lists sessions with a message in the last 3 days plus every live one;
search finds the rest. Sending takes a session live through the Agent SDK; it goes back to stored
after 5 idle minutes (not while subagents or background tasks run). Per-session model, effort and
permission mode are kept in `runner.json` (`sessions`); Tether's own notices (denials, errors, a turn cut off) in `notices.json`. Subagents are child sessions
(`claude:<session>/<agent>`). Permission prompts and questions
(SPEC §7) go to every device watching the session, above the composer; the first answer wins, and
open requests survive a runner restart (kept in `runner.json`).

## End-to-end check

P1: `bun scripts/smoke-p1.ts` (scripted browsers through the relay) and `node scripts/e2e-p1.mjs`
(Playwright, desktop and phone) drive real Claude on Haiku against the dev stack; see their headers.
`scripts/fake-runner.ts` serves canned sessions for UI work without a model.

P2: `node scripts/e2e-p2.mjs` (Playwright, desktop and phone, real Claude on Haiku) checks requests:
approvals on two devices, "Already answered", deny with reason, questions, a subagent's request, a
runner restart with a request open, and plan approval. See its header and `docs/acceptance/P2.md`.

`scripts/e2e-p0.mjs` drives the web UI with Playwright at desktop and phone sizes against a
local stack (vite on :5180; it starts and stops the server and runners itself):
`PLAYWRIGHT=/path/to/playwright/index.mjs node scripts/e2e-p0.mjs`.

## Terminal mode (P3)

The **Terminal** chip on a session opens the harness's own TUI in a panel (xterm.js), beside the
transcript on desktop and full screen on a phone (with a key bar). Needs `tmux` on the runner's
machine. For Claude it is a handoff: the SDK process closes, `claude --resume <id>` runs in tmux,
and the transcript is read-only (tailed from the store) until **Back to Tether** quits the TUI and
the session goes live again on the same id. The panel also holds plain shells per project (**+**).

Every terminal is its own tmux session on the socket `TETHER_TMUX_SOCKET` (default `tether`),
tagged with `@tether_*` options, so terminals and shells outlive the runner: a restarted runner
readopts them. Under systemd the runner starts the tmux server in a scope of its own
(`systemd-run --user --scope`), so stopping the unit (`KillMode=mixed`) leaves it running. The tmux
server and everything in it get the runner's environment without `TETHER_*`.

Claude's TUI is launched with `--settings` adding hooks for this launch only (never your
`~/.claude/settings.json`): they report prompts, "needs you" and turn ends to the runner over
`<config dir>/hooks.sock`. Checks: [docs/acceptance/P3.md](docs/acceptance/P3.md); end to end:
`scripts/e2e-p3.mjs`.

