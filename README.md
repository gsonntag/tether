# Tether

Run coding agents (Claude Code, Codex and Google's Antigravity) on your own machines and drive them from any browser,
desktop or phone. Close the tab and the agent keeps working. Open the same session on several
devices and they stay in sync. A Home agent can start work across your projects and see it through,
and Tether can text you when a session needs you. The design is in [SPEC.md](SPEC.md).

```
browser ──wss──► server (Foliation app: UI + relay) ◄──wss── runner (your machine) ──► claude / codex / agy
```

- [Features](#features)
- [Architecture](#architecture)
- [Setup](#setup)
- [Configuration](#configuration)
- [Development](#development)
- [Production and deploys](#production-and-deploys)
- [Testing](#testing)

## Features

**Sessions.** The runner finds your existing Claude Code (`~/.claude/projects`), Codex and Antigravity (`agy`)
sessions and shows them all in one transcript format. Nothing starts until you send. The sidebar has Recent
(the last 3 days plus every live session, grouped by project) and per-project lists, and search finds the rest. You can
rename, pin and archive sessions from the sidebar (or a session's ⋯ menu); pinned ones stay at the top on every device. A session goes live when you send and goes back to
stored after 5 idle minutes. Subagents appear as child sessions. See SPEC §4–§6a.

- **Composer** (SPEC §9): Enter sends, or steers a running turn. Tab queues the message and
  ⌘/Ctrl+Enter stops the turn and sends now. Esc stops. The queue is kept on the runner, and any device can edit, reorder or cancel it. Typing `/` opens the
  harness's own commands and skills. Text starting with `!` runs a shell command in the session's
  folder right away, and its card has a Stop button. You can attach images and files by pasting,
  dropping, the file picker or the camera.
- **Send later** (SPEC §9): schedule a message from the send menu (in 1 hour, tonight, tomorrow
  morning or any time). It waits in the queue with its time, survives runner restarts (sent late on
  start, or held for you if the runner was off for over a day after its time), and can be edited, sent now or cancelled.
- **Requests** (SPEC §7): permission prompts, questions and plans go to every device watching the
  session, and the first answer wins. A plan opens in a review view where you can comment on it.
- **Stop a running command:** while the agent waits on a shell command, a Stop button on the
  command's card ends the turn.
- **Terminal** (SPEC §8): the ❯_ button opens a plain shell for the project, and the harness's own
  TUI is a choice in the same panel. Claude hands the session off to `claude --resume` in tmux and
  takes it back when you click **Back to Tether**. Codex shares the live thread with its TUI.
  Antigravity hands off to `agy --conversation` the same way Claude does.
  Terminals outlive runner restarts.
- **Changes** (SPEC §10): the session folder's git diff beside the chat, uncommitted or the whole
  branch. Click lines to comment, then **Send to agent** puts the comments in the composer as one
  message.
- **Files** (SPEC §10): a tab beside Changes with the session folder as a tree (respecting
  `.gitignore`, hidden files behind a toggle), a filter by name, and a viewer for text, Markdown
  and images. Files that differ from HEAD are marked (M, A, U, R, C, coloured), folders holding them
  get a dot, and a toggle lists only the changed files. **Mention** puts `@path` in the composer. It reads only inside the session's folder.
- **Turn checkpoints** (SPEC §10): each turn's files are snapshotted under hidden git refs, so the
  Changes pane's **Turn** scope shows what a turn changed, and **Restore files to before this turn**
  puts them back (undoable). Your index, `HEAD` and stash are never touched.
- **Git actions** (SPEC §10): the Changes pane shows the branch and how far it is ahead of or behind
  its upstream, with **Commit** (a generated message you can edit; the default branch needs a
  tick), **Push** (never forced) and **Open PR** through `gh`. The session's PR shows as a chip in
  its header, with its state and checks.
- **A worktree per session** (SPEC §4): in a git repo, New session can make a new worktree beside
  it (`<repo>-worktrees/<slug>`, on a new branch `tether/<slug>` from the default branch) and run
  the session there. The repo's `.tether/setup` (an executable) or `.tether/config.json`
  `"setup"` command runs in it first, as a card in the session; your first message waits until it
  succeeds, and if it fails you can re-run it or send anyway. Archive done removes the worktree and its branch once
  the work is merged. The Home agent can start sessions in a worktree too.
- **Change session harness** (SPEC §15): continues a session on the other harness, or on the same
  harness with another billing source. The old session stays as it was.
- **Fork** (SPEC §16): the session menu's Fork makes a new session with the same conversation, folder,
  harness, source and settings; **Fork from here** on a reply that ends a turn makes one whose
  conversation ends there. The original is never changed, and nothing runs until you send.
- **Side chats** (SPEC §16a): `/btw <question>` (or Side chat in the session menu) asks a read-only
  fork of the session in a panel beside it (a sheet on a phone) while the session keeps working.
  **Bring back** puts the side chat's summary in the session's box to edit and send; closing it
  stops and archives it, and the header's Side chats reopens it. Side chats stay out of the lists; on
  Claude Code they have no shell, MCP tools or subagents, on Codex a read-only sandbox with MCP off.

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
  they made (a worktree Tether made for a session, Tether removes itself). It checks each answer against git, then archives the finished sessions and reports on
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
- Antigravity: the Google account `agy` is signed in with (its plan, e.g. Google AI Pro).

You add keys under **Settings → Credentials** and **Settings → Azure**, and they're stored on the
runner. New sessions start on the subscription. The header's billing chip shows the source and
switches it, and API sessions show what they've cost in dollars.

**Usage** (SPEC §10, *Usage*): **Settings → Usage** shows a runner's last 7 or 30 days of tokens
(input, output, cache reads and writes) by day, by harness and model, and by project, read from
Claude Code's and Codex's own logs, so CLI sessions count too. Dollars are estimates at published API
prices, split into plan usage and API keys, next to what Tether's own ledgers billed to API keys and
what caching saved. The plan's 5-hour and weekly limits are at the top. The logs are first read when
you open the page, which can take a few seconds; after that only what's new is read.

**Texting** (iMessage through [Photon Spectrum](https://photon.codes), or a Discord bot): the runner can text you when
a session has a request, needs you in the terminal, fails, or ends its turn with a question. Nothing
is texted for a session you're looking at in Tether. Each text starts with its session's number.
With several computers, turn on **Text for all my computers** (Settings → Messaging) on the one
that has messaging set up: it texts for all of them with one set of numbers, and your replies,
photos and files reach the session on whichever computer it runs. The others need no messaging set
up. While that computer is offline no texts go out, and the app shows a yellow banner. See SPEC §11.

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
| `shared/` | The wire protocol (`protocol.ts`), transcript model (`transcript.ts`), and helpers used by all three: credentials, costs, move, fork, side chats, commands, plan, sync |
| `server/` | Bun relay on Foliation: identity, RPC forwarding, session subscriptions, summary broadcast, terminal routing (`relay.ts`), Web Push keys (`push.ts`) |
| `runner/` | Bun runner. `src/core/`: connection, event bus, ops and the session core (`sessions.ts`, `live.ts`, `queue.ts`, `requests.ts`, `transcript.ts`). `src/adapters/claude/` (Agent SDK), `src/adapters/codex/` (app-server daemon, private hosts for API sources), `src/adapters/antigravity/` (`agy acp`) and `src/adapters/acp/` (a generic Agent Client Protocol client). `src/terminal/`: PTY and tmux. `src/modules/`: `homeAgent`, `peers`, `texting` (its connectors: `imessage.ts`, `discord.ts`), `push`, `move`, `fork`, `sideChats` |
| `web/` | React + Vite + Astryx UI |
| `scripts/` | End-to-end checks, a fake runner, probes |
| `docs/` | `acceptance/` manual checks per phase and feature, `notes/`, [`ISSUES.md`](docs/ISSUES.md) backlog |

## Setup

You need [Bun](https://bun.sh), `tmux` (for terminals), and any of `claude`, `codex` and `agy`
(Antigravity's CLI) installed and logged in on the runner's machine. Install dependencies per package:

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
| `CLAUDE_BIN`, `CODEX_BIN`, `AGY_BIN` | `claude`, `codex`, `agy` | harness binaries, if not on `PATH` |
| `AGY_HOME` | `~/.gemini/antigravity-cli` | Antigravity's store, if elsewhere |
| `TETHER_TMUX_SOCKET` | `tether` | the tmux socket terminals use (`tmux -L <socket>`). Give a dev runner its own |
| `TETHER_HIDE_PROJECTS` | | folders to leave out of the session lists |
| `TETHER_PEERS` | | `0` turns off session-to-session messaging |
| `TETHER_MAX_LIVE_SESSIONS` | no limit | the most sessions kept live at once; one more is refused with a clear error. Home chats, subagents and restart rejoins don't count. For shared hosts |
| `TETHER_PHOTON_PROJECT_ID`, `TETHER_PHOTON_PROJECT_SECRET`, `TETHER_TEXT_PHONE` | | texting, instead of Settings → Messaging (these take precedence) |
| `TETHER_DISCORD_TOKEN`, `TETHER_DISCORD_OWNER_IDS`, `TETHER_DISCORD_CHANNEL_ID` | | the Discord connector, instead of Settings → Messaging (these take precedence; owner ids comma-separated) |

On first start the runner writes `runner.json` with a generated `runnerId`. Set `"name"` there to
change its label (the default is the hostname). Never copy a `runner.json` between machines,
because two runners with one id replace each other. A runner with a `runner-<name>` token must set
its `runnerId` itself (see Production, step 2).

Server:

| Variable | |
|---|---|
| `FOLIATION_ISSUER` | Set by Foliation in production. Without it the server runs in dev mode |
| `TETHER_VAPID_PUBLIC_KEY`, `TETHER_VAPID_PRIVATE_KEY` | Web Push key pair (`bun server/scripts/vapid-keys.ts` makes one). Without them push is off |
| `TETHER_PUSH_SUBJECT` | VAPID contact (an https URL or `mailto:`) |
| `TETHER_ALLOWED_ORIGINS` | comma-separated extra origins allowed to open browser sockets. By default only the app's own host can |
| `TETHER_DEV_RUNNER_TOKEN` | dev mode: the runner token (default `dev`) |
| `TETHER_DEV_PICTURE` | dev mode: a profile picture URL for the fake owner (default none), to try the account avatar |
| `TETHER_RUNNER_OWNERS` | several tenants on one app: JSON `{"runner-<name>": ["email or user id", …]}`. Each person sees and drives only the runners of tokens listing them, and listed people may sign in with any app role. Unset: every app owner sees every runner. See [docs/multi-tenant-test-plan.md](docs/multi-tenant-test-plan.md) |

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
   server imports `shared/` at runtime. Its dependencies install from `server/`. The app's owners
   see every runner. People the app is shared with in Foliation see only the runners an owner
   shares with them in Settings → Runners, to drive or only view (SPEC §3, "Sharing runners"),
   because a runner runs commands on its owner's machine. The app deploys from `main`,
   so merging a PR deploys the web app and server.
2. **Runner token.** Create an app service token named `runner` or `runner-<name>`, e.g.
   `fol tokens create tether --service runner --role editor`. The token's name limits which
   runner ids it may connect as, so one token can never take over another's runner (and the
   rpcs, API keys among them, that go to it):
   - a token named `runner-<name>` may use the id `runner-<name>` or `runner-<name>:<anything>`.
     A generated id isn't one of those, so put `"runnerId": "runner-<name>"` (or
     `"runner-<name>:<machine>"` for several machines) in `runner.json` before the first start;
   - the token named exactly `runner` may use `runner`, `runner:<anything>`, or any id that
     doesn't start with `runner-`, so existing runners with generated ids keep working.

   The server refuses any other id. The runner then logs the server's reason, which names the ids
   its token may use, and retries every 5 minutes.
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
- `antigravity-accept.ts`: Antigravity through the real `agy` and Tether's own session core and terminal control, no browser

`smoke-p1.ts` is the scripted-browser smoke test. The `check-*.sh` scripts verify the systemd scope
behaviour. Manual acceptance checks are in [`docs/acceptance/`](docs/acceptance/), one file per phase
or feature.
