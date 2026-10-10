# Tether

Run coding agents on your own machines and drive them from any browser. You can close the
tab and the agent keeps working. Open the same session on several devices and they all stay
in sync.

Supported harnesses:
- **Claude Code**, through the Claude Agent SDK
- **Codex**, through `codex app-server`
- **pi**, through `pi --mode rpc`
- **opencode** and **Kiro CLI**, through ACP
- **Antigravity**, through `agy` in headless stream-json mode

```
browser ──wss──► Tether app on Foliation (UI + relay) ◄──wss── runner on your machine ──► agent processes
          (Foliation sign-in, owners only)                 (app service token)                 (one per live session)
```

- **`runner/`** runs on each machine you want agents on. It owns the sessions: it spawns one
  agent process per live session, keeps the transcript, and handles fallback and restarts. It
  connects out to the app, so the machine needs no inbound port.
- **`server/`** is the Foliation backend. It's a stateless relay between browsers and runners,
  so redeploying it never interrupts an agent.
- **`web/`** is the React UI. `web/src/shared/` holds the protocol, which all three parts share.

## Features

- **Projects and sessions** are discovered from every harness's own session store, so sessions
  you started in a terminal show up too.
- **A harness-neutral transcript** covers markdown, thinking, tool cards with diffs and shell
  output, todo lists, and permission prompts or questions answered from any device.
- **Steer and queue.** Enter steers a running agent; Alt+Enter queues a message for after the
  current turn. Tether holds both in an ordered list until they go out, and any device can edit,
  drag, switch or cancel them until then:
  - Messages leave from the top. A steer at the top goes into the running turn after a 5-second
    grace period. A queued message holds back everything below it until the turn ends.
  - Queued messages go out one per turn, in order. A steer below a queued message goes into that
    message's turn once it starts.
  - ↑ in an empty composer pulls all waiting messages back into the box.
  - Stop keeps waiting messages, held until you send them.
  - A steer the agent already has can't be taken back. Editing it sends a correction.
  - opencode, Kiro and Antigravity can't steer, so their steers wait for the end of the turn.
- **Fallback chains for usage limits.** A profile is an ordered list of `harness:model`
  entries, e.g. `codex:gpt-6.1-sol → codex:gpt-6-sol → codex:gpt-6-luna`. The built-in
  `codex-current` profile follows the current Codex lineup; the model picker itself is populated
  from the installed Codex CLI's entitlement-aware catalog. Each
  session gets its own copy, which you can edit or reorder.
  - **Quota exhausted:** the runner marks that provider as out until its reset time and moves
    to the next entry.
  - **Rate limited:** the runner backs off and retries the same entry indefinitely.
  - **Earlier entry resets:** the next turn goes back to it. A per-session toggle turns this off.
  - **Every entry exhausted:** the session waits for the earliest reset, then continues.
- **Cross-harness handoff.** Moving to an entry in another harness starts a linked session in
  the same directory. It's seeded with the conversation and the git state of the repository.
  The UI follows the link automatically.
- **Long runs.**
  - Turns that were in progress resume after a runner restart.
  - A watchdog warns when a running session has been silent for 15 minutes.
  - Idle agent processes close after 30 minutes and reopen from disk on demand.
- **Notifications.** The runner sends push notifications to your devices, even with Tether
  closed. Turn them on per device in Settings, choosing which kinds you want:
  - **Questions:** a permission prompt or a question from the agent.
  - **Finished:** a turn ended (not when you pressed Stop).
  - **Blocked:** the guard blocked a call, every model is at its usage limit, the agent went
    quiet for 15 minutes, or it failed.

  Clicking one opens the session; nothing is shown while you're already looking at it. The 🔔
  in the sidebar lists recent ones. Each runner has its own push key in its config. On iPhone
  and iPad, add Tether to the Home Screen first.
- **Changes view.** See what the agent changed: the changed files with +/− counts and a unified
  diff for each. Open it from the **+120 −30** button under the message box (the whole session),
  or from **N files changed** at the end of any turn that changed files (just that turn); a picker
  switches between the two.
  - The whole session runs from the first Tether checkpoint to the working tree now. The baseline
    follows cross-harness handoffs.
  - A turn runs from its checkpoint to the next one, or to the working tree for the latest turn.
  - Staged, unstaged and non-ignored untracked files all count. The runner computes the diffs
    with git in the project folder. Binary files get a note instead of a diff, and very large
    files or diffs are cut short.

## Guard: autonomous but safe

Each session has an approvals mode that applies to every harness:

| Mode | Behavior |
|---|---|
| **Ask** | Safe actions run on their own; anything else waits for you (from any device) |
| **Auto** (default) | Safety rules decide what they can, and a small judge model (Claude Haiku by default) decides the rest against your task. Never waits for a person. A blocked call goes back to the agent with the reason, and you can **Approve & retry** it later |
| **Full** | Everything is allowed |

The rules (`runner/src/guard.ts`, covered by `guard.test.ts`):
- **Always allowed:** reads, edits inside the project, and ordinary dev commands (tests, builds, git status/diff/commit, installing the lockfile).
- **Always blocked:** `sudo`, deleting outside the project, force pushes, `curl | sh`, publishing packages, and touching credentials (`~/.ssh`, `.env`, cloud configs, agent auth files).
- **Sent to the judge:** everything else, including new dependencies, pushes, network calls, Docker/kubectl, writes outside the project, and command substitution.

