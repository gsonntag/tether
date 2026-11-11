# Tether

Run coding agents (Claude Code and Codex) on your own machines and drive them from any browser,
desktop or phone. Close the tab and the agent keeps working. Open the same session on several
devices and they stay in sync. A Home agent can start work across your projects and see it through,
and Tether can text you when a session needs you. The design is in [SPEC.md](SPEC.md).

```
browser ──wss──► server (Foliation app: UI + relay) ◄──wss── runner (your machine) ──► claude / codex
```

- [Features](#features)
- [Architecture](#architecture)
- [Setup](#setup)
- [Configuration](#configuration)
- [Development](#development)
- [Production and deploys](#production-and-deploys)
- [Testing](#testing)

## Features

**Sessions.** The runner finds your existing Claude Code (`~/.claude/projects`) and Codex sessions
and shows them all in one transcript format. Nothing starts until you send. The sidebar has Recent
(the last 3 days plus every live session) and per-project lists, and search finds the rest. You can
rename and archive sessions from the sidebar. A session goes live when you send and goes back to
stored after 5 idle minutes. Subagents appear as child sessions. See SPEC §4–§6a.

- **Composer** (SPEC §9): Enter sends, or steers a running turn. Tab queues the message and
  ⌘/Ctrl+Enter stops the turn and sends now. Esc stops. The queue is kept on the runner, and any device can edit, reorder or cancel it. Typing `/` opens the
  harness's own commands and skills. Text starting with `!` runs a shell command in the session's
  folder right away, and its card has a Stop button. You can attach images and files by pasting,
  dropping, the file picker or the camera.
- **Requests** (SPEC §7): permission prompts, questions and plans go to every device watching the
  session, and the first answer wins. A plan opens in a review view where you can comment on it.
- **Stop a running command:** while the agent waits on a shell command, a Stop button on the
  command's card ends the turn.
- **Terminal** (SPEC §8): the ❯_ button opens a plain shell for the project, and the harness's own
  TUI is a choice in the same panel. Claude hands the session off to `claude --resume` in tmux and
  takes it back when you click **Back to Tether**. Codex shares the live thread with its TUI.
  Terminals outlive runner restarts.
- **Change session harness** (SPEC §15): continues a session on the other harness, or on the same
  harness with another billing source. The old session stays as it was.

**Home.** Home has an inbox of sessions that need you, failed, finished or are working. It also has
the runners and the **Home agent**, a chat that starts sessions in your projects and sees them
through (SPEC §10):

- **Tabs.** Several chats can be open and running at once, and each one is its own session. You can
  rename a tab by double-clicking it. Closing a tab, or typing `/new` or `/clear` in it, archives that
  chat. **Expand** puts the chat over the whole window, and Esc brings it back.
- **Pickers:** the agent's harness, source, model and permission mode. The mode is **Auto** by
  default. These settings are shared by all chats and remembered for new ones.
- **Reports.** When a session the agent started or messaged ends a turn, its reply comes back to the
  chat as a `[From Tether]` message. It's shown folded to one line, and you can open it to read the
  rest. While those sessions are still working, a "Waiting for N sessions to finish…" row shows.
  The agent can message any session, and following up in a session yourself makes it yours again.
- **Watch all sessions** (on by default): the agent also hears when any other session finishes a
  turn, fails or starts waiting for you.
- **Archive done sessions** (also something you can ask the agent for): the agent asks each idle
  session whether its work is done and merged, and tells finished sessions to remove the worktrees
  they made. It checks each answer against git, then archives the finished sessions and reports on
  the rest. Busy sessions are skipped, never interrupted.

**Sessions talking to each other** (SPEC §9a): every live session gets a `tether` MCP server with
four tools: `tether_sessions`, `tether_send`, `tether_ask` (waits for the answer) and
`tether_broadcast` (within the sender's project by default). Messages go into the target's queue.
A session can't message a session with looser permissions than its own, and loops are capped. You
can turn this off with `TETHER_PEERS=0`.

**Billing sources** (SPEC §10, *Credentials and billing safety*): each session uses one source, set
when the session is made:

- Claude: the Claude plan, or an Anthropic API key.
- Codex: the ChatGPT plan, an OpenAI API key, or Azure.

You add keys under **Settings → Credentials** and **Settings → Azure**, and they're stored on the
runner. New sessions start on the subscription. The header's billing chip shows the source and
switches it, and API sessions show what they've cost in dollars.

**Texting** (iMessage through [Photon Spectrum](https://photon.codes), or a Discord bot): the runner can text you when
a session has a request, needs you in the terminal, fails, or ends its turn with a question. Nothing
is texted for a session you're looking at in Tether. Each text starts with its session's number.

- **Answering a request:** reply `y` or `n` to a command, edit or plan, or an option's letter to a
  question. Anything else goes to the agent as your words. A reply answers only the request its
  text was about. If that request has already been answered, Tether says so instead of passing the
  reply on.
- **Choosing the session:** `2 do X`, `[2] do X` or a threaded reply goes to session 2. Plain text
  goes to the only open session. If several are open, Tether texts you a numbered list to pick from.
  A session takes replies for 30 minutes after its last text.
- **Confirmation:** a reply that was passed on to its session gets a ✅ reaction, not another text.
  The session's answer comes back by text.
- **Agents texting you:** sessions and the Home agent text you with Tether's `text_person` tool;
  sessions the Home agent drives report to it instead, and it sends you one condensed text.
- **Secrets:** your known keys are removed from texts, but anything else the agent writes can appear
  in one.
- **Setup:** add a Photon project's id and secret and your verified phone number under
  **Settings → Messaging** (or in `runner.env`). They're stored on the runner. The app server can't
  send texts itself because a Foliation app has no internet access.
- **Discord:** the same thing over a Discord bot, in a DM or one server channel. Only the user IDs
  you set can drive it; everyone else (and other bots) is ignored. Every ID listed is treated as
  you and sees everything (list only your own accounts). In the channel, start with
  @ and the bot's name or reply to one of its messages (anything else there is ignored); its answer
  comes back in the channel, where everyone in it can read it. Everything else Tether sends goes to
  your DMs (or wherever **Send to** says, when more than one connector is on). An answer always goes
  back the way you wrote. Files you send reach the session.
  To set it up:
  1. In the [Developer Portal](https://discord.com/developers/applications), make an application,
     open **Bot**, **Reset Token** and copy it, and turn on **Message Content Intent**.
  2. Under **OAuth2 → URL Generator**, tick the `bot` scope and the permissions View Channels, Send
     Messages, Read Message History, Attach Files and Add Reactions; open the URL and add the bot to
     a server of yours (the bot can only DM you if you share a server).
  3. In Discord, turn on **Settings → Advanced → Developer Mode**, then right-click your name and
     **Copy User ID** (and the channel, if you want one: **Copy Channel ID**).
  4. In **Settings → Messaging → Discord**, save the bot token, your user ID (and the channel), and
     turn it on; or set `TETHER_DISCORD_TOKEN`, `TETHER_DISCORD_OWNER_IDS` and
     `TETHER_DISCORD_CHANNEL_ID` in `runner.env`. Prefer the settings page: a token in `runner.env`
     stays readable in `/proc/<runner pid>/environ` to any process running as your user.
     In a channel, mention the bot user itself (not its role).

**Settings** also has **Notifications** (Web Push on each device) and **Agents** (runner-wide agent
settings).

## Architecture

The **runner** owns everything live: harness processes, the queue, requests, terminals and
modules. The **server** is a stateless relay, so redeploying it never interrupts an agent. Runners
dial out, so your machines need no inbound port. SPEC §3 has the details.

| Dir | What |
|---|---|
| `shared/` | The wire protocol (`protocol.ts`), transcript model (`transcript.ts`), and helpers used by all three: credentials, costs, move, commands, plan, sync |
| `server/` | Bun relay on Foliation: identity, RPC forwarding, session subscriptions, summary broadcast, terminal routing (`relay.ts`), Web Push keys (`push.ts`) |
| `runner/` | Bun runner. `src/core/`: connection, event bus, ops and the session core (`sessions.ts`, `live.ts`, `queue.ts`, `requests.ts`, `transcript.ts`). `src/adapters/claude/` (Agent SDK) and `src/adapters/codex/` (app-server daemon, private hosts for API sources). `src/terminal/`: PTY and tmux. `src/modules/`: `homeAgent`, `peers`, `texting` (its connectors: `imessage.ts`, `discord.ts`), `push`, `move` |
| `web/` | React + Vite + Astryx UI |
| `scripts/` | End-to-end checks, a fake runner, probes |
| `docs/` | `acceptance/` manual checks per phase and feature, `notes/`, [`ISSUES.md`](docs/ISSUES.md) backlog |

## Setup

You need [Bun](https://bun.sh), `tmux` (for terminals), and `claude` and/or `codex` installed and
logged in on the runner's machine. Install dependencies per package:

```sh
for p in shared server runner web; do (cd $p && bun install); done
```

## Configuration

Runner (`runner.env` in production, or the shell in dev):

| Variable | Default | |
|---|---|---|
| `TETHER_URL` | required | the app's base URL |
| `TETHER_TOKEN` | required | the runner's service token |
| `TETHER_DEV` | | `1`: fall back to `http://localhost:8790` and token `dev` when the two above are unset |
| `TETHER_CONFIG_DIR` | `~/.config/tether` | where `runner.json` (mode 600), prefs, notices and module data live |
| `TETHER_DATA_DIR` | `TETHER_CONFIG_DIR` | stored keys and private Codex hosts (keep the path short: it holds a Unix socket) |
| `CLAUDE_BIN`, `CODEX_BIN` | `claude`, `codex` | harness binaries, if not on `PATH` |
| `TETHER_TMUX_SOCKET` | `tether` | the tmux socket terminals use (`tmux -L <socket>`). Give a dev runner its own |
| `TETHER_HIDE_PROJECTS` | | folders to leave out of the session lists |
| `TETHER_PEERS` | | `0` turns off session-to-session messaging |
| `TETHER_PHOTON_PROJECT_ID`, `TETHER_PHOTON_PROJECT_SECRET`, `TETHER_TEXT_PHONE` | | texting, instead of Settings → Messaging (these take precedence) |
| `TETHER_DISCORD_TOKEN`, `TETHER_DISCORD_OWNER_IDS`, `TETHER_DISCORD_CHANNEL_ID` | | the Discord connector, instead of Settings → Messaging (these take precedence; owner ids comma-separated) |

On first start the runner writes `runner.json` with a generated `runnerId`. Set `"name"` there to
change its label (the default is the hostname). Never copy a `runner.json` between machines,
because two runners with one id replace each other.

Server:

| Variable | |
|---|---|
| `FOLIATION_ISSUER` | Set by Foliation in production. Without it the server runs in dev mode |
| `TETHER_VAPID_PUBLIC_KEY`, `TETHER_VAPID_PRIVATE_KEY` | Web Push key pair (`bun server/scripts/vapid-keys.ts` makes one). Without them push is off |
| `TETHER_PUSH_SUBJECT` | VAPID contact (an https URL or `mailto:`) |
| `TETHER_ALLOWED_ORIGINS` | comma-separated extra origins allowed to open browser sockets. By default only the app's own host can |
| `TETHER_DEV_RUNNER_TOKEN` | dev mode: the runner token (default `dev`) |
| `TETHER_DEV_PICTURE` | dev mode: a profile picture URL for the fake owner (default none), to try the account avatar |

## Development

Run three processes, each in its own terminal. The ports and config directory keep the dev stack
apart from a production runner on the same machine.

```sh
(cd server && bun --watch src/index.ts)                   # :8790, dev mode

mkdir -p ~/.local/share/tether-dev && echo '{"runnerId":"tether-dev","name":"tether-dev"}' > ~/.local/share/tether-dev/runner.json
(cd runner && TETHER_URL=http://localhost:8790 TETHER_TOKEN=dev \
  TETHER_CONFIG_DIR=~/.local/share/tether-dev TETHER_TMUX_SOCKET=tether-dev bun src/index.ts)

(cd web && bunx vite)                                      # http://127.0.0.1:5180
```

In dev mode the server listens on loopback only and answers only requests addressed to
`localhost`/`127.0.0.1`. It treats every browser as the owner, and runners authenticate with
`Authorization: Bearer dev`. Set `TETHER_URL` and `TETHER_TOKEN` explicitly for a dev runner,
because your shell may carry production values. For UI work without a model,
`scripts/fake-runner.ts` serves canned sessions.

## Production and deploys

1. **App.** The Foliation app is defined in `foliation.json`, and `.folignore` leaves out `runner/`
   and `docs/`. The backend's build context is the repository root, not `server/`, because the
   server imports `shared/` at runtime. Its dependencies install from `server/`. Only the app's
   owners can use the UI, because it runs commands on their machines. The app deploys from `main`,
   so merging a PR deploys the web app and server.
2. **Runner token.** Create an app service token named `runner` or `runner-<name>`, e.g.
   `fol tokens create tether --service runner --role editor`.
3. **Runner.** Run the runner as a systemd user unit, `tether-runner.service`, from a checkout of
   its own that is pinned to `origin/main` (for example `~/tether-prod`), not from a working
   checkout you edit. The unit uses:
   - `WorkingDirectory=%h/tether-prod/runner` and `ExecStart=<bun> src/index.ts`
   - `EnvironmentFile=%h/.config/tether/runner.env`, which holds `TETHER_URL` and `TETHER_TOKEN`
   - `Environment=TETHER_CONFIG_DIR=...` if you keep runner data somewhere other than the default
   - `Restart=always` and `KillMode=mixed`

   The tmux server and the Codex daemon start in systemd scopes of their own, so stopping the unit
   leaves terminals and Codex running. A restarted runner picks them back up.

Updating the runner after a merge:

```sh
git -C ~/tether-prod fetch origin && git -C ~/tether-prod checkout --detach origin/main
(cd ~/tether-prod/runner && bun install)    # when dependencies changed
systemctl --user restart tether-runner
```

A restart stops running turns and continues them when the runner is back. Open requests and queued
messages survive it.

## Testing

Unit tests and type checks, per package:

```sh
for p in shared server runner web; do (cd $p && bun test && bunx tsc -p .); done
```

End-to-end checks are in `scripts/`. Most run against the dev stack and drive real harnesses on cheap
models (Claude on Haiku, Codex on its cheapest model) with Playwright at desktop and phone sizes.
Each script's header says what it needs:

- `e2e-p0.mjs` through `e2e-p5b.mjs`: one per phase
- `e2e-plan.mjs`: plan review
- `e2e-move.mjs`: change session harness
- `e2e-keys.mjs`: the credentials and billing UI
- `e2e-cost.ts`: API cost accounting against a fake API, with no model

`smoke-p1.ts` is the scripted-browser smoke test. The `check-*.sh` scripts verify the systemd scope
behaviour. Manual acceptance checks are in [`docs/acceptance/`](docs/acceptance/), one file per phase
or feature.
