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
  you started in a terminal show up too. Each project lists its sessions by their most recent
  message (yours or the agent's, live or not), and every message shows when it was written
  (hover or tap for the full date and time). Only recent sessions are listed (last 3 days by
  default; Settings → Sidebar, shared by every device), plus any that are running, working in the
  background, waiting, need you or are open. Search finds the rest, and sending one a message
  makes it recent again.
- **Clone a repo as a project.** Add project → type `org/repo` (or any GitHub URL) to clone it
  into the folder you're browsing. GitHub repos always go over SSH (`git@github.com:org/repo.git`),
  so the runner machine's own SSH key authenticates; other git URLs are cloned as given. Clones
  that take over 110 s are stopped (do those in a terminal).
- **Credentials page** (sidebar → Credentials): every login, account and API key the runner can
  run agents on, one group per provider, each row with its account or endpoint, where it comes
  from, its state, usage where Tether reads it, and where it's used ("Default order #2",
  "2 sessions"). Values never leave the runner: the app sees labels and the last 4 characters at
  most, stored values are write-only (replace, never reveal) in `<config>/credentials.json`
  (mode 600), and the guard keeps agents off it and the account logins. A credential's models are
  entries like any other ("GPT-6 Luna · Azure", "Opus 5.5 · Bedrock", "Opus 5.5 · Max (work@)") in
  pickers, chains and the default order (`harness:model#<credential>`); a session on one gets only
  that credential's variables and arguments, and its quota is tracked per credential, so a limit
  on one account moves to the next. Removing one makes its entries skipped at once.
  - **Logins and extra accounts.** Each harness login on the runner (Claude Code, Codex and pi's
    ChatGPT, Kiro, Antigravity) is listed with its account, plan, state and usage. Sign in from
    any device: Claude opens its sign-in page in a new tab and takes the code back, Codex shows a
    device code, the rest show the command to run and notice when it's done. **Add** makes another
    account with its own home under `<config>/accounts/<id>/` (`claude` as `CLAUDE_CONFIG_DIR`,
    `codex` as `CODEX_HOME`, `pi` as pi's agent dir; settings and sessions shared with the
    machine's by symlinks, pi's sessions kept in the machine's sessions dir), so a default order can
    go "Opus · Max (me@)" → "Opus · Max (work@)". The machine's own logins are never moved, and are
    signed out only by the command shown, run on the runner. A session failing on a sign-in problem
    shows **Sign in to …** and an inbox row.
  - **Microsoft Foundry (Azure OpenAI)** for GPT models in Codex and pi. An Azure
    `[model_providers.*]` in `~/.codex/config.toml` and the Codex profiles on it
    (`~/.codex/<name>.config.toml`) show up as models ("GPT-6.1 Sol · Azure"); a session on one gets
    that profile as `-c` overrides (app-server has no `-p`); only a profile's top-level scalar
    settings (`model_reasoning_effort`…) carry over, not tables. Two profiles on one deployment with
    other settings are two entries ("GPT-6 Luna (azure-luna-low)"). Or add an endpoint + key in
    Tether, then models by deployment name (tested first; the resource's model list is offered).
    The key comes from Tether's store, else the runner's env, else your login shell (`bash -lic`,
    only that variable, cached; "Store in Tether" keeps it); a stored key only ever goes to the host
    it was stored for, under the provider's own `env_key`. pi also gets `AZURE_OPENAI_BASE_URL`,
    and a small extension (loaded only for these sessions) makes the key pi's runtime key, so it
    wins over an `azure` key pi keeps in its own auth.json (which stays untouched). Azure 429s back
    off; Tether can't read Azure usage, so these entries never switch on their own (the error
    offers "Continue on …").
  - **AWS Bedrock**: Claude Code (native Bedrock) and pi (`amazon-bedrock`) on a Bedrock API key or
    an access key stored in Tether, or an AWS profile from `~/.aws` (read through the AWS CLI, its
    secrets never copied; an expired `aws login` gets "Sign in again", which relays
    `aws login --remote`: open the page, paste the code back). Add models per credential from the
    region's list or by id, each tested with one tiny call. Only that credential's AWS variables
    reach the process (endpoint, role and config-file overrides are blanked). Claude Code's
    background model is a Haiku on the same credential (one you added, else the region's from List
    models), otherwise Claude Code's own Bedrock default. pi and Claude Code on the same credential
    and model share one quota. Codex and opencode aren't wired up.
- **A harness-neutral transcript** covers markdown, thinking, tool cards with diffs and shell
  output, todo lists, and permission prompts or questions answered from any device.
- **Steer and queue.** While an agent works, the send button reads **Steer**: your message goes
  into the running turn. Its menu (the chevron beside it) offers **Queue for after this turn** and
  **Stop and send now**. Tether holds steered and queued messages in an ordered list until they go
  out, and any device can edit, reorder, switch or cancel them until then:
  - Keys (desktop, in the message box):

    | Key | Idle | Agent working |
    |---|---|---|
    | Enter | Send | Steer |
    | Tab | (moves focus) | Queue, when the box has text (with the `/` menu open, Tab completes) |
    | ⌘/Ctrl+Enter | Send | Stop and send now |
    | Shift+Enter | New line | New line |
    | Esc | Close the `/` menu, or leave ↑ history | Same; with an empty box, Stop |
    | ↑ in an empty box | Earlier messages | Pull waiting messages back into the box |

    Alt+Enter still queues for now. On phones Enter is a new line and the buttons send.
  - Messages leave from the top. A steer at the top goes into the running turn after a 5-second
    grace period; its dashed bubble at the end of the chat counts it down ("Steering in 4s").
    A queued message holds back everything below it until the turn ends.
  - Queued messages wait above the box and go out one per turn, in order. A steer below a queued
    message goes into that message's turn once it starts ("Waits for the queued message").
  - Click a waiting message (or focus it and press Enter) to edit it. A steer's bubble has × to
    cancel, **Queue instead** on hover, and the rest on right-click or a long press; a queued row
    has × and a ⋯ menu (Steer now, Stop and send now, Move up, Move down, Edit, Cancel), and
    reorders by drag too.
  - Stop keeps waiting messages, held ("Held · 2 messages") until you send them.
  - A steer the agent already has can't be taken back. Editing it sends a correction.
  - opencode, Kiro and Antigravity can't steer: the button stays **Send**, the message waits for
    the end of the turn, and there is no Queue.
  - Approvals, questions and plans waiting on you sit just above the message box until answered,
    so they never scroll away.
- **Attachments.** Attach images and files with the paperclip, by pasting a screenshot, or by
  dropping files anywhere on the session (on phones the picker also offers the photo library and
  the camera). Chips above the box show upload progress and refusals, and work for steered and
  queued messages too.
  - **Limits:** images up to 10 MB (photos are scaled to 2048 px on the long edge first), other
    files up to 25 MB, 10 per message.
  - **Transport:** files go to the runner in 256 KB chunks over the usual RPC channel, so nothing
    new passes the relay. The runner keeps them in `TETHER_CONFIG_DIR/attachments/<session>/`,
    never in the repository, read-only on disk, up to 2 GB per session (and never the disk's last
    1 GB). A session's files are deleted a week after it's removed or marked done (unless a live
    session handed off from it still lists them), and any folder untouched for 90 days.
  - **Delivery:** the message ends with an `Attached files` list of absolute paths, sizes and types,
    so every agent can open them. Images also go natively to Claude Code, Codex, pi and ACP agents
    that accept images, and PDFs up to 4 MB and 20 pages go to Claude Code as documents. Native
    files are typed by their content and kept to what model APIs accept (images up to 3.75 MB and
    8000 px, 12 MB per message); anything else is read by path. Antigravity reads everything by
    path (`--add-dir` of the session's own folder).
  - **Guard:** an agent may always read its own session's attachments (and those of a session
    handed off to it), including `pdftotext`, `unzip -l`/`-p` and `tar -t`; other sessions'
    attachments are denied. Extracting an archive goes to the judge. Writes there are always
    denied, even with full access.
  - The transcript shows thumbnails (tap to enlarge) and file chips (click to download). Handoffs
    carry the paths, and the new harness gets the images natively again.
- **Skills from the message box, on every harness.** `/` opens a menu of skills (the master
  context's registry once imported, else the harness's own skill dirs, plus the repo's
  `.claude/skills` and `.agents/skills`) and the harness's own commands, fuzzy-filtered.
  `/name args` is resolved as the message goes out (`runner/src/skillcmd.ts`), so it works for
  steered and queued messages too:
  - **Native** when the harness can run that skill itself: Claude Code `/name` (it's in its command
    list), Codex a `skill` input item (from `skills/list`), pi `/skill:name`, ACP agents `/name` when
    they list it as a command.
  - **Otherwise expanded:** SKILL.md and the absolute paths of the skill's other files go in front
    of the request in a `<skill name=… location=…>` block (Antigravity always, Claude Code for
    `.agents/skills`, …). The transcript shows a `/name` chip that opens to what the agent got.
  - `\/name` sends the text without running a skill.
  - A handoff to another harness carries the message as typed and resolves it there. Only the
    first of several waiting messages sent together can use the harness's own `/name`; the rest
    are expanded.
  - Expansion reads a repo skill's SKILL.md only if it (symlinks resolved) stays inside the repo,
    up to 256 KB, never a binary file; other files are listed, not read. Skills the master
    context disabled are never offered or expanded.
- **Fallback chains for usage limits.** A chain is an ordered list of `harness:model`
  entries, e.g. `claude-code:opus → codex:gpt-6-sol → pi:openai-codex/gpt-6-luna`. You keep one
  **default order** (Settings → New sessions; until it's saved, Home shows a "Set your default
  order" card that opens the editor pre-filled from the installed, signed-in harnesses). A new
  session starts on it unless you pick a specific model (then it has no chain): it runs on the
  first entry that's installed and not out of quota, and gets its own copy as its chain, which
  you can edit or reorder (or reset with "Use it" in the model menu). Cross-harness subagents
  started without a harness or model use it too. Editing the default order changes sessions
  started afterwards, not running ones. Model pickers are populated from each harness (Codex's
  from the installed CLI's entitlement-aware catalog).
  - **Quota exhausted:** the runner marks that provider as out until its reset time and moves
    to the next entry, but only on a definite signal: the harness's own limit error (Claude
    Code, Codex, Antigravity), or an error that looks like a limit plus a fresh usage check of
    that account (Claude, or ChatGPT for Codex and pi on `openai-codex`) showing a window at
    100%. There is no switching ahead of a limit. On AWS Bedrock a service quota or per-day limit
    counts as definite; `ThrottlingException` backs off.
  - **Entries Tether can't check** (pi on other providers, opencode, Kiro) never switch on their
    own; the chain editor marks them. Their errors, like any other error in a chain, show a
    "Continue on …" button that moves the session on by hand.
  - **Rate limited / overloaded:** the runner backs off and retries the same entry indefinitely.
  - **Earlier entry resets:** the next turn goes back to it. A per-session toggle turns this off.
  - **Every entry exhausted:** the session waits for the earliest reset, then continues. The
    wait survives a runner restart.
- **Cross-harness handoff.** Moving to an entry in another harness starts a linked session in
  the same directory. It's seeded with the conversation and the git state of the repository.
  After a mid-task switch, the old session's open approvals and questions are cancelled and its
  background tasks stopped where the harness allows it (Claude Code tasks, Codex subagents); the
  new agent is told about both and to check the working tree first.
  The UI follows the link automatically.
- **Long runs.**
  - Turns that were in progress resume after a runner restart.
  - A watchdog warns when a running session has been silent for 15 minutes with nothing
    running: a shell command, tool call or subagent that's still going isn't a stall.
  - Idle agent processes close after 5 minutes and reopen from disk on demand, unless they
    still have subagents, shells or scheduled wakeups going.
  - Opening a session that isn't running only shows it: the transcript is read from the
    harness's own store (opencode's from its SQLite database, read-only) with the settings
    Tether keeps for it, and the agent starts when you send or do something that needs it.
    Model, effort, mode, chain and guard changes made meanwhile are saved and applied when it
    starts. Kiro still starts its process to show a session.
- **Activity.** Everything a session has going on besides the transcript: subagents (with
  their model, tool calls, tokens, latest action and report), background shells and monitors
  (with their latest output), workflows, cron jobs and wakeups, plus the last 20 that finished.
  Open it from the **2 agents · 1 shell** button under the message box (a side panel on
  desktop, a sheet on phones). Home's **Running** section sums it up for every live session, and
  each session row in the sidebar shows how many are running. A session whose main agent has
  finished its turn while subagents, shells, monitors or workflows keep running counts as
  **working in background**: a grey spinner instead of the blue one in the sidebar and on Home
  (hover for what's still running), and it stays in Home's **Running** section labeled
  **Background**. With only a wakeup or cron job armed, it shows a clock instead: waiting, not
  working. Stop works per item where the harness allows:

  | Harness | Observed | Stop |
  |---|---|---|
  | Claude Code | subagents (and their internals), background shells, Monitor, workflows, MCP tasks, cron jobs, wakeups, long tool calls | every task (`stopTask`) |
  | Codex | subagent threads (steps, tokens, report), background terminals, sleeps | subagents (`turn/interrupt` on their thread) |
  | pi | pi-subagents' foreground agents and async runs, when that package is installed | no |
  | opencode, Kiro | `task` subagents (start, end, report; no steps over ACP) | no |
  | Antigravity | nothing beyond its tool cards | no |
- **Cross-harness subagents.** Any agent can start another agent on any installed harness and
  model through Tether ("use a Kiro subagent on Sonnet to write the tests"): `tether-context`'s
  `agent_harnesses` lists what's installed (models, effort levels), `agent_start` starts it,
  `agent_status` / `agent_wait` follow it, `agent_message` steers it, `agent_result` returns its
  report, diff and branch, `agent_stop` stops it. The subagent is a Tether session of its own,
  listed under the session that started it and shown in that one's activity strip (harness
  badge, model, what it's doing now); by default it works in a git worktree on a new branch
  `tether/<parent>/<name>` from the parent's HEAD (under `~/.tether/worktrees/`), or in the same
  folder on request. When its turn ends, the parent is told (a steer, or a message that starts a
  turn). Its questions and approvals come to you. Its guard is never looser than the parent's;
  at most 2 levels deep and 4 running per tree; stopping, archiving or removing the parent stops
  them. Details: `docs/harness-platform.md`, Phase 5.
- **Home.** The landing screen (and the 🏠 in the sidebar header) shows every connected runner's
  sessions at a glance, labeled by runner when there are several:
  - **Needs you:** permission prompts (Approve / Deny right there), questions with a few choices
    (one tap), plans to review, and memory conflicts (Keep new / Keep old). An answer goes to
    that exact request, once; if it was already answered elsewhere or expired, Home says so and
    nothing happens. A call too long to show in full (over 400 characters) is approved from the
    session instead. Credentials in commands and the last line are redacted on Home.
  - **Running:** each live session's status, current action, how long the turn has run, its
    subagents and shells, its context use, and a Stop button. **Running** in the sidebar jumps
    here; its count is the same, across every runner.
  - **Recently finished:** the last sessions whose turn ended, with the agent's last line and
    what the session changed (**+42 −3**).

  Tap a row to open the session; hold it (or use ⋯) to stop it, remove it, or open its Activity.
  Home is live without polling: each runner pushes a small summary of a session whenever it
  changes, at most once a second per session, and skips unchanged ones. Recently finished
  sessions are kept in the runner's memory, so the list starts empty after a runner restart.
- **Notifications.** The runner sends push notifications to your devices, even with Tether
  closed. Turn them on per device in Settings, choosing which kinds you want:
  - **Questions:** a permission prompt or a question from the agent.
  - **Finished:** the agent is truly done: a turn ended and none of its subagents, shells,
    monitors or workflows are still running (armed wakeups and cron jobs don't count). If they
    are, it comes once the last one ends and the agent has nothing more to say about it. Shells
    and monitors can run for good (a dev server), so once only they are left it waits 3 minutes
    at most and names what's still running. Not when you pressed Stop, stopped the last running
    item yourself, or the turn failed.
  - **Blocked:** the judge denied a call in Auto (a ticket you can approve, see the Guard
    section), every model is at its usage limit, the agent went quiet for 15 minutes with
    nothing running, or it failed.
  - **Memory conflicts:** a new memory contradicted an older one and the newest was kept. One
    merge pass sends at most one ("3 memory conflicts"), later ones within a minute wait and go
    out together, and a pass that ends back where it started sends nothing. Tapping it opens the
    Memory page at that conflict. On by default, also for devices subscribed before it existed
    (unless every kind was switched off there). Nothing waiting goes out once memory is turned off.

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
- **File references.** Paths in the agent's replies, plans and tool cards (`web/src/App.tsx`,
  `src/a.ts:42`, `src/a.ts:42-50`, `src/a.ts#L42`, absolute paths in the project, links to local
  files, `src/foo.ts:12:3` in shell output) open that file in a panel beside the chat (full
  screen on phones; Esc closes it).
  - **Diff** (first when the session changed the file): its whole-session diff, or one turn's,
    scrolled to the referenced line. **File**: the file as it is now, up to 1 MB and 20,000 lines;
    binary files get a note. **Open in Changes** shows it among all the changes.
  - Only real files link: the runner checks each candidate (`checkPaths`), so "and/or", URLs or
    version numbers stay text. It reads only inside the project: paths are resolved against the
    project folder, symlinks must stay inside it, and nothing under `.git` is served
    (`runner/src/files.ts`). Files the guard treats as credentials (`.env`, keys, tokens) stay
    hidden until you click **Show contents**. On phones the browser's back closes the panel.

## Guard: autonomous but safe

Each session has an approvals mode that applies to every harness:

| Mode | Behavior |
|---|---|
| **Ask** | Safe actions run on their own; anything else waits for you (from any device) |
| **Accept edits** | Like Ask, but edits inside the project run on their own |
| **Auto** (default) | Safety rules decide what they can, and a small judge model (Claude Haiku by default) decides the rest against your task. Never waits for a person. A blocked call goes back to the agent with the reason, and you get a ticket for it (below) |
| **Full access** | Everything is allowed. **Full access for 15 minutes** (the approvals picker, or ⋯ on an approval card) goes back to the previous mode by itself, with one line in the chat ("Full access ended · back to Auto"); it survives a runner restart, and picking any mode ends it |

**Approvals.** A waiting approval says who wants to do what ("Claude Code wants to run", "wants
to edit src/a.ts", "wants to call github"), how long it has waited, the command or a preview of
the edit, and the guard's note when a rule flagged it. **Approve**, **Always allow**, and at the
far end **Deny**; ⋯ has **Deny with a reason…**, **Run it myself** (shell commands: the runner
runs it and hands the agent the output) and **Full access for 15 minutes**. The push names the
call ("Approve git push origin main? · Fix login") and, on Android and desktop Chrome, has
**Approve** / **Deny** buttons that answer it without opening the app (iPhone opens the card).
An answer that comes too late (answered elsewhere) says "Already answered".

**Blocked tickets.** In Auto nothing waits for you. When the judge denies a call, the agent gets
the reason and carries on, and you get a Blocked notice with the call and the judge's reason
(Home, the bell, a push: "Blocked git push origin main · Fix login"). A session's denials within
a minute of a push go out as one ("3 calls blocked · Fix login"); that push has no buttons and
opens the session, where each call has its own. **Approve & retry** (any call) or **Run it
myself** (shell commands) on the tool card, Home, the bell or a single call's push **Approve**
lets it through and clears the ticket. Tickets are kept with the session, so they still work
after its agent has closed or the runner has restarted. The rules' own blocks (below) aren't tickets: they are
never right.

**Always allow is a rule for the project.** Besides what the harness does with it, Always allow
stores a rule for that project: a shell command's program and first subcommand (`git push`,
`docker compose`, `npm run`), an MCP server's tool, or a tool by name. Commands with
substitutions, pipes, `;`, `&&`, `||`, redirections or `sudo` aren't remembered, nor ones with a
flag, path or script where the subcommand goes (`rm -f a`, `git -C sub push`, `curl https://…`),
nor shells, interpreters and wrappers (`bash`, `python3`, `node`, `env`, `xargs`, `find`…): a
bare program would allow every use of it. That one call is still allowed, and the chat says so. Rules apply after the guard's own rules and before the
judge or you, never over a rule's block (a `git push` rule doesn't allow `git push --force`),
and an edit rule only covers edits inside the project. Settings → Approvals lists them per
project; × removes one.

**Precedent.** Your verdicts on calls the judge decides are kept per project (the last 20):
Approve & retry and Run it myself count as allowed, a Deny on an approval card for a call the
judge would have decided counts as denied. The judge sees them with every call in that project
("The owner allowed `git push origin feature/x` here on 2026-10-22") and follows them for the
same kind of call.

The rules (`runner/src/guard.ts`, covered by `guard.test.ts`; your rules and precedent by `approvals.test.ts`, tickets and timed access by `blocked.test.ts`):
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

A runner started with `TETHER_DEV=1` also takes `/tether simulate-limit …` and
`/tether simulate-usage …` in the message box, for testing fallback against real harnesses
(`docs/fallback-testing.md`).

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

Runner state lives in `~/.config/tether/runner.json`: added projects, the default order, quota
resets, and per-session chains and links.