Each harness feeds the same guard:
- **Claude Code:** `canUseTool`.
- **Codex:** app-server approval requests. Codex runs with `untrusted` approvals, so it still runs its own list of safe read-only commands (`cat`, `ls`, `rg`, …) without asking. Its sandbox is used when it works on the machine; it confines the commands Codex runs on its own, while a command the guard approves can run outside it. Codex's decline carries no reason, so the guard's reason is steered into the turn.
- **opencode and Kiro:** ACP `request_permission`.
- **pi:** a bundled extension (`runner/hooks/pi-guard.ts`) that blocks through `tool_call`.
- **Antigravity:** a `PreToolUse` hook (`runner/hooks/agy-guard.ts`). Headless `agy` can't ask, so the runner starts it with `--dangerously-skip-permissions` and always with the hook, which then decides every call. The hook is passed per process (`--add-dir` of a runner-owned folder, `antigravity-hook/` in the runner's config dir, holding `.agents/hooks.json`, read-only, under a random hook name so a project's own `.agents/hooks.json` can't override it); nothing is installed into `~/.gemini`. The hook fails closed (no answer, a crash, a timeout or an unreachable runner is a deny), and because agy quietly runs without a hook it doesn't load, the runner also checks each process: the hook pings before every model request and the guard must have seen every tool call that ran, or the process is killed. The guard denies edits to agent hook/plugin config (`.agents/hooks.json`, `plugins/`, `~/.gemini/config`, `.claude/settings*.json`) and sends commands that mention it to the judge. Antigravity's own approving modes (accept-edits, bypass) are refused. Its `--sandbox` is off unless `AGY_SANDBOX=1`, because where its sandbox server can't start, every command fails once and is retried outside it.

**Checkpoints.** Before every turn the runner snapshots the working tree into
`refs/tether/checkpoints/…`. This never touches your index, branch or stash. The Changes view
reads its diffs from these checkpoints.

## Local development

```sh
(cd server && bun install && bun --watch src/index.ts)    # :8787, dev mode: fake owner, runner token "dev"
(cd runner && bun install && bun src/index.ts)            # connects to http://localhost:8787
(cd web && bun install && bunx vite)                      # http://127.0.0.1:5173
```

Without `FOLIATION_ISSUER` the server runs in dev mode. Every browser is treated as the
owner, and runners authenticate with `Authorization: Bearer dev`
(`TETHER_DEV_RUNNER_TOKEN`).

## Production (Foliation)

1. Deploy the app: `fol deploy` from this directory (`foliation.json`; `runner/` and `docs/`
   are left out by `.folignore`). Only owners can use the UI, because it runs commands on
   your machines.
2. Create a runner token. This needs app service tokens
   (`docs/foliation-app-service-tokens.md`):
   `fol tokens create tether --service runner --role editor`
3. On each machine:
   ```sh
   mkdir -p ~/.config/tether && cp runner/runner.env.example ~/.config/tether/runner.env   # set the URL and token
   mkdir -p ~/.config/systemd/user && cp runner/tether-runner.service ~/.config/systemd/user/
   systemctl --user daemon-reload && systemctl --user enable --now tether-runner
   loginctl enable-linger $USER
   ```
   To run several machines, give each one its own token named `runner-<name>` and its own
   `runnerId` in `~/.config/tether/runner.json`.

## Harness notes

| Harness | Needs | Notes |
|---|---|---|
| Claude Code | your Claude login (`claude`) | Permission modes, AskUserQuestion, effort levels, usage-limit events |
| Codex | `codex` logged in (`CODEX_BIN` to override) | Threads, models and effort levels from app-server; steering; usage-limit fallback. Your `approvals_reviewer` setting is overridden so approvals reach the guard. Resumed history leaves out shell commands, because Codex doesn't return them |
| pi | `pi` on PATH, its own auth | Uses your pi settings, extensions and models; extension dialogs show in the UI |
| opencode | `opencode` (`npm i -g opencode-ai`, `OPENCODE_BIN` to override); `opencode auth login` for your providers (its free Zen models work without) | ACP: models, effort (models with variants), build/plan modes, session list and replay. Every tool call asks, so it reaches the guard (`OPENCODE_PERMISSION` overrides your opencode.json `permission`). A guard denial reaches the agent without its reason |
| Kiro | `kiro-cli` logged in | ACP with the V3 engine (`KIRO_ACP_ARGS` to change it). Untested here: not installed |
| Antigravity | `agy` (1.3), signed in once interactively (`agy models` lists your models) | Headless stream-json, one process per session. Models come from `agy models`; effort switches between a model's `-low`/`-medium`/`-high` variants (single-variant models have none). Thinking, full tool results and edit diffs come from agy's transcript, which also replays history when a session is reopened. `/plan` (or plan mode) shows the plan and holds the first change until you approve it. Can't steer; Stop interrupts the turn. Its question tool is answered "skipped" by headless agy. Only sessions started from Tether are listed |

Runner state lives in `~/.config/tether/runner.json`: added projects, profiles, quota
resets, and per-session chains and links.
