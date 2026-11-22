# Tether: core spec (rebuild)

Status: agreed after a grilling session, 2026-10-29. This replaces the v1 codebase (`~/web-coder`,
preserved on the `v1` branch) with fresh history on `main`, built incrementally. v2 takes over
production at the end of P1. v1 is not kept running alongside.

## 1. What Tether is

Run coding agents on your own machines and drive them from any browser, desktop or phone. You can
close the tab and the agent keeps working. Open the same session on several devices and they all
stay in sync. Every harness looks the same in Tether's transcript. A **Terminal** button opens the
harness's real terminal UI for anything Tether doesn't show.

### Decisions

| Topic | Decision |
|---|---|
| Name | Tether (app slug `tether`, env `TETHER_*`, config `~/.config/tether`) |
| Repo | `gsonntag/tether`. v1 lives on the `v1` branch and the `v1-final` tag. v2 is fresh history on `main`, the default branch. `master` is deleted. Local checkout `~/tether`. v1 code is referenced and copied over deliberately, never wholesale (§12) |
| Harnesses in the core | Claude Code and Codex. Antigravity (Google's `agy`) came next through the same adapter interface (§6); others can follow |
| Primary UI | Tether's own unified transcript, the same for every harness |
| Consistency vs harness strengths | **A harness's own strengths win over identical behavior.** When one harness can do something better (e.g. Codex sharing a live thread with its TUI), use it, behind an adapter capability flag |
| Harness-specific features | Through the **Terminal** button: the harness's real TUI, mirrored (§8). A plain shell per project is an option in the same panel |
| Approvals | Each harness's own permission modes; Tether relays prompts to any device. Every decision goes through one runner-side pipeline so the **Tether judge can be added back later** (§7) |
| Phone | First-class for both driving and checking in. Every core feature must work on a phone |
| Hosting | Same as v1: Foliation app `tether` (UI and relay) plus a runner that dials out with an app service token |
| Terminal security | Owner-only Foliation sign-in, like everything else. No extra per-device step |
| Sessions resumed outside Tether | Not detected or prevented. Running `claude --resume` on a session Tether is driving is on you |
| Several runners | The protocol supports them from day one (`runnerId` everywhere). The UI shows runner choice only when more than one is connected. Cloud containers later = a provisioner module that starts runners in containers |
| Stack | Same as v1: Bun (server, runner), React + Vite + Astryx (web). Keep the frontend light so it can change |

### Non-goals for the core

Fallback chains, the judge, master context (shared memory), the MCP registry, cross-harness
subagents, plan review, forks, and libraries for writing hooks, commands or subagent definitions.
Each may come back later as a module (§3). None of them may require editing the session core. A
harness's own commands and skills, `/goal` `/loop` `/schedule` `/review` among them, aren't Tether
features: the message box offers and passes on what the harness has (§9 Commands). Cross-harness handoff came back this way, as an explicit move a
person starts (§15); an automatic one stays a non-goal. Cross-harness subagents came back the same
way, as ordinary sessions an agent starts (`tether_start`, §9a).

## 2. Principles

1. **A small core, with features as modules.** The session core does lifecycle, transcript, requests
   and messaging. Every other feature subscribes to session events and calls a narrow API. No file
   grows past about 800 lines. If one has to, the design is wrong.
2. **The harness's store is the source of truth for the transcript.** Tether never keeps its own copy
   of a conversation. It reads Claude's JSONL and Codex's rollout files. That makes terminal
   sessions, CLI sessions and Tether sessions the same thing.
3. **The runner owns live state. The server is a stateless relay.** Redeploying the app never
   interrupts an agent.
4. **Every feature is tested against the real harness.** Unit tests with recorded fixtures are
   necessary but not enough. Each phase has acceptance checks run against real `claude` and `codex`
   (§11).
5. **Harness strengths over uniformity.** The transcript looks the same for every harness, but
   behavior may differ where a harness does something better. Differences are declared as adapter
   capabilities (`canSteer`, `terminal: "handoff" | "shared"`, …), never special-cased in the core.
6. **Direct UI.** No confirm dialogs or undo toasts, no status-bar chatter. Transient status goes
   inline in the chat. Use human labels ("Opus 5.5", "High").

## 3. Architecture

```
browser ──wss──► server (Foliation app: UI + relay) ◄──wss── runner (your machine) ──► claude / codex
       (Foliation sign-in, owners only)               (app service token)          └─► tmux (terminal mode)
```

```
tether/
  shared/     protocol types (wire format), used by all three
  server/     relay: auth, routes rpc and events, no session state
  runner/
    src/core/       connection, session registry, session lifecycle, request broker, message queue
    src/adapters/   claude/, codex/ (each: driver, history reader, discovery, terminal launch)
    src/terminal/   tmux control, PTY bridge, handoff
    src/modules/    later features (notifications, checkpoints, judge, …) subscribe to core events
  web/        React UI
```

**Sharing runners.** The app's owners see and manage every runner. Anyone else the app is shared
with on Foliation (editor or viewer) may sign in but sees only the runners an owner shared with
them in Settings → Runners, each "Can drive" or "Can view" (read sessions only); a Foliation viewer
share only ever views. Settings → Runners shows each runner's version (short git commit, commit date,
"local changes" if dirty; package.json version fallback), with a quiet note when behind its upstream branch
("Behind <branch> by N commits: pull and restart the runner to update"); in production the server has no `.git/`,
so the runner's own `behind` count drives the note, with a server build comparison as fallback in dev mode. The list lives on the runner (runner.json `sharedWith`, op
`setRunnerAccess`) and the relay enforces it on every frame (shared/access.ts: `VIEW_OPS`, and
`MANAGE_OPS` that stay the owner's: sharing, name, keys, texting, updates, runner settings, usage). Settings
pages and runner pickers show only what the person's access allows (`shared/access.ts`); pages with no usable
runners are hidden from the menu, and shared people see only their own device notifications. View never includes the git or files modules' ops (they read the folder,
secrets too) or making short links. A runner not shared with you leaves no trace: the server never
lists it, and the browser remembers only runners you own (to show one that went offline), keyed by
who is signed in, so a runner shared with you that leaves the list (unshared, or offline) is just
gone, and a browser one person used shows another nothing. A
change applies at once; a Foliation role change at the next renew ticket, which carries the role.
Public-link visitors and app calls never get in. A person's app user token (`fol app-token
tether`, Foliation contracts/app-user-tokens.md: the identity carries `tok: true` with their current
role) is that person: the same sign-in, tickets and runner sharing as their browser, with no Origin
header to check. The server verifies identities with Foliation's own claim rules
(server/src/claims.ts), tested against Foliation's identity vectors (server/src/testdata). With
TETHER_RUNNER_OWNERS, a runner's listed people are its owners.

**Who may connect.** A browser must be an app owner or shared person when it opens its socket, and keeps proving
it: the page fetches a short-lived ticket from `GET /api/ws-ticket` (an ordinary request the edge
signs afresh) every 2 minutes and sends it as `renew`. A socket without a valid ticket for 5
minutes is closed (`CLOSE_REAUTH`), so a revoked share loses access within minutes. A runner's
service token named N may claim the runner id N or `N:*`; the original token `runner` may also
claim any id not starting with `runner-` (`CLOSE_RUNNER_ID` otherwise; server/src/runnerIds.ts).

**Core events, inside the runner.** The session core emits typed events on an in-process bus:
`turnStarted`, `turnEnded`, `message`, `toolCall`, `requestOpened`, `requestClosed`, `modeChanged`
(live, terminal or stored), `error`. Modules subscribe to these. The core never imports a module.

## 4. Domain model

- **Runner:** one machine. `id`, hostname, available harnesses, connected flag.
- **Project:** a folder on the runner. It is discovered from the harness stores plus any folders you add.
  `TETHER_HIDE_PROJECTS` (the runner's environment) is a comma-separated list of path globs matched
  against the whole folder path, `*` matching anything including `/` (`/tmp/*,*/scratch`). The core
  leaves matching projects and sessions out of project lists, session lists and Home, for every
  harness, after the adapters' discovery. Nothing is deleted. A session that is open, live or has
  queued messages stays listed, and a hidden session opens by id as usual. Unset, nothing is hidden
  but the removed Home agent's old folder (`<config>/modules/homeAgent/workspace`), always hidden, so
  its old chats stay out of the lists as they always were.
  New session can make a folder: the dialog asks the runner (`checkFolder`), warns when it doesn't
  exist yet, and only a confirmed `createFolder` on `newSession` makes it, parents too. Only a path
  starting with `/` or `~/` is made.
- **A worktree per session** (`modules/worktrees`). For a folder in git with a commit
  (`workspaceInfo`), New session offers **Workspace**: *This folder* (default) or *New worktree*,
  with a branch (shown, and sent, as `tether/<slug>`: a slug of the session's title or brief, a
  hash of text with no usable words, else `wt-<random>`). Creates in one repo run one at a time.
  `newWorktreeSession` resolves the base, `origin/HEAD`, else `origin/main|master`, else local
  `main|master`, else `HEAD`; for `origin/<x>` it first runs `git fetch origin <x>` (best effort: 15 s,
  no prompts: `credential.interactive=false`, `GCM_INTERACTIVE=never`, ssh in batch mode unless
  the repo or environment sets its own ssh command; failed: as last fetched; the dialog says when). Then
  `git worktree add --no-track -b <branch> <repo>-worktrees/<slug> <sha>` from the main checkout. A
  name git doesn't take as typed (`@`, `@{…}`, …), or a branch (local or on a remote) or folder that
  exists, is refused. A failed add undoes only what it made: never a path or branch git refused as
  existing; the worktree only when git lists it on this branch, the branch only while still at the
  base commit (`update-ref -d`), an empty `<repo>-worktrees` it made. git runs as argv, in its own
  process group, with time limits and no prompts; `worktree add` runs the repo's post-checkout hook,
  as a person's would (the agent gets the same access there anyway), in the C locale (its error
  text is matched). Then `newSession` in it (a
  failed start undoes it the same way), and runner.json records `worktree: {path, branch, repo,
  known}` on the session: its own (`known`: each ignored file, with its size, time and, up to 1 MB, a
  content hash, there once it
  was made, plus what each setup run made or changed, taken when it ends before anything waiting goes
  to the agent, against a snapshot at its start; files made by hand before a Re-run setup aren't). The
  summary carries `worktreeOf` (the main checkout) for grouping, `worktreeBranch`, and
  `worktreeHandMade` for one made by hand. **Setup:** `.tether/setup`
  (executable, run directly) or `.tether/config.json`'s `"setup"` (via `$SHELL -c`), the worktree's
  own (the base's, which the dialog reads from git and shows, marked when cut short; the dialog
sends back its `setupId`: the script's blob id, or a hash of the whole command; a create whose
fetched base has another setup is refused with the new one named, nothing made. It's a "what you
saw is what runs" check, not a trust boundary: the repo's code runs either way. `tether_start`'s
runs whatever the base has) before the main checkout's, runs in
  the worktree with `TETHER_WORKTREE`, `TETHER_REPO` and `TETHER_BRANCH` as a `!` card (§9) marked
  `setup`, whose output never goes to the agent (state `done`), for at most 30 minutes (then
  stopped, failed). A terminal start in a repo with a setup is refused (its TUI wouldn't wait).
  While it runs (`LiveState.setup: "running"`, also in runner.json) every send, an agent's
  too, queues held (`queueHeldBy: "setup"`, not shown as needing you), Resume and `!` commands
  refuse; success
  releases the queue. After a failure (`setup: "failed"`), or a restart that cut it off, what waits
  and what you send next stay held, even with nothing queued; Home shows the session failed, and
  the card offers **Re-run setup** (`rerunSetup`) and **Send anyway** (Resume, which ends the gate).
  Archiving the session removes it once that's safe (§10 Archiving).
  **Existing worktrees** (runners with `existingWorktrees`; New session no longer offers it, agents
  use it through `tether_start`): `listWorktrees` lists the repo's
  worktrees from `git worktree list --porcelain` (not the main checkout, bare or prunable ones):
  path, branch, and the sessions working in each (not archived: listed ones whose folder is in it,
  and any of any age whose runner.json `worktree` names it). `existingWorktreeSession {…, worktree}` (a path or branch) runs `newSession` there: nothing
  made, no setup rerun. It records `worktree` with `joined`, as a live (not archived) user's record
  on the worktree's current branch has it, else `handMade` (a person's `git worktree add`, or a
  record that can't be trusted: never removed by Tether). Joining and the removal on archive of one
  worktree share a lock; a join re-checks the worktree is there inside it. A session's successor on
  another id (source change, renewal) keeps the record (the old id stops counting); a Move's new
  session and a fork (not a side chat) get one too. Agents: `tether_start` takes
  `worktree: "<path or branch>"` too (a path, else a branch, else a folder name only one has).
- **Session:** `harness` + `nativeId` (the harness's own id) + `projectPath`. Tether's id is
  `${harness}:${nativeId}`. A session is in exactly one **mode** at a time:

| Mode | Who drives | What Tether shows |
|---|---|---|
| `stored` | nobody | transcript read from the store; opening never starts a process |
| `live` | Tether, through the harness's programmatic interface (Agent SDK, `codex app-server`) | live transcript, composer, requests |
| `terminal` | the real TUI in tmux | mirrored terminal, plus a read-only live transcript tailed from the store |

Transitions: `stored → live` (send something), `live → stored` (idle 5 minutes, process closes),
`live ⇄ terminal` (Terminal button, §8), `stored → terminal` (Terminal button on a stored session),
`terminal → stored` (the TUI exits).

**A runner restart mid-turn continues the turn.** When the runner stops while a turn runs (an
upgrade, a crash) and its harness didn't keep the turn going itself, the runner resumes the session
when it starts again and sends Tether's own short marked message ("Tether: continue after restart. …"),
with the session's settings, as any send; the transcript shows it as Tether's, after a notice ("The
Tether runner restarted mid-turn; continuing."). Waiting messages follow that turn as usual.
- **Never two processes on one session.** A runner killed without closing its harness (kill -9, a
  crash, outside systemd) can leave Claude Code running the turn. Before continuing, Tether waits for
  the session's store (its .jsonl) to be unchanged for 15 s ("Waiting for Claude from before the
  restart to finish…", naming the harness, the queue held); it never inspects or signals processes. Then, if the store
  shows the turn finished (the agent's answer after the last prompt), nothing is continued and the
  queue goes on; otherwise it continues once. After 10 minutes of writes it gives up: Failed on Home,
  the queue held, "Send a message to carry on." During the wait nothing starts Claude: a message you
  send queues, held, and follows the continue; Resume can't release it. The wait is saved (`running`
  and `restartWait` in runner.json), so a restart during it comes back to it, and the turn's continue count
  (`continues`) goes up only once a continue goes out. Opening the terminal during the wait cancels the continue: your
  queue waits for Back to Tether. Residual risk: a left-behind process silent for over
  15 s (a long tool call) could still overlap; production's systemd unit (KillMode=mixed) ends a
  stopped runner's children anyway.
- **Not** for a session waiting on the person (a saved request is asked again instead), one the
  person stopped (saved at once, so a restart before the stop takes effect doesn't continue it), one
  whose TUI drives; nor when it looks like a crash loop: within 30 s of the last automatic continue,
  or a turn already continued 5 times without ending (the count clears when the turn ends or you
  send something). A continued turn cut off again by a later restart is continued again. Those it
  skips fall back to Failed on Home and a held queue, and the runner logs why. A harness that keeps turns
  going (Codex's daemon) is just rejoined.

- **Subagent:** a session too, with `parentSessionId` and `parentToolId` (the tool call that started
  it). It has the same transcript, paging and live events as any session, so the same view shows it.
  Details in §6a.

Runner state on disk (`~/.config/tether/runner.json`, mode 600) is small: runner id, which
sessions are in which mode, per-session prefs (model, effort, permission mode), queued
messages, and open requests. **Not** transcripts. Adapters keep small files beside it for what their
harness's store lacks (`codex-threads.json`, `claude-windows.json`).

## 5. Protocol (shared/)

### Envelope

Browser → server → runner: `{ t: "rpc", id, runnerId, op, args }`, which gets `{ t: "result", id, ok, data?, error? }`.
Runner → server → browsers: `{ t: "event", runnerId, sessionId, seq, event }`.
On connect, the runner sends `{ t: "hello", runner: RunnerInfo }` with its installed harnesses and
optional `build` (`commit`, `date`, `branch`, `dirty`, `behind`) read from git at startup and hourly; the server sends
`{ t: "hello", user, protocol, push?, build? }` to browsers.

**Subscriptions.** A browser subscribes to the sessions it has open (`subscribe` / `unsubscribe`
ops). The server forwards session events only to subscribers, and forwards a small `summary` stream
(the sidebar and Home) to every browser. Terminal output is never broadcast (§8).

**Sync.** Each session has a monotonically increasing `seq`. On subscribe, the runner sends a
`snapshot { session, messages, state, seq }`. The browser applies events with `seq = last + 1`
and re-subscribes for a fresh snapshot on any gap or reconnect. This one rule handles tab close,
phone sleep, network changes and multi-device sync.

**Paging.** Snapshots (and `reset`) carry only the newest messages (`TRANSCRIPT_PAGE = 50`) plus
`hasOlder`. The `history` op fetches older pages as you scroll up, so long sessions open instantly.
The browser mounts a bounded slice of what it has loaded, 300 messages (up to 400 until a fling
down settles), rendered plainly
(no estimated row heights, which shift content under a finger). It writes the scroll position only
while no finger is down and no fling is running, because iOS Safari ends a fling on any write. So
rows are added or dropped *above* the viewport only once the scroll settles, with the reader's place
kept (a page that arrives mid-fling shows then); rows *below* it come and go at any time, which never
moves what's on screen. Scrolling up past the cap drops the newest rows ("Newer messages" marks the
gap; Jump to latest brings them back), and following the bottom keeps only the newest 100 once
settled. Following stops when the reader really moves the view up, more than a few pixels, by finger,
wheel, keys or scrollbar; a scroll on its own, as when the composer grows, doesn't, nor a wheel that
moves nothing. Moving down to the real bottom follows again. Keys scroll once the transcript's text
was clicked. Selecting text with the mouse stops following too, and nothing writes the scroll position
until the button is up, so the browser's autoscroll carries the selection. A reconnect keeps what's
loaded: its snapshot joins the older pages (any gap between them is paged in), so a reader keeps their
place and a follower keeps following.

### Transcript

v1's `Msg` / `Part` model is kept, but trimmed: parts are `text`, `thinking`, `image`, and `tool`
(`id`, `name`, `kind`, `input`, `status`, `output`, `command?`, `path?`, `parentToolId?`).
`kind` (`shell`, `edit`, `write`, `read`, `search`, `fetch`, `todo`, `task`, `other`) is how the UI renders
tool calls from every harness the same way. Messages have roles `user`, `assistant` and `notice`.

Session and send errors show only in the chat, as error notices; nothing red sits above the composer, and
a send that failed leaves its text in the box. The same error again is one row: the runner adds no repeat of
the row above it, and the transcript hides repeats (`shared/notices.ts`), also across messages you sent
meanwhile, which then say they failed.

Session events: `msg` (upsert by id), `delta` (streamed text), `tool` (patch a tool part), `state`
(patch live state), `reset` (replace the transcript, after compaction).

### Live state

`mode`, `status` (`idle`, `running` or `waiting`), `model`, `effort`, `permissionMode`, `context?`,
`plan?`, `requests[]` (open approvals and questions), `queue[]` (waiting messages), `terminal?` (attach
info), `error?`.

**`context`** is `{ used, total }` in tokens: the context in use now, not what the session spent, so
it drops after a compaction or a `/clear`. Unknown means absent, and nothing is shown: Tether never
guesses a window, and a count over its window is unknown too. Live drivers report it during a turn;
stored sessions and Claude's terminal mode read it from the store (`Adapter.storedContext`, on opening
and on each store change). Subagents have none. A runner without the field shows no chip.

**`billing`** is what the session draws from on its latest start, `{ kind, label }`, as the harness
reported it at runtime, never from config: "Claude plan", "Anthropic API key", "ChatGPT plan", "OpenAI
API key", "Azure" and so on, or "Unknown". Unknown is an answer: a stored session whose start wasn't
recorded says it. Absent means an old runner, or a session not started yet. Plan limits show only
when `kind` is `plan`, so a session on a key or a provider never shows them on its chip (the chip's
menu shows the plan's figures, by the plan's name, on any session). It stays off push notifications.

**`plan`** is the harness account's plan limits, `{ fiveHour?, week? }`, each `{ percent, resetsAt? }`.
It's account-wide: the latest report goes to all the harness's open sessions and to those opened
later (`SessionCore.notePlan`). Only windows the harness named are there; partial reports merge. The
browser drops a window past its `resetsAt`. Nothing reported means absent, and no chip. A window's
`at` is when it was reported. Only what runs on the login reports: a report from a session on a key
is dropped, so `plan` is always the plan's.

### Core ops

`listProjects`, `listSessions`, `subscribe`, `unsubscribe`, `newSession`, `checkFolder`, `send`, `steer`,
`queue`, `editQueued`, `cancelQueued`, `interrupt`, `answerRequest`, `setModel`, `setEffort`,
`setPermissionMode`, `listModels`, `listCommands`, `deleteSession`, `setSessionArchived`, `pinSession`, `openTerminal`, `closeTerminal`,
`terminalInput`, `terminalResize`, `runShell`, `stopShell` (P5b, §9 Shell commands). The move module
adds `moveOptions` and `moveSession` (§15), the usage module `usage` (§10 Usage), the worktrees
module `workspaceInfo`, `newWorktreeSession`, `listWorktrees`, `existingWorktreeSession` and `rerunSetup` (§4), the fork module `forkSession` (§16),
the git module `gitDiff` (§10 Changes), `checkpoints` and `restoreCheckpoint` (§10 Checkpoints), the
files module `listDir`, `readFile` and `findFiles` (§10 Files).

## 6. Adapters

```ts
interface Adapter {
  id: HarnessId;
  /** what this harness does better or differently; the core branches only on these */
  capabilities: { canSteer: boolean; terminal: "handoff" | "shared" };
  available(): Promise<boolean>;
  // discovery and history: read-only, no process
  listProjects(): Promise<StoredProject[]>;
  listSessions(projectPath: string): Promise<SessionSummary[]>;
  readHistory(nativeId: string, projectPath: string): Promise<Msg[]>;
  watchHistory(nativeId: string, projectPath: string, onChange: (msgs: Msg[]) => void): () => void;
  // live driving
  start(projectPath: string, opts: StartOpts, sink: Sink): Promise<Driver>;
  resume(nativeId: string, projectPath: string, opts: StartOpts, sink: Sink): Promise<Driver>;
  listModels(): Promise<ModelInfo>;
  // terminal mode
  terminalCommand(nativeId: string | undefined, projectPath: string, opts: StartOpts): { argv: string[]; env?: Record<string, string> };
}

interface Driver {
  nativeId: string;
  send(text: string, attachments?: Attachment[]): Promise<void>;   // starts a turn
  steer?(text: string): Promise<void>;                                // into the running turn
  interrupt(): Promise<void>;
  setModel(m: string): Promise<void>;
  setEffort?(e: string): Promise<void>;
  setPermissionMode(m: string): Promise<void>;
  close(): Promise<void>;
}
```

The driver reports through the `Sink`: transcript events, status, and **permission requests**, which
it hands to the request broker as a Promise and waits on (§7). Adapters never talk to the UI or the
relay directly.

### Claude Code

- **Drive:** Claude Agent SDK `query()` with streaming input, so a running turn can take more
  messages (steer). Resume with `resume: nativeId`. `interrupt()`, `setModel()` and
  `setPermissionMode()` on the query.
- **Permissions:** native modes (`default`, `acceptEdits`, `plan`, `bypassPermissions`, plus
  `auto` where the SDK offers it). `canUseTool` goes to the request broker.
- **History:** `~/.claude/projects/<slug>/<id>.jsonl`. The parser and fixtures come from v1.
- **Terminal:** `terminal: "handoff"`. `claude --resume <id>` in the project folder. A new session
  started in the terminal gets `claude --session-id <uuid>` so Tether picks its id.
- **Context:** the last main-thread assistant message's input + cache read + cache creation tokens
  (`<synthetic>` replies and subagents don't count). That matches `/context`. The window is
  `modelUsage[<the message's model>].contextWindow` in the `result` (a result lists every model used,
  background calls too; a `[1m]` model is keyed without the suffix). The store has no window, so
  `claude-windows.json` in the runner's config dir keeps the last reported per session and per model.
  Failing those, Claude Code's own cached catalog (`cache/model-catalog/*-cc.json`,
  `runtime.max_input_tokens`), skipped under `CLAUDE_CODE_DISABLE_1M_CONTEXT` (real reports: 200k
  there, against the catalog's 1M). Failing that, unknown. Tether keeps no table of its own. A
  compaction or `/clear` has no message to read: live, the result that ends it asks
  `getContextUsage({ detail: "summary" })`; stored, a compaction with no message since is unknown (its
  `postTokens` leave out the system prompt and tools: 10.5k said, 33k real).
- **Billing:** `accountInfo()` when a driver starts, with inherited provider/key/proxy variables
  removed and the selected source supplied through private `apiKeyHelper` settings. Managed starts
  require `apiProvider: firstParty`; a key start requires `apiKeySource: apiKeyHelper`, and a
  subscription start must report a plan without a key/token override. Unknown or mismatched
  reports refuse the send. The native report fields are:
  `apiProvider` other than `firstParty` is that provider (`bedrock`, `vertex`, `foundry`…); a real
  `apiKeySource` is "Anthropic API key", ahead of a login (with `ANTHROPIC_API_KEY` it still says
  `tokenSource: "claude.ai"`); `subscriptionType` is "Claude plan"; `ANTHROPIC_AUTH_TOKEN` shows as
  `tokenSource` ("Anthropic auth token"). Anything else is Unknown. `ANTHROPIC_BASE_URL` doesn't show
  in these reports. Only the start says, so it's kept per session in `claude-windows.json`. A start in
  Claude's TUI is preflighted using read-only `auth status --json` with identical settings before
  launch. Its launcher holds an immutable key lease in memory; the real TUI and its tools never
  inherit the raw key in their environment. External/historical proxy starts remain a label gap
  (docs/ISSUES.md).
- **Plan exhausted:** §10 **Fallback chain** has the signals.
- **Plan limits:** `rate_limit_event` frames: `rate_limit_info.unifiedWindows.{five_hour,seven_day}`
  (`utilization` 0 to 1, `resetsAt` in seconds), or the top-level `rateLimitType`/`utilization` on a
  frame without them. A frame can have no number at all (status only), or just one window. The latest
  is kept in `claude-windows.json` for stored sessions and a restart. Claude's TUI reports none to
  Tether, so its turns don't move it. Not used: the SDK's `usage_EXPERIMENTAL…` call (unstable by its
  own name) and the status line's `rate_limits` (it would need Tether's own status line in the TUI).

### Codex

- **Drive (subscription):** the **shared local app-server daemon**. API sessions use a separate,
  private app-server and key-sanitizing gateway per session, with their own home and socket. The
  shared daemon is never reconfigured or restarted for credentials. Its control
  socket is `~/.codex/app-server-control/app-server-control.sock` and speaks **WebSocket over a Unix
  socket** (HTTP upgrade, then JSON-RPC text frames; `codex app-server proxy` only relays raw bytes, so
  Tether does the WS handshake itself). Methods: `thread/start`, `thread/resume` (rejoins a thread
  that's already loaded), `turn/start`, `turn/steer`, `turn/interrupt`, `thread/settings/update`,
  `model/list`, `thread/unsubscribe`. Several connections can subscribe to one thread at once, and
  each sees every event (confirmed by probe, 2026-10-29). Threads live in the daemon, so they
  survive a runner restart. If the daemon isn't running, start it (`codex app-server daemon`).
  A thread with no turns yet can't be resumed ("no rollout found").
- **Permissions:** native approval policy and sandbox. `item/commandExecution/requestApproval`,
  `item/fileChange/requestApproval` and `item/tool/requestUserInput` go to the request broker.
  **Plan** mode is Codex's own (experimental) collaboration mode `plan`, set with
  `thread/settings/update` and pinned on `turn/start`, in a read-only sandbox. The app-server has
  no review step (its TUI's "Implement this plan?" is client-side), so a turn that completes with a
  `plan` item raises a plan request (`planFollowUp`, §7) that Tether answers itself.
- **Input to a background command with more access.** A command in one of Codex's background
  terminals keeps the settings of the turn that started it (`running.ts`). Once the session is
  tightened, a later turn's `write_stdin` raises `item/commandExecution/requestApproval` with
  `kind: "writeStdin"` (its `itemId` is the command's). If that command has more access than the
  session now has, or Tether can't find it or its settings (fail closed), Tether declines without
  asking anyone: approved, the command would do what the tighter turn tells it with its own wider
  access. The agent gets the reason as a steer, the person a notice. Input to a command no looser
  than shown is asked as usual ("Send input to a running command"). With **Approve for me**
  (`@codex-reviews`) Codex's reviewer answers inside Codex and Tether never gets the request, only
  `item/autoApprovalReview/started` (action `writeStdin`, with the `processId`). For a looser command
  Tether stops it (`thread/backgroundTerminals/terminate`) as the review starts. The review takes
  seconds, so the write fails ("Unknown process id"). Checked on codex-cli 0.171.0, 2026-11-21: with
  no fix, the reviewer approved and the write went through.
- **History:** rollout files under `~/.codex/sessions/`, or `thread/read`. The parser comes from v1.
- **Terminal:** `terminal: "shared"`. `codex resume --remote <socket> <id>` attaches the TUI to the
  same live thread through the daemon (without `--remote` the TUI runs its own app-server). Tether
  keeps driving; there is no handoff and no read-only mode. Verified with real turns in P4: approval
  requests reach every connection and clear everywhere (`serverRequest/resolved`), and `turn/steer`
  works from either side.
- **Context:** `thread/tokenUsage/updated`: `tokenUsage.last.totalTokens` of `modelContextWindow` (may
  be null: unknown). `total` is cumulative spend. After a compaction `last` has zero input tokens and
  `totalTokens` is what's left. Joining a thread replays the last report. Stored: the rollout's newest
  `token_count` with `info` (`last_token_usage.total_tokens`, `model_context_window`). Same tokens as
  Codex's TUI; its own percent differs, as it leaves a 12k baseline out of both sides (21.7k of 258k:
  it says 4%, Tether 8%).
- **Billing:** the thread's `modelProvider` (`thread/start`, `thread/resume`, `thread/read`), then for
  `openai` `account/read`'s `account.type`: `chatgpt` is "ChatGPT plan", `apiKey` "OpenAI API key". Any
  other provider is itself ("Azure"), whatever account the daemon has. `account: null` is Unknown: a
  key only in the daemon's environment shows that way, and isn't used. The account is the daemon's now,
  so it's read at each driver start and remembered per thread (`codex-threads.json`); a stored `openai`
  thread Tether never started is Unknown (the provider of any stored thread is known).
- **Plan exhausted:** §10 **Fallback chain** has the signals.
- **Plan limits:** `account/rateLimits/read` when a session opens (at most once a minute, no turn) and
  `account/rateLimits/updated` on a live connection (sparse). `primary`/`secondary` are placed by
  `windowDurationMins` (300, 10080); `usedPercent`, `resetsAt` in seconds.

### Antigravity

Google's coding agent, through its CLI `agy` (checked on 1.5.13). Everything goes through the
**Agent Client Protocol** (ACP: JSON-RPC 2.0, a message per line, over stdio) that the hidden
`agy acp` serves. The client in `adapters/acp/` is generic, so a later ACP harness can reuse it.

- **Drive:** one `agy acp` per live session, which `session/load`s the conversation; each message
  is a `session/prompt`, Stop is `session/cancel`. **No steering** (`canSteer: false`): a prompt sent
  during a turn ends that turn's wait and runs after it, so Tether queues instead.
- **Ids:** Antigravity picks them. `newId` makes the conversation (`session/new`), stored with no
  prompt (not listed until its first), and the driver loads it. A prompt to an id it didn't make fails.
- **Permissions:** its modes `default` (asks for edits and commands), `accept-edits` and `plan`
  (`session/set_mode`), and Tether's own **Bypass permissions** (`bypassPermissions`): Antigravity
  runs in `accept-edits` and the driver approves every request itself, a subagent's too, so nothing
  asks; questions still come to you, and a side chat never bypasses. In the TUI it's
  `--dangerously-skip-permissions`. Antigravity's own `auto` mode is refused over ACP on 1.5.13 ("needs
  the OS terminal sandbox and may not be rolled out to you yet", `--sandbox` or not). The mode comes
  only from `current_mode_update` and what Tether sets: a settings snapshot can arrive after a mode
  change carrying the old one. `session/request_permission` goes to the broker; allow and reject map to its
  `allow_once` and `reject_once` options. A denial carries no reason (`noReason`). A request with
  other options is a question with them as answers.
- **Model and effort:** `configOptions`, set with `session/set_config_option`: `model` (a family,
  "gemini-3.8-flash") and `thought_level` (low, medium, high) as the effort. "Default" leaves the
  model to Antigravity.
- **History:** the store is `~/.gemini/antigravity-cli/conversations/<id>.db`, SQLite whose rows are
  undocumented protobuf, so Tether doesn't parse it. `session/load` replays a conversation as
  `session/update`s instead; one builder (`acp/transcript.ts`) turns a replay and a live turn into
  the same messages under the same ids: a prompt is a message, and everything until the next prompt
  is one assistant message. Antigravity keeps no time per message: one is dated when Tether first sees it.
  **An exception to "discovery starts no process":** listing and reading start a short-lived
  `agy acp` per call (about 160 ms to start). A long-lived one would read stale history: a process
  keeps the conversations it has seen in memory and never sees another process's turns.
  `watchHistory` polls the `.db` and its `-wal` and replays on a change.
- **Context:** `usage_update { used, size }`.
- **Billing:** the plan tier `session/new` and `session/load` name (`_meta.antigravity.tier.name`,
  "Google AI Pro"). No keys yet, and no plan limits: Antigravity reports none.
- **Terminal:** `terminal: "handoff"`, `agy --conversation <id>` in the project folder, with `--mode`
  for `accept-edits` and `plan`. On a resumed conversation the TUI ignores `--model` and `--effort`:
  its model is its own. No hooks: the screen (`antigravity/screen.ts`) says when a permission prompt
  or the folder-trust question is up. Quitting is Esc, then Ctrl-C until it exits.
- **Turns it runs by itself:** when a subagent reports back, the main agent goes on with no prompt:
  its updates arrive with no `session/prompt` and no end. They show as working, join the last
  reply (as a replay groups them), and end after 3 quiet seconds (`driver.ts`).
- **Subagents** (§6a), **plan review** (§7), **Tether's tools** (§9a), **move** (§15), **fork**
  (§16) and **side chats** (§16a): in those sections. Not yet: Gemini API keys.

### Claude's model and effort

There's no "Default" for a Claude session: Tether always tells Claude Code its model and effort, so
what's shown is what runs. Each is settled on its own, at every start and TUI launch: what you set in
Tether, else what the session's store shows (the last real answer's `model` and `effort`), else
`CLAUDE_UNSET` (Opus, medium: `shared/transcript.ts`, the only place they're spelled out). Claude's
settings files are defaults, not a session's settings, and count for neither; the permission mode is
not part of this. A filled-in value isn't saved as a choice, so it never outranks the store later.
What Claude Code does with it is its own: a model it can't use fails through its usual error, with
nothing substituted, and a model without effort runs without any (it reports that, and the chip goes).
A model or effort picked in the TUI goes on with the session once an answer shows it. Codex keeps its
own settings and its own "Default".

## 6a. Subagents: precise turns and steering

You can open any subagent and see its exact turns (every message, thought, tool call and result, in
order), live while it runs and afterwards. The parent's tool card links to it, and the session shows
its subagents as children in the sidebar and in the session header.

**In the sidebar**: under the open session's row, one toggle row "▸ 2 subagents · 3 started" (each
kind counted; a dot and "· k running" if any run), closed by default. Open, it shows a few rows (running first, the open one
always) and "N more" for the rest (a searchable list). Open or closed is kept per device
(`tether.subagentsOpen`); when the open session is one of the rows, the section shows open so its
row is in view, until toggled.

**Sessions an agent started** (`tether_start`, §9a) count as its children too, beside its
subagents, but they're ordinary sessions: no `parentSessionId`, in the lists as well, full header
controls. The peers module's read-only op `spawnedFamily {sessionId} → {parent?: {id, title},
children}` (from `children.json`; released children too, never archived ones or ones in a hidden
folder; one that went on under a new id is its successor; at most 8 opened at once; runners say
`RunnerInfo.spawnedFamily`) is asked for the open session only, one answer shared by the sidebar
and header, again when the session's or its family's status or archived mark changes or a main
session appears. A Move or source change (the core's `continued` event) re-keys who started whom,
as child and as starter, so reports and the links follow the new id. A side chat's starts are its
session's. Their rows read "<harness glyph>
started by agent". The header: "← Started by “<title>”" on one, and a **Started** chip on its
starter listing them (harness, status).

| | Claude Code | Codex |
|---|---|---|
| Live turns | SDK frames with `parent_tool_use_id` / `agent_id`; set `forwardSubagentText: true` so text and thinking come through, not only tool calls | each subagent is its own thread (`parentThreadId`); its `item/*` events stream like any thread |
| Past transcript | `~/.claude/projects/<dir>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json`), or SDK `getSubagentMessages`. Thinking isn't saved there, so past thinking is empty | its rollout file, or `thread/read` / `thread/items/list` on the child thread id |
| Stop | `stopTask(taskId)` | `turn/interrupt` on the child thread |
| Steer | via the main agent's `SendMessage` tool (see below) | via the main agent's `send_message` tool (see below): Codex refuses input on a subagent's thread |

**Antigravity's subagents** (checked on agy 1.5.13): `invoke_subagent` makes a conversation of its
own (its own store, never listed), run inside the main agent's `agy acp` process, which therefore
stays up while one runs (`Driver.busy`). ACP gives the call no id, so the driver finds its
conversation in the store: its first step is the main agent's message, "[Message] … sender=<main
id> … content=<prompt>", the one readable line Tether reads from that undocumented blob
(`antigravity/subagents.ts`), matched to the call by its prompt. Then the driver **loads it into the
same process** (`session/load` with the subagent's id): only a process that has a subagent loaded
gets its updates and its permission requests. A request it was already waiting on arrives with the
load, and answering it lets it go on. So its turns stream into its child session as they happen, and
its requests ask in its session (and its parent's) like any other. Its own subagents are found the
same way. It reports with `send_message` to whoever started it, and is over 5 s after that with
nothing new and nothing asked. With nothing new and nothing asked for 10 minutes it counts as ended
too. **Stop** on it is `session/cancel` with its id, which kills a command it runs. If a load fails,
its store is replayed when it changes instead, and its requests can't be answered. Steering is
`via-parent`: the main agent's `send_message` with the subagent's id as `Recipient`. Stored
subagents come from the same store scan, titled by their `Role`.

**Steering Claude subagents** (decided): the SDK can't address a message to a subagent (tested
2026-10-29: `parent_tool_use_id`, `agent_id` and `priority` on a pushed user message all go to the main
thread). Instead the subagent's message box steers the main agent with a tight instruction to call
Claude's own `SendMessage` tool to the subagent's agent id with exactly your text. The message shows in
the subagent's view marked "Sent via the main agent", delivered once the `SendMessage` call is seen,
or "Not delivered" if the main agent's turn ends without it. This is an implementation detail behind
`steer: "via-parent"`, so it can be swapped for a native path if the SDK ever adds one.

**Steering Codex subagents** (decided, tested 2026-10-31 on daemon 0.166): `turn/steer`, `turn/start`
and `thread/inject_items` on a child thread all fail with "direct app-server input is not allowed for
multi-agent v2 sub-agents". Steering the parent works: it ends the parent's wait, it calls
`send_message`, and the subagent follows. So `steer: "via-parent"` too, with the same marks in the
subagent's view. Delivery is the daemon's `subAgentActivity` item of kind `interacted` for that
subagent; the text is encrypted, so it can't be compared. For the same reason a reason given when
denying a subagent's request can't reach it: its card offers no reason.

**Moving a Claude subagent to the background** (decided, tested 2026-10-31 on Claude Code 2.1.314): a
foreground subagent blocks the main agent, so a message waits for it. `Query.backgroundTasks(toolUseId)`
is Ctrl+B for that one call: the call returns "running in the background", the main agent goes on, and
the subagent keeps running, its running Bash included. The **Background** link on its card shows while
the call is unanswered and the subagent runs. Foreground needs the model to pass
`run_in_background: false`: since 2.1.314 Claude Code otherwise starts subagents in the background, and
its TUI always does. Nested ones work the same, from their parent's transcript. Requests are unchanged:
one open during the move stays open, and a background subagent's later ones ask as usual.

The session stays running until background work ends (`session_state_changed`), so Tether tracks the
main agent apart from it (`Driver.onlyBackground`): the main agent is free from a successful `result`
until its next turn. Meanwhile the queue goes on and a message goes straight in (§9). Tether declares
`perTaskStopAffordance`, so Stop stops the main agent's reply and spares background work, as Esc does
in the TUI. With only background work left, Stop stops that, since an interrupt there does nothing. A
handoff still ends it (§8): the process closes.

**Waiting on background subagents** (both harnesses): with the main agent free and subagents running,
the session still reads as working on its page, in the sidebar and on Home, and the transcript's last
line says "Waiting for 2 background subagents…" where "Claude is working…" goes, while the main agent
works it says that as usual. The count (`LiveState.backgroundSubagents`, on the row too) is the session's
children with `childRunning`, recounted when one starts or ends and when the main agent's state changes.
It is never saved, so a restart can't leave it behind. The composer stays a normal message box. On
Codex the main turn does end meanwhile, so its turn-finished push still comes then, as it always has;
its Finished mark waits on the row and on Home until the subagents are done.

Codex has no such step: its parent waits in a `wait` tool that a steer ends, and subagents already run
beside it. So `background` is Claude's alone.

Adapter capabilities: `subagents: { view: boolean; stop: boolean; steer: "direct" | "via-parent" | false; background?: boolean }`.
Viewing comes in P1 (Claude) and P4 (Codex). Steering and stopping come with each adapter.

## 7. Requests: approvals and questions

One **request broker** per runner. Every permission prompt and question from any driver becomes a
`Request { id, sessionId, kind: "approval" | "question", tool?, input?, question?, options?, openedAt }`.

```
driver ─► broker.decide(request) ─► [policy steps] ─► person (any device) ─► answer ─► driver
```

- **Policy steps** form an ordered list of functions `(request) => allow | deny(reason) | undecided`. The core
  ships with **none**: every request goes to a person. The Tether judge, rules, "Always allow", and
  timed full access come back later as policy steps. They plug in here and need no changes to
  adapters or the UI. Design the step type now so it can carry a reason and a source (`"judge"`,
  `"rule"`) for display.
- **Answers** are idempotent by request id. The first answer wins, and a later one gets
  `"Already answered"`. Open requests are saved in runner.json and survive a runner restart (the
  driver is resumed and the harness asks again, so the broker matches by tool and input).
- **UI:** open requests sit just above the composer and never scroll away. Approve, Deny, and
  "Deny with reason". Questions show their options as buttons and also allow free text.
- **Permission modes** are each harness's own, picked from a menu per session with human labels.
- **Plans** (Claude's `ExitPlanMode`, Codex's plan item, the file Antigravity writes in plan mode for review: a `write_file` with `ArtifactMetadata.RequestFeedback`, read at the turn's end) open as a document (`PlanReview.tsx`).
  Select text or click a paragraph to comment; comments sit beside their text (a sheet on phones)
  and stay in the browser until sent. **Send feedback** sends one block per comment in plan order,
  the quote as a `>` blockquote then the comment, then a general comment (`shared/plan.ts`): Claude
  gets it as the denial's reason and keeps planning; Codex and Antigravity get it as a message, still in plan mode.
  **Approve** goes back to the mode the session had before Plan (`SessionPrefs.beforePlan`, else
  the harness's own choice), and any comments follow as notes: steered into Claude's turn, or after
  "Implement the plan." for Codex and Antigravity. A plan whose harness isn't waiting in a turn (`planFollowUp`) is
  answered by the runner and passed by when another turn starts.

## 8. Terminal mode

### What the button does

The ❯_ **Terminal** button opens a project shell beside the chat (below). The panel's entry named
after the agent, **Claude Code**, **Codex** or **Antigravity**, opens the harness's real TUI, mirrored in the browser
(xterm.js), resumed on the same session. While a handoff TUI drives, the structured view stays
visible as a **read-only live transcript** (tailed from the store) with a banner: "Driving in the
terminal".

### Shared (Codex)

The TUI joins the live thread next to Tether. Both can type, both see everything, and nothing changes
mode. Closing the terminal just detaches.

### Handoff (Claude and Antigravity: live → terminal)

Two processes can't drive the same session at once, so control moves:

1. **Turn in progress, or messages queued:** ask, inline, with no modal: "Stop this turn and open the
   terminal? 2 queued messages will wait until you're back." The buttons are **Stop and open terminal**
   and **Keep working**. Leave out the parts that don't apply ("Stop this turn and open the terminal?",
   or "Open the terminal? 2 queued messages will wait until you're back."). Queued messages are held,
   never discarded, each one cancellable, and the composer sends them on return. Open requests are
   cancelled (the TUI will ask again). When idle with an empty queue, the terminal opens right away.
2. The runner closes the driver (`Driver.close()`), so the harness flushes its store.
3. It starts the TUI in tmux: `tmux -L tether new-session -d -s <sessionKey> -c <projectPath> -- <argv>`.
4. The mode becomes `terminal`, the adapter's `watchHistory` feeds the read-only transcript, and the
   browser attaches (below).

**While the TUI drives, Tether doesn't follow its turns.** The session shows one state, "Driving in
the terminal": no Working or idle, no turn pushes, no "back when it's done". Tracking the TUI's
turns from hooks, its store and its screen proved unreliable (an Esc before any output, Claude's own
input queue, a subagent's hooks, /compact), so Tether doesn't try. What it keeps:
- **Needs you**, best-effort and add-only: set by the TUI's hooks (`PermissionRequest` the moment a
  permission prompt or a question shows, `Elicitation`, `Notification`). The session's state and
  Tether's own UI say what Claude waits for ("Claude needs your permission to use Write", "Claude is
  asking you something."). The push doesn't: it has a fixed phrase ("Claude needs you in the
  terminal."), never what Claude waits for, because lock screens show notifications. It clears only on evidence (the TUI's screen shows its prompt again, no dialog, for a few
  seconds) or when the TUI is left; a hook never clears it.
- **Settings as last seen**: the mode the TUI's status line last showed or its hooks last reported
  (Shift+Tab alone fires no hook); the model and effort chips are disabled ("Set in the terminal
  (last seen: …)"). When the TUI goes, Back to Tether or by itself, the session is never left looser
  than it last showed: the status line and the store's entry from that TUI, the tighter if they
  differ, and at most `default` if neither says. A TUI gone while no runner was there is settled at the
  next start from a mark in runner.json (it ran, and its store's entries then): never looser than
  the store's newest entry, and at most `default` with no entry from that TUI (`plan` stays `plan`).
- **Messages wait**: the composer never types into the TUI; what you send goes to Tether's queue,
  held "terminal", and is sent after Back to Tether.

**Back to Tether (terminal → live).** A "Back to Tether" button always asks first: "Close Claude Code
in the terminal? If it's still working, that turn stops and anything in its own input queue is
lost." Then:
1. It quits the TUI cleanly: `/exit` when it sits at an empty prompt (Tether hides the command and its
   goodbye in the transcript), else Esc and Ctrl-C; it kills the tmux session after 5 seconds.
2. It resumes the driver on the same `nativeId` from the store, so whatever the TUI finished shows,
   with the mode and model as last seen. Every view says "Going back to Tether…", with no buttons,
   until the mode becomes `live`; the held queue goes out.

If the TUI exits by itself (you typed `/exit`), the mode becomes `stored`.

### Project shells

The terminal panel lists the project's shells, then the agent's entry. **+ New shell** opens a plain
`$SHELL` in the project folder (`tmux -L tether` session `sh-<projectKey>-<n>`). Shells belong to the
project, not the session. They persist across closing the panel and runner restarts until you close
them (× in the list, or `exit`, which does the same: the next shell comes forward, or the panel
closes), so a dev server left running is still there next time.

### The ❯_ button: a shell first, the agent's terminal only on purpose (P5b)

The ❯_ **Terminal** button opens the panel on a **project shell** (the project's first shell, or a new
one). No menu, no question, nothing handed over: the session stays fully live in Tether, the queue
isn't held, the composer keeps messaging the agent, and no "Driving in the terminal" banner shows.

- **The panel's list** (on the left on desktop, a row under the header on a phone): the project's
  shells ("Shell 1", with what runs in it and ×), **+ New shell**, and, apart from them, an entry
  named after the agent's own terminal UI: **Claude Code** or **Codex**. Only clicking that entry
  drives the agent from its terminal: for Claude the handoff above (asked first when a turn runs or
  messages wait, the question shown in the panel), for Codex its TUI joins the live thread. The
  entry then reads **Claude Code · driving** (or **Codex · joined**), and only then does the
  transcript show the "Driving in the terminal" banner (its button: **Open Claude Code**).
  Going back to a shell never hands back: **Back to Tether** stays the only way back.
- No explanatory line: a shell needs no words, and which surface drives the agent shows on its
  entry ("Claude Code · driving", "Codex · joined"), whichever tab is in front, plus the banner.
- On a phone the panel covers the requests dock: **Chat** shows an amber dot while a request or the
  agent waits on you (a paused queue, which Home lists as Needs you, doesn't light it), and the phone doesn't count as looking at the session, so notifications reach
  it. A swipe scrolls a terminal, line for line with the finger, with a short glide; a tap
  focuses it. Keys typed during a reattach are held a few seconds and sent; a reattach that fails
  tries again, up to every 15 s.
- **Scrolled back.** Scrolling puts tmux in copy mode. What's meant for the program leaves it first
  and is delivered, never swallowed: the phone's line and key bar, and on desktop text, Enter,
  control keys and a paste, in the same write, so nothing comes between. Esc too: it leaves and is
  delivered, so it stops a Claude turn while scrolled back. Scrolling keys stay in copy mode, and
  scrolling back to the bottom leaves it without a key.
- With room the panel sits beside the transcript, and the sidebar's and the panel's inner edges
  drag to change their width (arrow keys too; a double click goes back to the default). The widths
  are kept per device; the transcript never gets narrower than 300 px, the panel 60 columns, and
  the terminal refits as it goes. Without room for that (the space now, so rotating and resizing
  count), or in a window under 500 px high, it behaves as on a phone. Touch screens have no handles.
  On a phone it is full screen, with a **Chat**
  button that tucks it behind the transcript (still attached, the shell untouched) and a pill
  ("Back to the shell", "Back to Claude Code") that brings it back in one tap. While open, ❯_
  closes the panel.
- **Copying.** On desktop, a drag selects in a terminal even while tmux takes the mouse, and letting
  go copies the selection at once and leaves it on screen (nothing shows, nothing reaches the
  terminal; a blank selection copies nothing). A plain press waits to see whether it moves: a click
  still goes to tmux, press and release, so programs inside get clicks, but no longer a plain drag
  or a right-click.
  Shift-drag (Option-drag on a Mac) selects too. With a selection, Ctrl/Cmd+C (or Ctrl+Shift+C)
  copies it and never sends ^C, and a right-click selects a word. Everywhere, **Copy text** in the panel's header shows the terminal's
  whole text, scrollback included (tmux's history, wrapped lines joined, the newest 2 MB), in a sheet
  where it selects natively (a long press on a phone) with **Copy all** (`terminalText`, answered
  only to the browser that owns the attach). Shells and the agent's TUI alike. The sheet names its
  terminal and closes when another tab comes to the front (or on Esc); "older lines left out" shows
  once tmux's history (20,000 rows) is full. Without clipboard access a copy falls back to the
  browser's copy command, and a selection stays until it is surely copied.
- Closing the last shell closes the panel (unless Claude Code is driving: then it comes to the
  front). On a phone the shells scroll in their row and the agent's entry stays wholly in view at its
  end; there its state is a dot (amber driving, green joined).

The tmux server is separate from the runner, so **terminal sessions survive a runner restart**.
On startup the runner lists `tmux -L tether ls` and readopts the ones it knows.

### Streaming

- Each attached browser gets its own PTY running `tmux -L tether attach -t <sessionKey>`, opened
  by the runner. Use Bun's PTY support (`Bun.spawn` with a terminal; verify in P0) or `node-pty`.
- Output goes runner → server → **that browser only** as `{ t: "term", attachId, data }` (base64
  chunks). Input and resize go back as `terminalInput` / `terminalResize`. The relay forwards these
  by `attachId` and never broadcasts or stores them.
- **Sizing:** the tether tmux server is set to `window-size latest`, so the device you're typing on
  sets the size. Switching devices reflows. Phone and desktop are treated equally.
- **Phone:** a key bar above the keyboard, two rows so every key is in reach (Esc, Tab, ⇧Tab, ↑, ↓,
  ←, →, Ctrl-C, Ctrl-D, Ctrl-B, Enter) and a line under
  it that types its text into the terminal in front, then Enter, as a keyboard would. Tether's
  composer never types into a handoff TUI (its messages wait for Back to Tether).

### Requests and notifications in terminal mode

- **Codex (shared):** Tether stays attached to the thread, so requests, status and notifications work
  as in live mode.
- **Claude (handoff):** approvals are answered **in the terminal**, by the TUI itself. To keep
  "Needs you", its push and Home working, the runner launches the TUI with `--settings` adding hooks
  that report to the runner's local socket (`PermissionRequest`, `Elicitation` and `Notification` for
  Needs you, `SessionStart` to follow /clear and /resume; those and `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Stop`, `StopFailure` and `SessionEnd` carry the mode as last seen). A runner restart readopts the TUI as "Driving in the terminal";
  a question visible on its screen is Needs you, nothing else is inferred.

Later, a Claude `PreToolUse` hook can route terminal approvals through the same broker
(and the judge). That isn't in the core.

## 9. Messaging

| State | Enter | Other |
|---|---|---|
| idle | send | |
| running (harness can steer) | steer into the running turn | menu: Queue for after this turn, Stop and send now |
| running (no steer) | queue | |
| terminal mode (handoff) | queue, held until Back to Tether | |

- The **queue** is held on the runner, in order. Any device can edit, reorder or cancel waiting
  messages. Queued messages go out one per turn. Stop keeps the queue, held, until you send.
  Background work doesn't hold it: "this turn" is the main agent's (§6a).
- A steer can't be taken back once the harness has it.
- Desktop keys: Enter send or steer, Tab queue (when the box has text), ⌘/Ctrl+Enter stop and send now,
  Alt+Enter send later, Shift+Enter newline, Esc stop (empty box). On phones Enter is a newline and buttons send.
- **Scheduled sends.** **Send later…** in the send menu (the phone's + menu; Alt+Enter) opens a picker
  above the box: in 1 hour, tonight 9 PM, tomorrow 9 AM (this morning before 5 AM), or a custom
  date/time, in the browser's time zone (presets computed when tapped), sent as an absolute time
  (`queue` with `at`, at most a year ahead, not in the past). The message waits in the queue
  (`QueuedMessage.at`, runner.json) as a **Scheduled** group, soonest first, with its time; any
  device can edit its text and time in one change (`editQueued` with `at`), send it now or cancel
  it (`scheduleQueued`: a new time, or null for now, which marks it `asap`).
  - *Apart from the queue:* holds are about the unscheduled messages, and a scheduled message neither
    holds nor releases them; one coming due goes next even while they're paused. It waits for a
    running turn or request, the terminal (Back to Tether), the quiet wait after a restart, a new
    worktree's setup (running, or failed until Send anyway, §4) and a rate limit retry. A Stop, a failed turn, a cancelled rate limit retry or a restart that cut the
    turn off without continuing it holds the scheduled messages due at that moment (`held:
    "stopped" | "failed" | "retry" | "restart"`, each shown with why); ones coming due later still
    go at their time. A message going out when its queue moves to a new session (below) comes back
    there if it fails.
  - *Billing:* it goes through the normal send path (the session's source and checks). A send that
    fails says why in the chat and keeps the message, held (`failed`), never retried by itself.
  - *Timer and restarts:* one timer serves all, armed for the next time and never longer than a
    minute, so long waits and clock jumps are safe. While messages are scheduled the runner saves
    when it was last seen running (`aliveAt`, removed once nothing is); the time from then to a
    start, or a gap of 5+ minutes between two looks while something is scheduled (a machine
    asleep), was off. Time with nothing scheduled is never counted. A message whose time passed while the runner was
    off sends on start; one the runner was off for more than 24 hours after waits for you instead
    (`held: "late"`, checked before anything can send it). Time spent waiting behind a turn or the
    terminal never makes one late. Sent 2+ minutes after its time (not Send now), a notice says
    so: "It was for 9:00 PM; sent at 9:14 PM". An entry with a scheduled message is never pruned
    from runner.json.
  - *Elsewhere:* Home lists a session with one scheduled last, as Scheduled with its time (not
    archived ones: a scheduled message firing into an archived session doesn't unarchive it, as no
    send does; it shows on Home as working). A held one is a paused queue (Needs you). A
    message for later doesn't block a source change, a move or an automatic update; a source
    change or a move takes the queue with it to the new session.
- **Shell commands** (P5b): text starting with `!` is a shell command (below).
- **Attachments** (images and files, by paste, drop, picker or camera) are in the core because phone
  screenshots are a main use. Chunks go over RPC and are stored under
  `~/.config/tether/attachments/<session>/`. They go to the harness natively where supported, and as
  paths otherwise.

### Temporary model rate limits

After the harness finishes its own retries, a terminal transient throttle can be retried by the
runner. Codex reports a rate-limit code, HTTP 429 (including a retry-exhausted wrapper), or the
known token-rate-limit message when there is no specific code. Claude reports a terminal
`rate_limit` API error with HTTP 429 and no plan rejection. Exhausted plan limits, insufficient
quota, authentication failures and interrupted turns retain their existing behavior.

Tether resends only a main turn it started, before any tool ran or message was steered into it,
with no background work, shell command or agent terminal running. The session, source, credential
revision, model, effort, permission mode and attachments stay the same. After tools or steering,
a notice explains why the message wasn't resent and asks the person to continue.

By default there are at most five additional attempts, delayed about 15, 30, 60, 120 and 120 seconds with
20% jitter. A valid provider retry time is a minimum. No new retry starts after ten minutes from
the first terminal throttle; restarting the runner preserves this deadline and attempt count.
Sessions sharing a known source, credential revision and model/deployment share a runner-local
cooldown, with a gap between dispatches. This does not coordinate different runners.

For a session using an Azure, OpenAI or Anthropic key, the Source menu's **Keep retrying when
throttled** setting opts into a six-hour deadline and up to 60 additional attempts. The backoff
starts around one minute and doubles with jitter up to ten minutes. A provider's retry time
can require a longer wait. Extended recovery keeps using the same key and displays the local
time of the next retry and a **Stop** button. Turning the setting off stops a waiting extended retry.

The chat shows the next attempt's countdown, **Retry now** and **Cancel**. Retry now skips Tether's
backoff but honors provider timing and concurrent-session cooldowns. Stop, a direct message, a
settings/source/credential change, opening the agent terminal or a native client taking over
invalidates the pending retry. Queued messages wait behind recovery and drain after success;
cancellation leaves them paused. Intermediate attempts create no failed inbox entry or push;
the eventual answer or final failure uses the usual notifications.

`LiveState.retry` and the session summary expose only timing, attempt count and the redacted error.
The runner saves the original message, attachments, settings fingerprint and dispatch phase in
its private `runner.json`. A waiting retry is restored after reconciling the session and terminals.
For a nonpersistent harness, the saved store revision must still match; changed or unknown
history requires the person to continue.
A retry saved as already dispatching is never replayed after a restart: it may have reached the
harness, so the conversation is left for the person to continue. The private API gateway retains
only validated retry timing and recognized error categories; provider error text stays private.

### Commands and skills

"/" at the start of the box opens a menu of the session's real commands and skills: name, what it
takes, a short description. Typing filters it. Arrows move, Enter or Tab picks, Esc closes, a tap
picks. A command that takes arguments goes in the box with the cursor after it; Enter on one that
takes nothing, or typed in full, sends it. A `!` command isn't affected. The box never refuses
text: "/tmp/x" or a word that matches nothing goes to the harness as typed.

The list comes from the harness (`listCommands`, `capabilities.commands`; an older runner has no
menu). Nothing is hardcoded but what the harness can't report, marked as such in its adapter
(`commands.ts`). A live session asks its process each time the menu opens; a session with no
process is answered for its folder (Claude: a throwaway process with no prompt, kept a minute).

What a typed command does (Claude Code 2.1.316, Codex 0.164; checked on real runs):

| | Claude Code | Codex |
|---|---|---|
| List | `supportedCommands()`; `reloadSkills()` between turns sees new files and says which are skills; the init message's `terminal_slash_commands` are hidden | `skills/list` for the folder, the enabled ones; `/compact` `/goal` `/review` are Tether's list, as the app-server reports no commands |
| How it goes | as a message: Claude Code recognizes it | a "/word" in a turn is only text to the model, so each is its own call |
| `/compact` | runs | `thread/compact/start` |
| `/context`, `/usage` | output in the chat as a notice | terminal only |
| `/goal <condition>` | runs: a session-scoped Stop hook re-evaluates after each turn | `thread/goal/set`, which starts a turn itself; `/goal`, `clear`, `pause`, `resume` |
| Custom commands | user, project and plugin commands run; their text goes to the model | none: the app-server can't list or run saved prompts |
| Skills | `/name [args]` runs | `turn/start` with a `skill` input beside the typed text |
| `/review` | a skill (`/code-review` alias) | `review/start`: your changes, or the given instructions |
| Unknown "/word" | the model reads it | the model reads it |

Tether answers some itself, the same on each harness (`Adapter.commandRoute`): `/model` and
`/effort` are the header's controls (bare, they say what's set; a name that isn't offered says so),
and `/rename <title>` is the session's title. Commands that change the account or global config,
and TUI screens, say "/name needs the terminal." in one line: Claude's `/config`, `/login`,
`/logout`, `/install`, `/plugin`, which never reach it from the chat, and whatever Claude Code
itself refuses ("isn't available in this environment", worded the same), and on Codex those of the
TUI's commands the app-server has no call for. Without this Codex's would reach the model as text.

**`/goal` on Claude.** "Goal set: …" shows, and Claude works. Each time it would stop, Claude Code
evaluates the condition: not met, "Not done yet: <reason>" shows and Claude goes on. Met, "Goal
met: <reason>" shows; the stream doesn't say so, so that notice comes from the store, read after the
turn while a goal is open. After 9 refusals in a row Claude Code ends the turn itself, and the chat
says so.

**While a turn runs** a command follows the queue, whichever way it was sent (`steer` queues it):
it can't be part of a running turn.

**Freshness.** Claude Code's list is fixed at start: a command file added since shows after the
next `reloadSkills()`, which runs at most every 30 seconds and only between turns.

### Shell commands (P5b)

`!npm test` in the composer runs **right away** as a one-off `$SHELL -c` in the session's folder,
on the runner, even while the agent is mid-turn (`runShell`). It gets no stdin and has no time cap;
it runs in a process group of its own and gets the runner's environment without Tether's secrets.
At most 5 run at once per session (counted as they start, so commands sent together can't pass it).
Only the owner can run one (the same auth as sending).

- **Composer:** once the text starts with `!` the box visibly becomes a shell prompt (monospace,
  green, a "Shell" hint saying where it runs and when the agent gets the output) and Enter (or
  **Run**) runs it, whatever the agent is doing. A ❯ toggle in the composer adds or removes the
  leading `!`. On a phone the way in is **Run a shell command** in the composer's + menu; the toggle
  shows there only in shell mode, to leave it. Attachments wait for the next message.
- **The card:** a message of yours that only Tether has (kept with Tether's notices): the command,
  its output streaming in, how it ended (exit code, signal, stopped), a **Stop** button while it
  runs (SIGTERM to the whole process group, then SIGKILL to the group 2 s later whatever happened
  meanwhile, so a child that ignores SIGTERM goes too). What leaves the group escapes Stop: `setsid`,
  or a daemon that makes its own session. A job left in the background (`!npm run dev &`) runs on
  after its card ends (the card ends when the shell exits and its output pipes close, or a second
  later); it is the folder's to stop (a project shell, or `kill`). The card shows where its output is:
  **Running → Waiting in queue → Sent to <Agent>**, or **Not sent** with why (you removed it from the
  queue, the queue was full, it couldn't start, the runner restarted while it ran).
- **To the agent:** when it ends, the command and its output go to the agent as a message through
  the queue (§9): it never steers. Mid-turn it waits for the turn to end; it obeys holds (Stop, a
  handoff, a failed turn, a restart), the queue's limits (1 MB of text, 50 messages) and runner.json.
  A stopped command still sends what it printed, marked stopped. In the queue it reads
  "Output of `$ npm test`" and can't be edited (only cancelled). Where the agent got it, the
  transcript shows one quiet line, "Output of `$ npm test` sent to Claude", the message inside. Both
  harnesses behave alike (the message starts with a marker the readers recognize, like Tether's own
  messages). Titles never show a marker: a session that starts with a command's output is titled
  "$ npm test" (Claude's first prompt, Codex's thread name). Text a person types that starts with a
  marker gets a zero-width space in front, so it never passes for Tether's, and a turn that came from
  elsewhere (another session, a channel) is never read as Tether's whatever it starts with.
- **Bounds:** output is kept as its first and last bytes with the middle counted and dropped, so a
  runaway command can't exhaust memory or a frame. The card shows 16 KB + 44 KB (under the 64 KB part
  limit) and streams as appended deltas of at most 16 KB every 100 ms (once cut in the middle, the
  whole card output at most once a second); notices.json keeps 4 KB + 12 KB of a finished card; the
  agent gets 8 KB + 22 KB with a "[… 1.2 MB of output cut from the middle …]" note. Output is read
  as raw bytes, at most 16 MB a second (a runaway `yes` waits on its pipe rather than keeping the
  runner busy), and decoded only when it goes out; escape sequences split between chunks are kept
  whole, then stripped, a carriage return becomes a line break, and every other control character
  but tab and newline goes, C1 included (NULs and binary output never reach the card or the agent, so frames stay under 200 KB).
- **The hint** says when the output gets there: "when it finishes", "when this turn ends", "when
  you go Back to Tether" (the TUI drives), or "waits in the queue, paused after Stop" (the actual
  hold reason).
- **Restarts:** a graceful runner stop ends running commands (SIGTERM, then SIGKILL before it exits)
  and their cards as **Cut off · Not sent: The runner stopped while it ran**. A running card is saved
  with its process group and the leader's start time, and its output is saved every 2 s; after a
  crash the next start kills a group still alive (only when the leader's start time matches, or the
  leader is gone) and ends the card the same way, with what it had printed. Nothing stays "Running".
  Output already queued survives in runner.json and goes as usual. Command cards are kept (30 per
  session) apart from the 50 notices, and a running card (or one whose group still has to be killed) is
  never dropped. Cards are kept per session in files of their own (`shell-cards/<hash>.json` beside
  notices.json); only the files that changed are written, at most once a second (at once when a card
  settles), so a command's start is saved within a second, not synchronously. A second SIGTERM while
  the runner stops SIGKILLs the groups at once; a runner gone before its SIGKILL leaves the group on
  the card, and the next start ends it.

## 9a. Sessions talking to each other

An agent can message or ask another session on its runner, Claude Code, Codex or Antigravity, and send a note
to all, and start a new session on any harness that reports back to it (`tether_start`, below).
Nothing asks the person; loops are capped. A module
(`runner/src/modules/peers/`, off with `TETHER_PEERS=0`); the core only gained the `queueGone`
event (with the message's text) and the queued message's id from `SessionActions.queue`.

- **Reach.** `tether_sessions`, titles and broadcasts cover what the lists show (`SessionActions.list`:
  the last 3 days and every live session); an explicit id reaches an older session too (opened
  through `SessionActions.open`). Never archived sessions or subagents.

- **Tools.** Every live session gets a stdio MCP server named
  `tether` (`mcp.ts`, run with the runner's `bun`) with `tether_sessions` (id, title, folder,
  agent, idle / working / waiting, last activity; filter by project or text), `tether_send {to,
  text}` (returns at once), `tether_ask {to, text, timeout_minutes}` (waits for the answer: 15
  minutes by default, 60 at most) and `tether_broadcast {text, project?, scope?, status?}`
  (fire-and-forget, at most 20 sessions, never the sender; the sender's own project unless it
  passes `project`, or `scope: "all"` for every project), plus `tether_start`, `tether_models` and `tether_archive`
  (below). `tether_models {harness}` lists the billing sources `tether_start` can pass for that
  agent and each one's models with their efforts (Azure's: its deployments and the model each runs);
  it says Tether sets up each source's provider and key from its Settings, so an agent never edits
  its own config or sets key variables. `to` is an id or a title only one session has. The tools run without a prompt: Claude allows `mcp__tether__*`; Codex gets
  `default_tools_approval_mode = "approve"`; Antigravity asks for each MCP call, and its driver
  approves those of `mcp_tether_*` itself.
- **Transport.** The MCP server posts each call to the runner's Unix socket
  (`<config>/modules/peers/peers.sock`, private, shortened like the hooks socket when too long; an
  ask's request stays open until the answer). Identity: the server's environment carries its
  session id and a token, HMAC(secret, id), the secret kept in the module's folder so tokens
  survive restarts. A subagent's call speaks for its main session. Anything running as the user
  could still forge a call: the token keeps sessions apart, it isn't a security boundary.
- **Claude** gets the server in its `query()` options (`mcpServers`, with a per-server `timeout`
  of 65 minutes so an ask can wait). **Codex** gets it as the thread's own `config`
  (the dotted key `mcp_servers.tether`, with `tool_timeout_sec`, so the person's own
  `mcp_servers` stay) on `thread/start` and `thread/resume`. Checked on
  the daemon (0.167.1) with two threads at once: each thread runs its own MCP process with its own
  env, and a resume of an unloaded thread takes the new config; a thread another client already
  has loaded keeps what it was loaded with. As a thread's id isn't known before `thread/start`,
  Codex's servers carry `codex:*` and the runner takes the thread from the call's `_meta.threadId`
  (the daemon sets it, not the model). (`dynamicTools` on `thread/start` was the alternative; it
  can't be added to an existing thread.) **Antigravity** gets it in `session/load`'s `mcpServers`
  (with its env), and the instructions as `_meta.antigravity.systemPrompt.append`; both checked on
  agy 1.5.13.
- **Delivery.** A message goes into the target's queue (§9) and never steers: it waits for a
  running turn, obeys holds, survives restarts and can be cancelled from any device; a peer
  message can't be edited. It starts with `[From session "<title>" (<id>)] ` (`to all]` for a
  broadcast) and ends with a short hint for the agent, `\n\n[Tether: …]`, which the transcript
  hides; the hint also says the sender's permissions. The transcript shows it as "From “<title>” ·
  Open it" (· to all), the queue as "From “<title>”: …". A person's text that starts like one gets
  defang's mark.
- **Stricter to looser is refused.** Each session's permission mode has a level on the scale
  Move uses (`core/permissionLevel.ts`, shared/move.ts `LEVELS`): Claude plan < default <
  acceptEdits < auto < bypassPermissions; Codex read-only < untrusted < auto (workspace-write) <
  full-access; Antigravity plan < default < accept-edits < bypassPermissions. A send or ask to a session whose level is above the sender's is refused: nothing is
  queued, the tool says the session doesn't have permission (both levels named), and the sender's
  transcript gets a notice. A broadcast leaves such sessions out and lists them. An unknown level
  counts as the loosest for the target and the strictest for the sender; equal or stricter goes
  through. So a session can't get done through another what it may not do itself.
- **Ask.** The answer is the target's last written reply in the turn that took the question (the
  next turn end after it went out), cut at 20 KB with "open session X for the rest". Otherwise:
  "turn failed: …", "the person stopped …'s turn", "Not delivered: the person removed your question
  from …'s queue", or after the timeout "still working on it" / "hasn't got to it yet". A target in
  terminal mode gets the question queued with a hint to answer by `tether_send`, and the ask
  returns at once. A runner restart ends an open call with an error: a runner that wasn't there says
  nothing was sent; one cut off mid-call says the message may already be queued (check with
  `tether_sessions`, don't resend blindly). A queued question stays queued.
- **Caps** (`caps.ts`): no messages to itself; a message carries hops (the sender's turn's + 1,
  where a turn started by the person or Tether is 0; written in its hint, `hop N.`, so a message
  queued across a restart keeps them, and a turn's end forgets them) and the 5th in a chain is refused; 10 messages
  per sender per 10 minutes; 3 open asks; an ask to a session that waits (directly or through others)
  on the asker is refused; one broadcast per 10 minutes, and none from a turn a broadcast started.
  A message is counted (and an ask opened) right after the check, before anything waits, so calls
  side by side can't all pass; one that doesn't go is given back.
  A refusal is the tool's error and a warning notice in the sender's transcript.
- **Starting sessions** (`children.ts`). `tether_start {harness, prompt, source?, model?, effort?, title?,
  project?, worktree?}` starts an ordinary session on any harness (claude, codex, antigravity),
  from any harness, and returns at once with `"<title>" (<id>)`. Folder: the caller's; `project`
  only names a known project, and only from a caller nothing confines (judged or full), as another
  folder would widen a sandboxed one. `worktree: true` makes a new worktree through
  `newWorktreeSession` (§4), only from a caller that may run commands itself (sandboxed or looser),
  as git and the repo's setup run. `worktree: "<path or branch>"` starts in one of the folder's
  repo's existing worktrees (`existingWorktreeSession`): nothing runs, so it's just another folder,
  as `project`: unless it's the caller's own, only from a judged or full caller. The source defaults
  to the subscription when available. The agent must confirm API-key billing with the user before
  starting any session, including a replacement or fallback session. For Azure, `model` can name a
  configured deployment or its unambiguous model. The start reply names the deployment.
  Mode: the loosest mode the target offers whose level is at or under the caller's
  (Claude's auto counts as judged), so a child is never looser. The prompt goes in as a peer
  message from the caller (carrying its hops) whose hint says its final reply goes back. Who
  started whom is kept in `<config>/modules/peers/children.json`.
  Each time the child really finishes a turn (nothing queued, no background work, no open request;
  not a rate-limit retry; not a turn whose answer went to an ask), its last reply (cut at 20 KB) is
  queued into the caller as a message from the child, with "Report N of 20" and to follow up with
  `tether_send`. A turn another session's message started isn't reported (that would let a
  stricter session reach a looser caller through the child). A request it (or its subagent) waits
  on, still open after 0.8 s, or a terminal prompt, is passed on once a turn and counts as a
  report. Reports carry the hops the start carried, so they neither grow nor reset the caller's
  chain. It stops reporting when the person types into it, runs a `!` command, texts it or presses
  Stop, after 20 reports, or when the caller is archived; the child itself goes on as a normal
  session either way. Caps: at most 5 children still at work per caller (one idle after its turn
  doesn't count; starts side by side reserve their slot at once); a child may start children, a
  grandchild can't; starts count toward the 10-per-10-minutes rate and the hop cap. A start that
  fails gives the rate slot back; one whose prompt couldn't be sent names the idle session it
  made. Children show under their starter in the sidebar and header (§6a), taken over or not.
  The tool's description, its answer, each report's footer and Tether's instructions tell the
  starter to archive a child once done with it.
- **Archiving children.** The person's sidebar keeps the sessions they started, and agent-started
  ones while those work. When unsure, a child isn't archived. `tether_archive {to}` (its id,
  followed to its successor if it moved, or the exact title, any case, of only one of the caller's
  children) archives a child of the caller's (a side chat's: its session's) through the core's
  archive, marks it released (`done`: no more reports), archives its children that may go as a
  cascade (below), and answers with what the worktree cleanup decided (the worktrees module's
  `worktreeCleaned` event: removed, or kept and why; waited for 30 s at most). Refused for anything
  the caller didn't start, while the child has work going (the worktree cleanup's busy checks: a
  turn or request, a rate-limit retry, its setup, any queued message, scheduled or held, background
  work: "wait for its report, or tether_send it to stop"), once the person took it over, and when
  it's pinned. The person takes a child over (released `person`, for good) when they type into it,
  run a `!` command, text it, press Stop, take it to its terminal, or unarchive it (Unarchive, or a
  message they send it); whatever it was released for before.
  **Cascade:** a child whose starter is archived (by the person: the core's `archived` event; done
  with it: `tether_archive`; at its next report, for one that worked then; and the peers sweep,
  a minute after start and hourly, for what a restart missed) is archived and marked `cascade`
  only if it may go: not the person's, not pinned, not in its terminal, no work going, and its own
  worktree Tether made holds nothing archiving would leave behind (uncommitted changes, commits not
  in main, ignored files that aren't regenerable: `worktreeKeeps`; a failed check keeps it). One
  that may not go stays, released `gone`. When the person unarchives a starter, the children its
  archive took along come back (and theirs), released as they were before. A report rechecks the
  child after its waits, so one taken over meanwhile isn't reported.
- Tool cards read "Asked “<title>”" ("Ask failed" once asked, "Not asked" when it never went),
  "Sent to “<title>”", "Sent to all", "Started “<title>”", "Archived “<title>”" ("Didn't archive"), with the message, an Open link and the answer. The link goes
  to the session the runner reached: its answer names it as `"<title>" (<id>)` on its first line. Terminal mode: a TUI-driven session can receive (it queues until Back
  to Tether) but has no tools.
- **Tether's instructions** (`peers/instructions.ts`): every session that gets the server gets Tether's instructions too, appended to Claude Code's
  system prompt or as a Codex thread's developer instructions (on resume as well), read at each
  process start: with **Concise replies** on (a runner setting, Settings → Agents, default on),
  "end each turn with a short reply: 1–3 sentences, outcome first, then a link; details (≤ ~5
  bullets) only for a decision or a failure; no test counts, file lists or recaps unless asked";
  always, "to text the person, use `text_person`" and "archive a session you started with
  `tether_archive` once you're done with it".
- **`text_person(message)`** on the same server texts the person through the texting module (§11
  Texting, "Agents texting the person"), only when the session's **Session can text me** box is
  ticked; otherwise it returns an error saying so (put it in the reply instead), and the rule says so.

## 10. UI

- **Sidebar:** recent sessions grouped by project (title, harness glyph, how long ago, status dot,
  under the project's folder name, which opens that project's list; groups ordered by their newest
  session; same-named folders show parent folders until they differ; paging counts sessions, and older
  sessions from "Show more" join their groups), with projects below; pinned sessions flat above it. A
  session in a worktree (`worktreeOf`, §4) is grouped, listed and counted under the repo's main
  checkout, not its worktree folder, and its row shows "⑂ <branch>" (the worktree folder's name from a
  runner that doesn't send `worktreeBranch`); Projects folds a worktree folder a session is known to be
  in (any the browser knows, whatever the search) into its main checkout; `listSessions` for a main
  checkout also lists the sessions in each worktree runner.json records with it as `repo`, of any age.
  Search results and a project's list stay flat. New session (pick a project,
  harness, model). Archive and pin (Archiving, Pinning below).
- **Session view:** the transcript (markdown, thinking folded, tool cards rendered by `kind` with
  diffs and shell output), the requests dock, the queue, the composer, and a header with model, effort,
  permission mode, the context chip ("Context 42%", tooltip "84k of 200k context"), the usage chip (what it
  draws from, and on a plan its 5-hour window when known, "ChatGPT plan · 5h 10%"; its weekly window,
  "Claude plan · Week 63%", when there's no 5-hour figure or the week is at 100% or reported exhausted
  (a Claude `rate_limit_event` rejected on `seven_day`); tooltip the windows and
  their resets) and, pinned at the right outside the chips, the **Changes** and **Terminal** buttons.
  The context and usage chips come last in the row, so on a phone they are what scrolls out of view. Always follow the bottom unless you scroll up.
- **Terminal panel:** full screen on phones, beside or instead of the transcript on desktop.
- **Changes pane:** the session folder's git diff, in the terminal panel's place (Changes below).
- **Home** (P5): one ranked inbox: requests, then finished-unread, then working. An archived session
  stays while it needs you or is working.
- **Responsive:** one layout that works at 375 px. Every action reachable by touch.

### Credentials and billing safety

Billing settings belong to a runner. **Credentials** (`#/settings/credentials`) shows the selected
runner's Claude Code, Codex and Antigravity sign-in states, plus its keys: **Anthropic API key** for
Claude and **OpenAI API key** for Codex. Owners can sign in, sign in again and sign out. Claude Code
and Antigravity open the harness's authorization link in a browser tab and accept the returned code in
Tether. Codex shows a device code for its authorization page. Each flow expires and can be cancelled.
The relay sends the challenge only to the requesting browser. The harness keeps its credentials in the
selected runner's existing CLI profile. An auth failure in a session offers its owner a link back to
that runner's Credentials, in the transcript and Home inbox.

**Azure** (`#/settings/azure`, below) holds Azure's key, its resource and its deployments for Codex. **Bedrock**
(`#/settings/bedrock`) holds the AWS region, credentials and model lists for Claude and Codex. Setting, replacing or
unsetting a key touches no other slot and changes no session's source. Automatic source changes use the session's opt-in **Fallback chain**.

**Each session has one billing source**, chosen when it's made and saved with it (`SessionPrefs.source`,
which is a source's name, never a key). New session and the Move dialog show **Source**, listing what
really exists for that harness: a subscription when the harness reports a login (Codex's `account/read`
on the shared daemon, Claude's read-only `auth status`), a key when it's set (Azure: its key, its
resource and at least one deployment), or Bedrock when a credential and a model are configured for the harness. With one source it's shown without a
picker; a key in the picker has the API colour. It always starts on the subscription when there's
a login, and on the first key only when there isn't. `newSession` or `moveSession` with no source (an older web) is the subscription,
never a key by surprise.

The source is used on every start, resume, restart and TUI launch of that session, whatever keys are
set later. A session with nothing saved uses what its harness has on record, which is then saved: a
Codex thread's private app-server, a Claude session's last confirmed label. No record is the
subscription: a Codex thread with none belongs to the shared daemon. Subagents use their main session's
source; a TUI's `/clear` carries it on. A session whose key is unset fails with a chat error naming the
source and nothing is sent; there's no fallback. A key replaced in the same slot carries on with
the new key.

An existing session's source changes in two ways. **Move** (§15) accepts the same harness with another
source: a new session with the context, the old one intact. And the **billing chip** in the header, in
its quiet and loud forms alike, is a button with a chevron that opens a menu of the harness's sources
with the session's own marked. Picking another applies from the next message, on Claude and Codex
alike: until the harness confirms it, the label stays what's confirmed and a chip beside it says what's
next (`LiveState.nextBilling`). Picking the session's own again calls it off. A TUI or a running turn
refuses it: the items are disabled with the reason as their description, and the op refuses too. When
one of the harness's keys isn't set, the menu has **Add API key…**, which opens Credentials. A session
on a key that was unset still shows that source, marked. A subagent's chip and a chip on a runner with
no `billingSources` answer are plain text. There is one way in: of the ⋯ menu's items, only Change session harness touches the source.

The menu opens with the **plan's usage**, whether the session is on the plan or a key, so you see it
before switching: under the plan's name, each window the harness reported, "Week 64% · resets Nov 5,
6:00 PM", "5 hours 12% · resets 3:10 PM". Unknown is no line. A figure over an hour old says so
("· 3h ago"). Opening the menu asks for a refresh (`refreshPlan`): Codex reads
`account/rateLimits/read`, at most once a minute; Claude has only its latest report. The chip itself
keeps its rule: plan % only on a plan session.

**Fallback chain.** The header pill opens the editor. The session starts off, and the runner
saves its switch, ordered steps and progress across restarts. Each step selects a harness, login
or key, model, effort and permission mode. The default permission mode maps the session's current
mode to the target harness. A hop checks that its permission mode is at or below the session's
current level. Runner presets can be loaded, saved, renamed or deleted. The editor starts a new
chain with the runner's most recently saved order and shows why saved steps are unavailable.

A plan-exhausted signal or exhausted rate-limit recovery advances to the next usable step. Same-harness switches use the same source checks as the billing chip. For a different
harness, Tether waits for background work to finish, then uses the Move module’s native or private
history-file route. The old transcript links to the new session and open views follow. The
destination gets the selected model, effort and permission mode, and receives “Continue the task
where it stopped” with the last user message quoted. The notice includes the reset when available.
The runner
records the exhausted step and its reset time, or backs off for ten minutes if no reset was
reported. It prefers an available higher-priority step at the next turn boundary. If it previously
left that step's thread, it tries to resume that thread and points it to a private archive of the
work since the handoff. If the thread is unavailable, the source switch can carry the conversation
into a fresh thread. When the order is exhausted, the transcript lists the steps and their known
reset or retry times. With **Continue when a limit resets** enabled, the runner persists a wakeup
for one minute after the earliest retry time and sends “continue” when it can take that step.
Stop and a new message cancel the pending wakeup. Push reports exhaustion and resumption without
announcing intermediate fallback hops; a hop that stops and waits for a message reports the turn's
failure as usual. The turn's end is reported once, exhaustion included.

| Harness | Exhausted | Not exhausted, whatever it says |
|---|---|---|
| Claude | A failed turn with a `rate_limit_event` of status `rejected` that nothing later cleared; or the assistant frame's `error: "rate_limit"` with Claude Code's own text ("You've hit your session limit · resets 8:40am (UTC)"); or, with no error code at all, that text as an error `result` | `rate_limit` with other text (a short 429: "Server is temporarily limiting requests (not your usage limit)", which has no rejection); any other `error` code (`overloaded`, `server_error`, `authentication_failed`…); `api_error_status` other than 429; a stopped turn; a finished one |
| Codex | A `failed` turn whose `error.codexErrorInfo` is `usageLimitExceeded`; or, with no code at all, a message starting "You've hit your usage limit" | Any other code (`rateLimitExceeded`, `serverOverloaded`, `internalServerError`, `unauthorized`, `responseStreamDisconnected`, `responseTooManyFailedAttempts`, `other`…) whatever its text; a retry; a subagent's turn |

Codes come first: text decides only with no code, except that Claude's `rate_limit` code needs its
text, since a short 429 has the same code. The reset is the signal's `resetsAt`, else that of the
fullest window a fresh read shows at 100%.

The original message is replayed after a switch if Tether sent it and the turn did not run a tool
or take a steer. The chat asks for a new message when replay would be unsafe. A terminal or ongoing
background work blocks switching.

On Claude (`capabilities.sourceSwitch`) the next message's process start takes the new source.
Settings → Accounts can sign in to additional Claude subscriptions. The primary login stays in
Claude's usual config directory. Each extra login uses a private `CLAUDE_CONFIG_DIR` on that runner,
with links to the primary directory's projects, history and user configuration. Claude owns and
refreshes the login in each directory. Removing an extra account deletes its directory without
calling Claude logout. Sessions bound to the removed source need a new source before they can send.

The new-session picker defaults to the last selected Claude subscription when available. The source
chip can switch accounts in place, and the SDK and tmux terminal run under the selected account.
Claude must confirm the subscription, email and organization before sending. Account names and
identity details are owner-only, and extra account rate-limit reports stay with their source.

A **Codex** thread can't cross app-servers (`capabilities.sourceCarry`), so a new thread takes the
session's place, and nothing shows it. This is deliberate, tested on 0.164 and 0.166: a rollout copied
into a private `CODEX_HOME` does resume under the same id, but 0.166 refuses a thread recorded on another
provider unless every provider id in the copy is rewritten, and coming back can't work. The shared
daemon has no way to unload a thread, so it answers from its memory, without the turns in between, and
writes on over them; it would also take writing into `~/.codex`.

At the next message (`LiveControl.carry`, on `Mover.carry`) the history is exported and imported as
in §15 into a new thread on that source, with the same model, effort and mode, and the harness confirms
the source. That message goes to it, unlisted (`SessionPrefs.carrying`), while the old thread stays
as it was. When the harness answers (or after 30 s without a refusal: slow isn't failed), the new thread
takes the session's place: the title and notices carry over, the old id gets `movedTo` and `carried`,
views follow with `location.replace`, old links too, and the old thread stays on disk, out of the lists
for good, after a restart and when opened by id. The API badge shows from that first message. The
transcript shown is the old thread's own followed by the new one's (`carriedFrom`), not the import.

Any failure, from the import to a refused key on that first message, leaves the old thread, its source
and label as they were, the message in the box, and an error in the chat. The new thread is archived
and its private process stopped. There's no fallback, and the change stays waiting, so the next message
doesn't go somewhere else by surprise: pick the source it's on to call it off.

A history too big for the window uses §15's budget and history file, with its notice only when
context was cut. The file route isn't used here: it's a turn nobody asked for. Only plain messages
cross. Tool calls are carried as text, the model's encrypted reasoning isn't, and neither is the summary
of a Codex compaction: it's encrypted for its account, so a new source couldn't read it. The turns
themselves are carried instead, as far as they fit. Subagents of the old thread stay viewable from
the transcript, and aren't listed under the new one.

`credentials.json` is version 3, with one slot per key and separate settings for Azure and Bedrock.
Settings survive when a key is unset. A version 2 file
(Azure's endpoint, one optional deployment and its rates in the key's slot) and a version 1 file (one
`codex` slot) still read, their revisions kept: the one deployment becomes a list of one with its rates,
and rates with no deployment are dropped (they priced whatever model was picked). A deployment saved
before types is Global; its rates, if it had any, become its Override with the same numbers. The file is rewritten
by the next change. A runner from before version 3 can't read it, and disables sending. A web deployed
ahead of its runner gets no `billingSources` answer and hides the picker.

Keys are written only to `credentials.json`, mode 600, under the runner's data directory
(`TETHER_DATA_DIR`, otherwise its existing config/data directory). The runner sends browsers only
set/unset status and optional last four characters, plus non-secret Azure and Bedrock configuration. The
browser clears the password field when submitting. Keys never belong in session prefs, summaries,
transcripts, notifications, logs or argv. Subprocesses receive them by private file or environment.
The relay forwards credential RPCs without recording their arguments. Error paths redact submitted
and retired keys; terminal output is redacted before it is encoded for transport. The runner's own
token (`TETHER_TOKEN`) is registered as a secret too, so no op answer or terminal output carries it.

A change to a session's key or source applies at the next process start. A running turn finishes
using its original source and label. Before an idle live session's next send, Tether closes the old
process and starts with a new snapshot of the session's own source. A change racing startup refuses
the send. The harness must confirm the session's source before any message is sent: unknown or
mismatched billing refuses, rather than being treated as a subscription. Invalid credentials,
exhausted quota and network failures stop on that source, unless you ticked the switch above and
it's the plan that ran out. Removing a key removes its environment from
future processes. A subscription session carries no key: its process never sees one, and a Claude
terminal launch doesn't read the file's key. A key session never uses the login: Claude's goes through
its private helper, and each Codex key thread has a private app-server and `CODEX_HOME` with no login.
A Codex thread whose record disagrees with its session's source stops, naming both; no conversion occurs.

The session label changes only after harness confirmation. API billing has one accessible colour
token in light and dark themes: a loud source badge first in the session's chip row, visible at
phone width without sideways scrolling and matching title text on Home rows. Session rows in the
sidebar use plain white text with no payment-source differentiator. The composer keeps its regular styling. Subscription sessions remain quiet. Unknown billing is plainly neutral. Plan usage appears
early in the chip row on phones and never appears on an API session's chip. Terminal mode must use the same
confirmed source, or refuse to open. No terminal launch may edit the user's harness configuration.
Codex's remote TUI joins the thread's confirmed permissions and approval reviewer; its launch
passes no CLI permission overrides, which remote resume rejects.

### Azure

The Azure page has Azure's **API key** (write-only, as any key), the **Resource** and the
**Deployments**, saved together. Codex's Azure provider uses the v1 API: base URL
`https://<resource>.openai.azure.com/openai/v1`, `api-key` header, `wire_api = "responses"`, no
`api-version` (the owner's own `[model_providers.azure]` has that shape). A resource name is made into
that URL and the page shows it under the field. A full HTTPS URL is taken instead (a Foundry resource's
`https://<name>.services.ai.azure.com`), with `/openai/v1` added when it has no path. Each deployment
row has its name (what requests send as `model`), the model it runs (free text, suggested from Codex's
model list), its **Type** (Global, the default, as the owner's deployments are all Global Standard; Data
Zone; Regional) and its rates. Names are unique, at most 50 rows.

**Rates come from a dated table** (`shared/azureRates.ts`): Azure OpenAI's Standard (on-demand) rates,
West US, USD per 1M tokens, as on the pricing page the owner pasted on 2026-11-01, for Global and Data
Zone, short and long context, with a cache-write rate where the page lists one (not for gpt-5.5 or
gpt-5.4). Nothing else is in it: no Regional, Priority, Flex, Batch or Provisioned, no other region or
model. A row whose model and type are in the table shows its rates read-only and greyed, the table's
source and date in a tooltip. Its model matches when it's the table's id after lowercasing; a model
field ending in Azure's dated version (`gpt-5.4-2026-03-05`) has that `-YYYY-MM-DD` removed first.
Nothing else is mapped. **Override** keeps the owner's own USD rates per 1M tokens instead: input,
cached and output, all three or none, and an optional cache write. A row the table has nothing for
(a Regional one, DeepSeek, a model not listed, no model) shows those fields directly, optional; without
them its turns are unknown, `type:regional` or `model:<id>` (`model:none` with no model). Endpoint, names and models are public
metadata and may reach argv and status; a key in any of them is refused.

**Test**, per saved row, sends one tiny request (`max_output_tokens` 16, not stored) where a session's
go: the endpoint plus `/responses`, the same `api-key` header (`adapters/codex/upstream.ts`, shared
with the private host's gateway). It costs a little real Azure usage and runs only when clicked, never
by itself. It answers in a few words: "OK · <model Azure names>", "Key rejected", "Deployment not
found", "Rate limited", "HTTP 400 · <code>", "Can't reach the endpoint". No response text or header is
shown. It's disabled with unsaved changes or no key.

There is no "Load deployments": Azure lists deployments only through the management plane (ARM,
`Microsoft.CognitiveServices/accounts/deployments`), which needs an Entra login, not the API key. The
data plane's `/openai/deployments` was retired after `2023-03-15-preview`, and v1's `/models` lists
models, not deployments.

**A session on Azure has one deployment** (`SessionPrefs.deployment`), chosen as its Model in New
session or Move, kept across restarts and used on every start: Codex is told it as the model, the
private host prices with its model, type and Override (`TETHER_GATEWAY_PRICING`, `TETHER_GATEWAY_DEPLOYMENT`), and a change
to its model, type, rates, the table's date, the endpoint or the key restarts an idle session's private process at the next send, as a
replaced key does; other deployments' changes don't. A source change onto Azure (the chip) takes the
deployment matching the session's model, else the first. A session from before deployment lists takes
its model if that's a deployment, else the first, and keeps it. A deployment removed later stops its
session with a chat error naming it, and nothing is sent; no other deployment stands in.

The header's Model menu lists the configured deployments and changes the session's deployment on the
same thread. Idle, the saved deployment and the model change together (a rejected change rolls both
back), and the next send restarts the idle private process on the same thread, priced for the new one.
While a turn runs (or is starting, or one started elsewhere runs) nothing reaches the process: it is
priced for the deployment it started on, and a change there would leave the turn's later requests
unpriced. The pick is held instead (`SessionPrefs.nextDeployment`, kept across restarts) and shown as a
"Next: <deployment>" chip beside the Model chip; the turn finishes on its deployment, and the next send
makes it the session's deployment and model, which restarts the process priced for it. Picking the
current deployment cancels it, as does a source change. A name that isn't a configured deployment is
refused before anything is held or sent. Close a shared terminal before switching.

**Other model or deployment…** is the last item of a Codex session's Model menu, on every source. It
opens a small dialog with one field, "Name", for a model id the list doesn't have (a ChatGPT or OpenAI
model) or, on Azure, a deployment name. The name is trimmed and must be at most 128 characters of
letters, digits and `. _ - : / @ + [ ]`, starting with a letter or digit; no spaces or control
characters (`modelIdProblem`, checked by the browser, which disables Apply and says why, and again by
the runner). It then goes the way a menu pick does: a name the harness refuses, or the runner refuses,
shows as an error in the chat and the model stays as it was; on Azure a name that isn't a configured
deployment is refused before anything is sent, and mid-turn it is held as above. It changes the model
only: the source, the billing labels and the plan % are unaffected.

**The model while a source change waits.** On a harness that carries a source change to a new thread
(Codex), the current thread starts on its confirmed source until the next message carries it over. While
a change is pending (`nextBilling` with `sourceCarry`) the Model menu picks for the new source: it lists
that source's models (deployments when the change goes onto Azure), shows "<model> on <source>" (or
"Model on <source>" with no pick), and `setModel` holds the pick for the new thread instead of sending
it anywhere: onto Azure as `nextDeployment` (a name that isn't a configured deployment is refused, as
the chip's own deployment pick), elsewhere as `SessionPrefs.nextModel`. Nothing reaches the source being
left (a deployment name to the shared ChatGPT daemon, or a model id to an Azure process). "Default"
clears the pick; cancelling the change, or picking another source, drops it. The carry starts the new
thread on the pick; without one it drops an Azure deployment name leaving Azure (the new source's default,
which is Codex's config: a model ChatGPT accounts don't serve is refused there, so pick one) and takes
the deployment matching the model (else the first) arriving there. On Claude a source change switches in
place, so there is nothing to wait for.

### Changes

**Changes** in the session header opens the folder's git diff where the terminal panel goes (one or
the other): beside the transcript, a full-screen sheet on a phone. Only runners whose hello says
`git: true` get the button. Scopes: **Uncommitted** (working tree and index against `HEAD`,
untracked files included), **Branch** (since the merge base with `origin/HEAD`, else `main` or
`master`, committed or not) and **Turn** (Checkpoints below). The `git` module's `gitDiff { sessionId, scope }` answers with files
(path, old path, status, added and removed lines, hunks), the branch and the base. It never writes:
git as an argv in the session's folder, a timeout, optional locks off, no lazy fetch, no external
diff or textconv, no inherited `GIT_DIR`-style or config variables; untracked files from `ls-files
--others --exclude-standard`, each diffed as `./path` against `/dev/null` with `--no-index`.
Patches come 40 files per git call; a call cut at its cap asks again file by file, so a file too big
on its own (a minified bundle) shows its counts only and nothing else is lost. Sizes are JSON bytes
(UTF-8, as frames are measured): a file over 3,000 changed lines or 512 KB of hunks shows its counts
only, files fill 3 MB of hunks in path order and the rest show counts, past 1,000 files the rest are
a count, and after 30 s the files not reached show counts (`timedOut`). Binary files say so, as do
names that aren't UTF-8, an untracked symlink (where it points), a folder outside a repo, a missing default branch and a branch with no
history in common with it. It reads the folder itself, untracked files included, so it needs drive
access: it is never a view-only op (`VIEW_OPS`), nor are `checkpoints` and `restoreCheckpoint`.

The pane loads on opening, on a scope change, on Refresh, and when a turn ends or the link comes
back; while a comment is being written those two wait until it's saved or cancelled, and "New
changes" offers them. Files start folded when a load shows over 2,000 lines, until one is folded or
unfolded by hand. A pick of lines is kept by their
numbers and text, so a reload either finds the same lines or drops the pick: a comment never lands
on other lines.

**Line comments.** Click or tap a line (or focus it and press Enter) for a comment; Shift-click or
drag the numbers (a second tap on touch, while the comment is empty) for a range within a hunk.
Comments show under their lines in the scope they were made in and collect in a tray; they're
drafts in this browser per session (`localStorage`; a write it refuses is said inline). **Send to
agent** puts them in the composer as one message, each as `` `path:line` `` (or `path:a-b`; removed
lines say "removed; lines in HEAD" or the branch's base) over its lines in a diff block. The message
can be edited before it's sent; on a phone the sheet closes to show it. The comments stay, marked
as in the message box, until a message quoting their place is sent (the runner took it). **Take
back**, editing a comment, or a box that no longer quotes it (a reload empties the box) puts it back
in the tray. Git actions (below) sit under its header; Files (below) is a tab beside Changes.

### Checkpoints

At each turn's start and end the git module's checkpoints snapshot the session's repo working tree
(tracked and untracked files, never ignored ones) into a commit under
`refs/tether/checkpoints/<session>/<n>` (the session id escaped one to one). Nothing the person uses
changes: a temporary `GIT_INDEX_FILE` seeded with a copy of the real index, its mtime kept (its stat
cache keeps it quick and racy entries stay racy; sparse entries stay), `add -A`, `write-tree`,
`commit-tree` with a fixed identity and date, `update-ref`. Untracked files over 32 MB or unreadable
are left out, and the checkpoint keeps the first 200 of them and their count; past 16 MB of
untracked names (or 2,000 left out) the snapshot takes tracked files only and says so. No hooks or
fsmonitor; clean filters the person's git config defines run as `git add` would run them (git-lfs
keeps pointers), bounded by a time limit. Outside a repo nothing is taken. A turn resumed after an
answer is the same turn, and so is a rate-limit retry (a different message sent instead starts a new
one); a turn cut off by a restart is closed by the next start. A session whose folder is now in
another repo starts a new list, and its refs in the old repo are deleted.

**The refs are ordinary refs.** `git log --all`, `gitk --all` and `git for-each-ref` show them; `git
push --mirror` (or a push of `refs/*`) sends them, and with them every snapshot's content, untracked
unignored files included (a `.env` that isn't in `.gitignore`, say). A plain `git push`, `fetch` or
clone never does. `git gc` keeps what they point at until they're pruned.

**Ordering.** `turnStarted` comes as the core marks the session running, before the message goes to
the harness; the snapshot starts then and is never awaited, so a turn doesn't wait on git. The agent
needs a model round trip before its first write, so the before snapshot normally holds none of the
turn's edits; on a very large repo its earliest writes could land in it, and a checkpoint whose before
snapshot finished over 2 s after the turn started is marked **late** in the list. A session's
snapshots run in order; snapshots in one repo run side by side, never during a restore there. Looking
at a running turn snapshots outside that order, so it never delays a turn's start.

**The Turn scope** lists the session's checkpoints, newest first, by time and the start of the
prompt (`checkpoints { sessionId }`), and diffs the one picked: before → after, or before → the
working tree while it runs (`gitDiff { scope: "turn", checkpoint }`). **Restore files to before this
turn** (`restoreCheckpoint { sessionId, checkpointId }`) has the repo to itself and holds its
folder (`holdFolder`): every main session whose folder is in the repo or holds it, stored ones and any made
there meanwhile included. What's sent to one meanwhile waits in its queue and goes on release; a
rate-limit retry due meanwhile waits too; `!` commands and opening the terminal refuse ("Restoring
files…"). Each git step of it has a 60 s limit, and paths reach git on stdin only, never as arguments
(thousands of them would pass the argv limit); files over 16 MB are streamed from git into a
temporary file beside their path (`.tether-restore-…`, which snapshots and diffs leave out and the
next restore sweeps if a crash left one) and renamed over it, never held in memory; folders emptied by
removals go afterwards, deepest first. It first takes the undo:
a snapshot of the files as they are, into which every path the restore will write or remove is
forced exactly as it is on disk, as raw bytes (no filters, no line-ending conversion), whatever its
size, ignore rules or index bits (assume-unchanged, skip-worktree), or its absence. That is saved as
a restore checkpoint, listed like a turn, so **Undo restore** (a restore to its own before, writing
those paths back as raw bytes) puts back byte for byte whatever the restore touched. Then the
working tree goes back to the turn's before: files it made are removed (empty folders with them),
ones it changed or deleted are written back. Left alone, and listed under the button: a path that
can't be read into the undo, one the target snapshot left out (or any untracked path, when it took
none or left out more than it lists), files the restored `.gitignore` ignores (tracked or not),
nested repositories and anything in them, a folder where a file goes, a path under a symlink. The
real index, `HEAD` and branches aren't touched, so commits and staged changes stay. No confirm (§2):
the undo is the safety net. Refused while the session runs, waits on you, runs a command, subagent
or background task, waits on its harness after a restart or on a rate-limit retry, is driven from
its terminal, or has messages queued (a scheduled one only once it's due, §9), and while any other live session in the same repo or in a folder
holding it (folders compared as real paths) is in any of those states but the queue; checked again once the undo is
saved, right before files change. The text under the button names the other live sessions in the
repo.

Kept 14 days and at most 200 per session (pruned as checkpoints are taken and at start). The list
(times, prompts, commit ids, what was left out) is a JSON file per session in the module's folder; the
snapshots are ordinary git objects, kept by the refs.

### Git actions

Under the Changes pane's header (runners whose hello says `gitActions: true`): the branch, its
upstream and ahead/behind as of the last fetch or push ("feature → origin/feature · 2 ahead",
"feature · not pushed", "detached at abc1234"), and **Commit**, **Push**, **Open PR**. Each is
disabled with its reason as a tooltip when it can't apply. `gitStatus { sessionId }` reads it with
each load of the pane. The default branch is origin's HEAD, else what `git ls-remote --symref origin
HEAD` says (cached 10 minutes per repo, a 10 s limit), else `main` or `master`.

**Commit** opens a box under the bar, prefilled by `gitDraft { kind: "commit" }` (what's typed
before it arrives wins; a box emptied by hand takes it again), and says what it takes and as whom:
"3 files, everything in Uncommitted, as Name <email>". `gitCommit { message, onDefault? }` runs `git
add -A` (tracked changes, staged or not, and untracked files that aren't ignored: what Uncommitted
shows), then `git commit --cleanup=whitespace --file=-` (the message as written, `#` lines kept) with
git's own identity (`user.useConfigOnly`): none configured, it says so and commits nothing. On the
default branch the box has **Commit to main anyway**, unticked; the runner refuses without it too.
Refused, in the bar and by the runner: detached `HEAD`; this session working, waiting on you, or
running anything (`!` commands, subagents, background work, a terminal); any other live session
whose folder is in the repo or holds it doing the same (real paths, as restores decide); a restore
holding the repo. It runs with the checkpoints' repo lock (no snapshot or restore beside it), checks
again once it has it, and holds the repo's sessions while it runs (`holdFolder`, "Committing…", as a
restore does): what's sent meanwhile waits in its queue, so no turn starts, or snapshots, mid-commit. The repo's hooks and signing run as git runs them; a refusal shows "The
commit failed" (or "Signing the commit failed") and the hook's output, and leaves the changes
staged. **Push** is `git push -u origin <branch>` (pre-push hooks run), never forced; on the default
branch only with **Push to main anyway** ticked (shown beside the bar there). A rejected push, a
refused sign-in or an unreachable origin is said in a line, with git's output.

**Open PR** opens a box with a title and description from `gitDraft { kind: "pr" }`, editable.
`gitOpenPr { title, body }` refuses on the default branch, detached, with no origin, or with no `gh`.
Which repo is gh's own answer in the folder (`gh repo view --json nameWithOwner,url`, cached 10
minutes), never Tether's reading of origin's URL, so ssh host aliases and the like resolve as gh
resolves them. It checks `gh auth status --hostname <that repo's host>` (cached 5 minutes) and says
"gh isn't signed in to github.com on this computer" if not; pushes first when the branch has no
upstream or is ahead; then `gh pr create --base <default> --head <branch> --title --body`, with no
`--repo`: gh picks the base repo as it does by default (a fork clone's PR goes to the parent). No
`--base` when the default isn't known: the repo's own. A PR that already exists for the branch (gh's "already exists:" and its URL on the
next line) is recorded as the session's and named.

**Generated text** is a one-shot side query on the session's own harness and source
(`Adapter.ask`), never a turn, nothing in any transcript, 45 s in all. The model sees the tracked
diff against `HEAD` (12,000 characters at most), untracked files by name only, and the last 15
subjects for style; a PR, its commits, stat and diff since the merge base. Claude: Haiku, no tools,
no MCP servers (`strictMcpConfig`, none), no setting sources (none of the person's hooks or
CLAUDE.md), a short system prompt, one turn, `persistSession: false`, and on the Anthropic key a
$0.05 budget; the source is confirmed as at a session's start before the prompt goes out, a key
through its private helper. On a key, what it cost (the result's `total_cost_usd`) goes in the
session's API ledger, one running `side-queries` report beside its turns' (§10 API session
dollars); an answer that never said leaves the total partial. Codex: only on the ChatGPT plan, an
ephemeral thread on the shared daemon (no rollout), read-only, never asking, its tools and every MCP
server off, no AGENTS.md (`project_doc_max_bytes` 0), the account's smallest model at low effort,
the subscription's path confirmed first; a turn cut off by the deadline is interrupted. A Codex key
session gets a note instead (a private app-server for one answer is too much). A missing key, an
unconfirmed source, a timeout or an empty answer leaves the box empty with a short note; committing
never waits on it.

**The session's PR.** `gitPr { sessionId, fresh? }`: the PR recorded for the session (by Open PR or
an earlier lookup; `prs.json` in the module's folder) first, by number, then, on another branch
than its PR's (not the default), that branch's own (`gh pr view owner:branch --repo <gh's repo>`), which is
recorded then. Fields: `number,url,title,state,isDraft,statusCheckRollup,headRefName`. With no
origin, or on the default branch with nothing recorded, gh isn't run. Cached per session for a
minute (`fresh`: unless under 10 s old), one call in flight shared. Records not looked at for 30
days (sessions gone or archived) are dropped, 500 at most. The header's chip shows "#42 · Open · ✓"
(✗ failing, ● running; Draft, Merged, Closed), coloured by checks while open, read out in words
("Pull request 42, open, checks failing"), linking to the PR. It's asked when the session opens,
fresh when a turn ends, and every 2 minutes while the pane is open; nothing else polls. No gh, gh
signed out, or an origin gh doesn't know is said once in the bar.

git and gh run as argvs in the session's folder, each in its own process group, with time limits
(commit 120 s, push 90 s, ls-remote 10 s, gh 20 s, `pr create` 60 s): past one the group is killed
(a hook's children, ssh, a pinentry) and pipes they still hold aren't waited on. When git exits by
itself, pipes a hook's background job still holds are read for 2 s more and then let go; the job is
left running. An `add -A` stopped at its limit has the `index.lock` it left removed; a stopped
commit's lock (its hooks' children may still use the index) is named in the error instead. git has run.ts's
hardening, and for hooks the person's own locale and fetching; talking to origin, nothing may
prompt: `credential.interactive=false`, `GCM_INTERACTIVE=never`, and ssh in batch mode unless the
person set their own ssh command (`GIT_SSH_COMMAND`, `GIT_SSH`, `core.sshCommand`). gh: no
prompts, color, pager or update check, no inherited `GH_REPO` or git location variables. One action
at a time per repo (its top folder, whichever of its folders asks). The relay waits 6 minutes for
`gitCommit`, `gitPush` and `gitOpenPr` (`LONG_OPS`), longer than the runner's limits add up to, so
the runner's answer, failure included, always arrives. All of these ops need drive access (they read
the folder and write to it and its remote): none may be view-only (`VIEW_OPS` in shared/access.ts,
on branches that have it). Out of scope: replying to review comments, GitLab and Bitbucket.

### Files

Runners whose hello says `files: true` give the Changes pane a **Changes | Files** tab row in place
of its title (kept per device; Files, once opened, stays mounted, so switching tabs keeps its place).
Files is the session folder as a tree, a folder at a time (`listDir { sessionId, path, hidden? }`:
folders first, then by name; 2,000 entries, the rest counted), a filter by name, and a viewer. The
eye toggle (per device) shows dot files and, in a repo, what git ignores (`check-ignore`), dimmed;
outside a repo heavy folders (`node_modules`, `.venv`, `dist`, …) count as ignored. `.git` is never
listed. `findFiles { sessionId, query, hidden?, fresh? }` ranks paths by name (exact, prefix,
substring, then the path, words, letters in order), 200 best: in a repo from `ls-files --cached
--others --exclude-standard` (ignored files never match; nested repos and gitlinks aren't files),
outside one a walk that follows no links and skips heavy folders (50,000 files or 3 s, then
`partial`); a folder's list is kept 5 s, and Refresh asks `fresh`. **Changes against HEAD** are marked: `fileChanges
{ sessionId }` runs `git status --porcelain=v2 -z --untracked-files=normal --find-renames -- .` in
the folder (`no` when the repo sets `status.showUntrackedFiles=no`; through its handle, run.ts's
hardening; 5,000 paths or 8 MB, then `cut`) and answers each path relative to the folder (anything
git names outside it is dropped; outside a repo `repo: false`, no marks) as modified, added (intent
to add too), untracked, renamed (its old path deleted), deleted (both-deleted conflicts too) or
conflict; a deleted path that's there untracked is untracked. An untracked folder is one path
(`folders` says which are folders: those, nested repos, submodules), and everything under it shows
untracked (but what git ignores). Like git status, it may run the repo's configured clean filters. Asked on opening the tab,
Refresh and a turn's end (the eye only filters what's there), joined against the rows: a file's name
is coloured and gets a letter (M, A, U, R, C; deleted files have no row), a folder with changes under
it a dot (dot-named paths count only with the eye), each said in words in the row's label and title,
not by colour alone; filter matches carry the same letters. A toggle in the bar (only in a repo)
lists just the changed paths: folders open in the tree, deleted ones are struck through and don't
open. A failure is said under the bar; a runner without the op shows no marks. `readFile { sessionId, path,
maxBytes?, head? }` answers text (UTF-8, no NUL in the first 8 KB, under 3 MB of JSON), an image
(png, jpg, gif, webp, svg, avif, bmp, ico, checked by its bytes; base64) or "binary"; only as many
bytes as the file says it has are read. Over 1 MB it's the size only; a text file's first 1 MB on
asking (`head`), shown even if it isn't all UTF-8 or is mostly control characters (decoded with
U+FFFD, cut to fit, `lossy`, said above it). The viewer: text in a `<pre>` with line numbers, a
note when it holds bidirectional or control characters; Markdown preview (Markdown.tsx, remote
images not loaded) or Raw, where a relative link opens that file in the viewer or that folder in
the tree, `#heading` scrolls the preview (only it), and a link out of the folder is said above the
preview, which stays (only links with a scheme leave; nothing navigates the app); images as an `<img>` from a
`data:` URL (SVG too, so its scripts never run). **Mention** (in the viewer, `@` on a row: on hover,
always on touch, the `@` key on a focused row) adds `@path` (`@"path"` when it has spaces and no `"`;
a folder `path/`) to the message box's last line; on a phone the box isn't focused, so no keyboard
comes up. The tree is an ARIA tree: one tab stop, arrows move, Right and Left open and close,
Enter or Space opens. Opened folders (four at a time) and the open file load again on Refresh and
when a turn ends; while the tab is hidden, when it's next shown.

Only inside the folder. A path must be relative, without `..`, `.` or empty names, NUL, `~` or a
drive, under 4,096 characters, and its real path (every link resolved) must be inside the folder's
real path; that gives the plain refusals. What's guaranteed rests on the open handle, not the path:
a file opens `O_NOFOLLOW | O_NONBLOCK` (a FIFO never blocks; it must be a regular file), a folder
`O_DIRECTORY | O_NOFOLLOW`, and on Linux the kernel's path for the handle (`/proc/self/fd/N`) must
be inside the folder; a folder is then listed, and its entries' sizes and links looked at, through
that handle (`git check-ignore` too: it runs in `/proc/<pid>/fd/N`), and the filter's walk opens
each folder the same way. Linux without `/proc` refuses every read and list rather than reading
unchecked. So on Linux a link swapped in
anywhere on the path at any moment yields a refusal, never a byte or a name from outside (a test
races a swapper against all three ops). Elsewhere (macOS has no `/proc`, and `F_GETPATH` needs a
variadic `fcntl` bun:ffi can't call) it is best effort: after opening, the path is resolved again
and must be inside and the same file (device and inode), which narrows the window but can't close
it. Links are listed as links: to a file or folder inside (opened as that), else `outside` (never
read through or listed into, and whether its target exists isn't said); `broken` only for a target
inside by its text (missing, a loop). Names that aren't UTF-8 are listed, marked, and can't be
opened. Hard links aren't links: a hard link inside to a file outside reads as inside. Each open,
stat, realpath and readlink is waited on 5 s at most (the call itself may go on; a handle that opens
after that is closed); reading an open file and git's own limits (run.ts) aren't part of that. Nothing is written or run but `git rev-parse`,
`check-ignore`, `ls-files` and `status` (run.ts's hardening). A `.env` and the like aren't blocked or hidden
from a reader: it's the person's machine, behind the eye toggle. (Op answers pass the runner's
redaction of its own secrets, its token and stored keys, which keeps those from leaving through a
view of `/proc/self/environ` or a file holding one; it protects nothing else in a file.) All four
ops read the folder, secrets included, so they need drive access and are never view-only
(`VIEW_OPS`).

### Session names

Clicking a session title opens an inline editor. Enter saves, Escape cancels, and leaving the editor
saves a nonempty change. Names chosen in Tether persist through rediscovery and runner restarts,
and update on every connected device. Renaming starts no harness process.

### Archiving

Each main session row in the Sidebar has an archive button, and the session's ⋯ menu has Archive;
both become Unarchive on an archived session. Archived sessions leave Recent and the project lists,
search still finds them (marked Archived), and Home still shows one while it needs you or is working.
The flag is saved in the runner's prefs (`setSessionArchived`), so it survives restarts and the
90-day pruning, and shows on every connected device. A failure shows once: in the chat from ⋯, under
the row from the Sidebar until the next click or key or a few seconds.

**What archived it.** Every archive and unarchive logs a line on the runner (`[archive] <id> archived
by <cause> (was pinned): "<title>"`) and keeps the last one in the session's prefs (`archiveCause`:
archived, by, at). The cause says who: `person: <where in the app>` (the browser passes `via`: the
Sidebar row, the session menu, the worktree question), `send: a message to it`, `pin`, `side chats: …`,
`fork: …`, or `peers: tether_archive by its starter <id>` / `peers: its starter <id> is archived`.

**Sending unarchives.** A message you send to an archived session (`send`, not the queue's own
sends: a scheduled message firing stays as it is) unarchives it once the send is taken (a refused one
leaves it archived), under its worktree's lock (§4), so never while cleanup removes that worktree. A
session that went on under another id sends to that one, which is what comes back; a closed side
chat stays closed.

**Asking first.** Archiving a session in a worktree Tether made (the summary's `worktreeOf`, not
`worktreeHandMade`), from the row or ⋯, on a runner with `archiveWorktree`, asks "Delete its worktree
too?": **Delete worktree** archives with `worktree: "remove"`: the cleanup below, and the answer waits
for its word (up to 30 s; past that, it says the session's notice will tell), so when the worktree
stays the dialog says why. **Keep worktree** archives with `worktree: "keep"`: the session's
runner.json `worktree` gets `keep`, saved with the archive, and Tether never removes that worktree
(no cleanup, no sweep, not another user's archive) while it's set. Unarchiving drops `keep`, so the
next archive asks again. **Cancel** archives nothing. Agents' archives (`tether_archive`, cascades),
an older browser, and archives without the argument get the automatic cleanup. An older runner
(no `archiveWorktree`) isn't asked: it archives as it always did.

**Worktree cleanup.** Archiving a session, any way (`setSessionArchived`), removes the worktree Tether
made for it (§4, runner.json's `worktree`) and its branch, once that's safe (`modules/worktrees`
cleanUp, on the `archived` event). Never one made by hand (`handMade`) or kept (any record there with
`keep`); never while another session
that isn't archived works there (any stored session of any age with its folder there, or one recorded
as using it: an existing worktree through `tether_start`, a fork, a Move; the last one archived removes it); never while any session that uses it, archived or not
(each recorded user, every session in memory whose folder is in it, and each one's side chats), has
work going (a turn or a request, queued or held messages, a rate-limit retry waiting, a setup
running, background work or watchers, a terminal) or an open side chat; never while a process
outside the runner (a tmux session, a dev server) has its folder there, or Tether can't tell (no
`/proc`, as on macOS, or one of the runner user's processes that started after the worktree was made
hides its folder; other users' processes aren't seen). Before that count, the harness processes of
the sessions checked (idle, all archived) are closed, so any process left in the folder, the runner's
own children too, keeps it; a session whose worktree went starts again at its next send. The
session's own work is checked first, then the base branch is fetched (best effort, as New worktree
does), and everything is checked again under the worktree's lock, and once more right before `git
worktree remove`. Its HEAD must be in main (by ancestry or as
equal patches: a rebase merge counts, a squash of several commits may not). Ignored files it would
delete, file by file, must be in regenerable folders (`node_modules`, `dist`, `build`, `target`,
`.venv`, `venv`, `__pycache__`, `.next`, `.turbo`, `coverage`, `.cache`) or `known` and unchanged (same
size, time and hash); anything else (a `.env`, a local database, a file added or edited since, more
than 20,000 to check) keeps it, named in the reason. Then `git worktree remove` without `--force` (a
clean worktree only), and its branch by `update-ref -d` at the commit checked to be in main, so it
can't have moved in between; a branch with work not in main stays. A worktree folder already gone
is said so, and git's record pruned. Sessions of one worktree are judged one at a time (and never
while one joins it). A notice in the session says it was removed, or why it was kept (none while
another session still works there: the last one's archive decides); unsure, it stays. A minute
after the runner starts, and hourly, a sweep tries again for every archived session whose Tether-made
worktree git still lists on its branch (a restart cut it short, or it was busy when archived): the
same checks, and only a removal is said in the session. Unarchiving doesn't bring it back.

### Pinning

Each main session row in the Sidebar has a pin button beside archive (filled while pinned; on touch
screens only a pinned row shows it, to unpin), and the session's ⋯ menu has Pin/Unpin. Pinned sessions
sit in a Pinned group above Recent, oldest pin first, across runners (each runner's clock), on every
device; a search or a folder lists them as usual. The runner keeps when it was pinned in its prefs
(`pinSession`, carried on the row as `pinned`), past the 90-day pruning, and says so in its hello
(`RunnerInfo.pinning`: no pin buttons for a runner from before it; `RunnerInfo.build`: git commit and date). A pinned session is listed however
old: discovery looks up the old ones in parallel with a short timeout and keeps them (read again when
the store changes or after a minute); a failed lookup keeps the row. The pin keeps the row as last
seen (`pinnedRow`): a session the harness can't find is listed from it, dimmed, "Not found on this
computer" (`missing`), and stays pinned until the person unpins it. The pin follows a conversation to
its new thread (a source change, a renewed id). Modules see the lists without old sessions listed only
because they're pinned, or missing ones. Archiving unpins; pinning an archived session unarchives it. A subagent, a side chat (§16a) or
a session in a hidden folder can't be pinned. No reordering.

### API session dollars and retry times

An API badge includes the cumulative API-only session amount in USD. Estimates say **est.**. A total
that isn't whole but has a known subtotal above zero reads **est. $0.02**, its tooltip saying what's
missing (the same, with the cache-write lower bound named in the tooltip); with no subtotal, or a zero one, it says
**Cost unknown**, with what's known and missing in its tooltip. A partial subtotal is never presented
as the whole session amount, and a known subtotal is never a bare Cost unknown.

Every gap has a reason, as a fixed code in `reasons`, in `costs.json` and the tooltip. A report's:
`no-usage`, `no-cache-ttl`, `tier:<value>`, `model:<id>`, `tool-fee`, `long-context`, and Claude's
`no-baseline` (its earlier native total couldn't be read). The session's coverage: `earlier-usage`
(API usage from before Tether tracked it), `terminal` (a handoff TUI's unobserved spend). `unsaved`
is a total that couldn't be written. A file from before these codes reads with one for every gap:
coverage that wasn't whole is `earlier-usage`, a report that wasn't whole `no-usage`. `notes` keep
what a priced report left to a rule. Only those strings, the tier and the model id, never response
text, keys or headers. An OpenAI response prices from its own usage. A request that set no tier
(Codex's) is Standard, unless the response names another. Cache writes without a lifetime breakdown
are at the documented 30-minute default; if the request chose a lifetime, or the breakdown doesn't
add up, or there's no write count, they're at the cheaper rate, a lower bound and not whole. Dated
model ids aren't priced, because OpenAI publishes none. Over 272K input, other tiers and tool fees
stay unpriced. A thread that takes a session's place (a source change) starts from what the session
had spent, and plan turns add nothing to it. Subscription sessions show no dollars. Side queries on the
session's key (git actions' generated text, §10 Git actions) add to one `side-queries` report of
its own, estimated; one whose cost wasn't reported leaves it partial (`no-usage`).

**Where a session's API cost starts.** The first time a session's source is a key, its cost is whole
when Tether knows what it spent on an API before; otherwise it's partial, `earlier-usage`, and stays
so. Known means: a new session (nothing before), a session whose confirmed source until now was the
plan (`state.billing` from the harness, kept across restarts as Claude's `keptBilling` and Codex's
remembered thread), or what the ledger already holds. The chip's switch and the plan running out
(`advanceFallback`) decide it at the switch, while the plan is still what's confirmed; otherwise the first
start that confirms a key decides it from what that start replaced. A Move into a key, on any harness,
is a new session that starts whole: what came across was spent in the old one, which keeps its total.
A Codex source change's new thread starts whole and adds what the old thread's entry holds. Unknown
stays partial: an earlier source Unknown, a last start on a key with no entry (before the ledger), an
entry that was lost (`SessionPrefs.metered` says the session had one), and a handoff TUI on a key.
Entries made partial before this rule (a plan-to-key switch on an existing session) aren't repaired:
nothing kept says whether an earlier key period came before, so they show their subtotal as
**est. $x** with `earlier-usage`.
Claude's native cumulative cost is itself an estimate and resumes restore earlier, potentially
subscription-equivalent spend: a key process resumed after plan turns starts at the plan turns'
estimate (seen with Haiku: the pre-send read returned exactly the plan process's last total). Tether
subtracts that read-only pre-send baseline, so plan turns never count as API spend; a missing or
decreasing baseline leaves that process's spend unknown (`no-baseline`). `/clear` (and any
`conversation_reset` or new session id) zeroes Claude Code's total, so the baseline is zero from there. A handoff TUI has no cost stream and marks coverage
incomplete. Codex's gateway meters response usage before forwarding it to the harness, recording
pending requests before inference so a crash cannot leave a false complete total. Reports are
idempotent across replays and restarts. Published, dated OpenAI rates cover only exact supported
models and tiers. Azure prices only requests naming the session's deployment, from the table or its
Override (§10 **Azure**). A request is short context when its input tokens are ≤ 272,000, otherwise
long, at the table's long rates; the page states that cutoff only for GPT-5.4 and it's assumed for the
others. A model with no long rates for its type (gpt-5.4 on Data Zone) leaves a long request unknown,
`long-context`, and so does an Override, whose one set of rates says nothing of long context. Cache
writes are priced at the one write rate Azure lists, by their total (`cache_write_tokens`, else the
lifetime breakdown's sum), with or without a breakdown; with no write rate (gpt-5.5, gpt-5.4, an
Override without one) a request that wrote is unknown, `no-write-rate`. A response whose service tier
is anything but default, standard, auto or missing (Priority, Flex, Batch) is unknown, `tier:<value>`.
A table-priced report carries the note `azure-table`: the cost's tooltip says Azure's rates come from
Tether's dated table and the owner's agreement may differ. It still reads "est. $x". Missing rates,
hosted tool fees and unknown pricing remain unknown, and a partial total is never complete. These
estimates are not provider invoices.

The usage-limit error's retry timestamp is interpreted as runner UTC and displayed in the
browser's local timezone, including the date and timezone label. When the provider gives only a time (the retry is
within a day), it means the next such UTC time after the message. Native error text stays unchanged
in the store. Ordinary transcript dates and user messages are not rewritten.

### Usage

**Settings → Usage** (`#/settings/usage`), per runner: the last 7 or 30 days. At the top, each
harness's latest plan limits (`planLines`). Tiles: tokens; the API price of it all (est.); that
price by source, plan, API keys and unknown, and how many requests went to providers; **Billed to API
keys**, the ledger's (`costs.json`) whole-session totals for the sessions with usage in the range, so
it can include earlier days; cache savings, cache reads at the full input price less what they cost.
Then a bar chart by day (tokens stacked by input, output, cache write and cache read, or API price),
its numbers behind a visible **Show the numbers** button, and tables by harness and model and by
project (the top 8, the rest as one row, and TETHER_HIDE_PROJECTS folders as one unnamed row). A table's first column stays put while a phone scrolls it sideways.

With more than one runner, the Runner menu's first choice is **All runners**, where Usage starts:
the browser asks every online runner for its report and adds them up (`combineUsage`,
`shared/usage.ts`): totals and days summed, models by harness and model, projects by folder and
re-ranked (top 8, the rest as one row, hidden as one), plan limits named by runner, the scan running
if any is and read as long ago as the oldest. A **By runner** table follows the chart. A runner that's
offline or fails is left out and named ("Not included: …"); the rest still show.

A sum that leaves out requests with no price ends in **+** (a tile says how many), a source with
nothing priced says **no price**, one with no requests **—**, and a dollar bar for such a day has a +
over it: a partial subtotal is never shown as whole. When some logs couldn't be read (`scan.errors`),
every dollar tile is a lower bound too: **+** and a note. No price: a model the tables don't list, a tier
other than standard (Claude's `service_tier`, Codex's `thread_settings_applied`), a provider
(Bedrock, Vertex, Foundry, a gateway or an auth token, Azure: they set their own prices), Codex over
272K input, Sonnet 4.5 over 200K (its long-context beta's premium isn't listed: no price rather than
a low one). Hosted
tool fees (web search) aren't tokens and aren't counted. Prices: Anthropic's published first-party
table (`shared/anthropicRates.ts`: 5-minute and 1-hour writes, Haiku 5.5's long-prompt rates, fast
mode, US-only inference, the published dated ids of the 4.5 models) and OpenAI's Standard table
(writes at the 30-minute default).

Sources. Codex, per request from its rollout: a key's provider (`tether_openai`) or a private home is
a key, any other provider is a provider, OpenAI's own whose token count after it carried plan limits
(`rate_limits.plan_type`) is the plan, else unknown. Claude, as of Tether's last start of the session
(`Adapter.latestStart`: its source and time; an "Anthropic auth token" start is a provider): that
source from then on; before it unknown, since it may have been another. A Codex token count of rate
limits only (no usage) marks only the record just before it.

The `usage` module scans each adapter's
`usageStores()` (Claude's `projects/`, subagents included; Codex's `sessions/`, `archived_sessions/`
and the private homes of Tether's key threads, `codex-keys/`; Antigravity's runner-local
`antigravity-usage/`). Antigravity records one aggregate entry per live Tether prompt with usage in
its ACP result. It uses the selected model at prompt submission, includes thought tokens in output,
and leaves the entry unpriced. The page labels this scope. Older turns, standalone CLI or terminal
turns, and work without a prompt result are outside the recording scope. The ledger and the hidden folders come
through `ModuleContext` (`apiCost`, `hiddenFolder`). A request is one record. Claude: one per message
id and request id, at the largest counts its streamed entries carry; a compaction's own request isn't
in the store. Codex: `token_usage_record` by response id; before a file's first one, each
`token_count` whose running total moved (`last_token_usage`; a fork's inherited total isn't
counted). Copies of a request in several files merge to their largest counts and belong to the file
of the session the entry names.

Nothing is read until the page first asks; then the scan runs in the background, again when the op is
called over a minute after the last (or Refresh). Folders are walked by hand (an entry of unknown type is
`lstat`ed): symlinks aren't followed, and a folder or file that can't be read is counted in `scan.errors`, which the page shows,
without stopping the rest. One file at a time, in 4 MB chunks, yielding between them. Only a line
whose first 2 KB has a parser's marker is decoded and parsed; a line over 64 MB is skipped (counted)
without failing its file. Each file's records are cached in the module's data dir with its size,
mtime, read offset (the end of its last whole line) and a hash of its first bytes: an unchanged file
isn't opened, a grown one is read from the offset, a shrunk or replaced one from the start. Files and
records older than 32 days are dropped. The cache is written only when something changed, and never
after the runner stops. The op answers at once with what's read and `scan.running`, and the page
polls while it runs. Days are calendar days in the browser's IANA zone (`timeZone`), so DST and
quarter-hour zones bucket correctly. It reveals every project's activity: a drive op, and with
shared runners it belongs in `MANAGE_OPS` (shared/access.ts), never to view-only access.

### Amazon Bedrock

Settings → Bedrock configures one AWS region and authentication by Bedrock API key or a named AWS profile on the runner. The owner's model list is specific to each harness. Claude uses Bedrock Runtime with model IDs and inference profiles. Codex uses a private Responses provider connected to Bedrock Mantle.

Model choices use the provider's IDs. Manual changes to Bedrock keep a configured ID or match an unambiguous alias, with the first configured entry as the default. The destination's own defaults apply when leaving Bedrock. Requests are priced from AWS usage and configured or dated regional rates. The optional USD guard uses recorded spend across both harnesses for the UTC day. See [Amazon Bedrock setup](docs/amazon-bedrock.md).

## 11. Phases

### How each phase is built

1. **Implement**, by an implementation subagent briefed with this spec and the phase's scope. The
   coordinating session keeps the design consistent across phases and holds the design decisions.
2. **Review**, by a separate agent with fresh eyes, given the spec and the diff, not my reasoning.
3. **Fix** everything major or important it finds, then run **another fresh review agent**. Repeat
   until a review surfaces nothing major or important.
4. **Write the manual checks** in `docs/acceptance/P<n>.md`, as thorough as possible: every flow,
   phone and desktop, two devices at once, reconnects, runner restarts, errors, edge cases, each with
   exact steps and the expected result.
5. **Test it myself**, starting from the most core flows and working outward, with Playwright
   (desktop and phone viewports) against real `claude` and `codex` on cheap models (Haiku, Codex mini).
   I don't stop to wait for manual testing between phases.

Development happens on an isolated stack: a local server, a dev runner with its own config directory
and runner id, and its own tmux socket. Unit tests use recorded fixtures. A fake harness that replays
recorded event streams is used where it makes sync, queue and request tests deterministic.

**P0: Skeleton.** Repo setup (`v1` branch and `v1-final` tag, fresh `main` as the default branch, delete `master`),
shared protocol, relay (copied from v1's server and simplified), runner connecting with a service
token, dev mode (local server, `TETHER_TOKEN=dev`), the web shell with a runner list. Verify Bun's PTY
support (`Bun.Terminal`). The app stays on `master` (v1) until the P1 cutover, because pointing it at
`main` deploys v2 and stops v1 working.
*Accept:* the runner shows as connected in the browser, the server redeploys without the runner
noticing, and a reconnect works.

**P1: Claude, live.** Discovery (projects, sessions), opening a stored session (no process), new
session, send, streaming transcript, interrupt, model, effort and permission mode, idle close. Sync by
snapshot plus seq.
*Accept:* start a turn on desktop, close the tab, open on the phone mid-turn and see it stream; both
devices show identical transcripts after the turn; a session started in a terminal `claude` shows up.
**Cutover at the end of P1:** check that v1's `tether-runner` has no running sessions (wait or report if
it does), point the Foliation app `tether` at `main` (which deploys v2), delete `master`, replace the `tether-runner` unit with v2's runner, and use v2
from then on.

**P2: Requests.** The request broker (with the empty policy-step list), approvals and
questions from any device, idempotent answers, surviving a runner restart.
*Accept:* in `default` mode, an edit request appears on both devices; answering on the phone clears
it on desktop; a second answer says "Already answered".

**P3: Terminal mode.** tmux control, PTY bridge, handoff both ways, read-only tail, phone key bar,
composer messages held for Back to Tether, hooks for "needs you", the stop-and-open prompt with held
queued messages, project shells.
*Accept:* open the terminal mid-session, use a Claude-only feature (e.g. `/model` picker), go back to
Tether, and the next message continues the same conversation; the terminal survives a runner restart;
phone and desktop attach together without a garbled layout; a project shell running a dev server is
still there after closing the panel.

**P4: Codex.** The second adapter, through the daemon, with the shared terminal.
*Accept:* P1–P3 acceptance passes on Codex. The only core differences come from capability flags.
Typing in the TUI and in Tether on the same thread both work, and an approval answered on either side
clears on the other.

**P5: Daily-driver features.** Steer and queue, attachments, web push notifications (requests,
finished, failed), and the Home inbox. After P5, v2 replaces v1 in production.

**Texting (a module, `runner/src/modules/texting`).** iMessages through Photon Spectrum for a
request, "needs you", a failed turn, a turn whose last message asks the person something, and the
agent's answer after the person texted it (a turn that just finishes doesn't text), each with a link
to the session; skipped while the session is viewed. Only from a session whose **Session can text
me** box is ticked (a per-session checkbox, off by default for new sessions, in the header's phone
chip for its owner: `setCanText`, a manage op; `SessionPrefs.canText` → `LiveState.canText`, kept
however old, carried to a successor, a TUI's `/clear` too; a subagent goes by its main session's; an
archived session doesn't text): an unticked session texts nothing, not its requests, not its turns'
ends, not its `text_person`, and the person's texts reach only ticked sessions. The
first start with the box ticks, once, every session that held a number, was among Tether's
remembered texts or was written by text (`texting.json` `canTextMigrated`), keeping its number. A
runner without it says nothing (`RunnerInfo.canText`) and shows no box. A request's text is
one plain question in the agent's voice, under ~100 characters, with the session's link on its own
line below: "[2] Can I clean up the hide-checkin worktree? y/n", "[3] Can I run the jungle test
suite? y/n". The words come from the tool call's own `description` (Claude Code's Bash) or a
deterministic reading of the command (`texting/summary.ts`: its programs, the riskiest first). No
command text, no harness warning, no explanation: those stay in Tether behind the link. A question
carries its options; a plan asks "Can I go ahead with the plan to …?". Known secrets are redacted. Replies route by number: each text
starts with its session's number (1-9, kept while the session is open, 30 minutes after its last
text); `n text` or a threaded reply goes straight there; plain text goes to the open session last
texted or answered. A threaded reply to a text whose session isn't open any more (or to a message
Tether doesn't know) never goes by plain routing (a "y" mustn't approve another session's
request): it's held and the picker asks. With none open, plain text is held and answered with a numbered picker of the
ticked sessions (numbers offered for them, newest activity first, open 30 minutes; plain text never
goes to an offered number unpicked); with none ticked, "No session can text you". A number that
isn't open is held the same way, its picker listing only the open sessions still waiting (one
answered by text or in Tether since its last text drops out; its number still works). Unticking a
session drops its number: `n text` or a threaded reply to it gets "[n] can't text you anymore" for
30 minutes (until the number is taken again).
Tether owns every reply on the thread: the text-me skill (`textme`), which used to text from the
same number and split replies with Tether through `~/.local/state/imessage-thread/`, is gone, and
agents text only through Tether (`text_person`, below). On an open request, `y` allows
(approves a plan), `n` denies, a letter answers a question, and anything else is the person's words
to the agent (a denial's reason, which the agent reads and answers). Otherwise a reply is the
person's own message (`live.tell`, defanged). A reply passed on gets a ✅ reaction (tapback) on the
person's phone, and no text back. One runner holds the link; keys live on it
(`texting.json`, mode 600, or `runner.env`).

*One number for every computer* (the texting hub: `shared/textingHub.ts`, `texting/hubChannel.ts`,
`texting/hubWire.ts`). A person with several runners turns **Text for all my computers** on for one
of them in Settings → Messaging (`setTextingHub`, an owner's op; `texting.json` `hub`). That runner's
hello says so with whether it can text now (`textingHub: {up, images}`, said again when that
changes). The relay names each runner's hub (`{t: "textHub", hub}` on connect and whenever it
changes; none for a hub itself): a connected hub of the same person's (the same token, or tokens
with the same people in TETHER_RUNNER_OWNERS), one that can text first, then the longest connected.
It passes `{t: "texting"}` frames only between a runner and its hub; a call to anyone else is
answered "That computer is offline." The other runners (spokes) need no messaging set up: their
last channel is the hub's (`hubChannel.ts`), used when no connector of their own is connected.
- Out: a spoke's text goes to the hub with the session it's about; the hub numbers it in its own
  router (the session kept as `\u0001<runner>\u0001<session>`), so every computer's sessions share
  one set of numbers and one picker, sends it on its connector, and notes it for threaded replies.
  An image after a text, a request's text and `text_person` go the same way. Answered on the
  spoke (in Tether, a new turn, a closed request), its slot changes on the hub too. The spoke
  gates its own sessions' texts by their box, and turns away a reply the hub hands one that's
  unticked ("[n] can't text you anymore"). It tells the hub the whole set of its ticked sessions,
  with names (at start, whenever its hub (re)connects, and when a box changes): the hub's picker
  offers them (`texting.json` `remoteTexters`, 7 days after last heard), and the numbers of the
  spoke's other sessions go.
- In: a reply the hub's router gives to a spoke's session goes there (`deliver`), with the ✅
  handed back and the files the person sent (fetched and checked on the hub: HEIC made JPEG). The
  spoke takes it as its own connector's message: a request's y/n, or words and files to the agent.
  What it answers goes back the way the person wrote (`hub:<connector>`, the hub's DM or the
  channel a message was written in, under the channel rule below).
- Files travel in 256 KB pieces before the call that carries them, paced so the socket's buffer
  stays under 2 MB (the relay closes one past 12 MB): up to 25 MB a file, 64 MB half-sent from one
  runner, dropped 2 minutes after their last piece.
- The hub down (offline, or no connector connected): no texts go, and the app shows a yellow
  "Texting is unavailable" banner while it knows of one of your runners as the hub.

*Connectors* (`texting/connector.ts`, listed in `texting/connectors.ts`). Texts travel over
messaging connectors: iMessage (`imessage.ts`, Photon) and a Discord bot (`discord.ts`, its Gateway
WebSocket and REST API with no library: identify with GUILD_MESSAGES, DIRECT_MESSAGES and
MESSAGE_CONTENT, heartbeats, resume after a drop, reconnect with backoff; a refused token or intent
stops it with why). A connector is only a transport: its settings (secrets write-only), a link that
hears the person and sends text (and images, where it takes them), and its status. Everything above
(numbers, the picker, y/n, threaded replies, rate caps) is one router for all of them.
Tether's texts go to the connector chosen under **Send to**, else the one the person last wrote on,
else the first connected (one that's on and really connected). Whatever follows the person's
message about a session goes back on the connector it came by, saved per session
(`replyVia`, with the DM it came from). A shared place (a Discord channel others read) gets Tether's
direct reply to that message (the picker, a problem with it) and the answer of the one turn it
started, under one rule: the channel message counts only if the session was
idle with nothing queued when it came; any other input (a DM, Tether's web, a report, a request
answer, a held text picked from elsewhere, another turn) ends that claim; only the turn it started
may answer there, once. In doubt, the DM. Reports, failures, requests and text_person go privately. Files the person sends are stored with the session like
composer uploads and go with their words; held with the picker's
text, they go where it goes, and any that go nowhere (the hold moves on or expires, a reply that
isn't delivered) are reported. Discord: only the owner user ids set may drive it, in a DM or the one
channel set, where only a message that starts by mentioning the bot or replies to one of its
messages counts; anyone else, bots, webhooks and the bot itself are ignored silently. Tether's own
messages go to the owner's DM; only an answer to something written in the channel goes there.
Messages are split at 2000 characters, masked links are spelled out (and any left escaped);
mentions never ping. At most 900 fresh identifies a day across reconnects; a resume URL off
discord.gg is never used. Its settings live in `texting.json` under `connectors.discord`
(mode 600) or `runner.env` (`TETHER_DISCORD_TOKEN`, `TETHER_DISCORD_OWNER_IDS`,
`TETHER_DISCORD_CHANNEL_ID`); it's off until set. Tether's secrets (`TETHER_TOKEN`, the connectors'
keys) aren't passed to agents' environments: every process the runner starts gets `childEnv()`
(`runner/src/childEnv.ts`). Agents run as the same user, so files the runner can read they can too. A token set in `runner.env` also stays in
`/proc/<runner pid>/environ`, readable to same-user processes: the settings page (`texting.json`) is
the recommended place for it. A session sees Discord's words marked
`[From Discord] ` (shown "via Discord"). Ops: `messagingStatus`, `setConnector`,
`setMessagingPrefer`, `testConnector` (the iMessage-only `textingStatus`/`setTexting`/`textingTest`
stay for an older web).

*Who a text belongs to*, in order (`texting/router.ts`):
1. A threaded reply belongs to the session that sent the message it answers (a request's text
   answers only that request, #66).
2. `n text` (and just `n`) goes to session n.
3. Plain text goes to the open session last texted or answered (but with two or more open requests
   it's held and the picker asks, so a plain "y" can't approve the wrong one), or gets the numbered
   picker of ticked sessions; with none ticked, "No session can text you".
There is no Home agent to text: its old chats are ordinary sessions in a hidden folder (§2 Project),
reached by a text only when their box is ticked; agents can't message them or start sessions in that
folder (`tether_send`, `tether_start` refuse any hidden folder's).

*Files and images.* Files the person sends on any connector (iMessage attachments through Photon,
Discord's from its CDN) go as the *Connectors* paragraph says, stored by the runner as an upload is
(`core/attachments.ts` storeFile: a safe name, an image's extension made its type's, the
session's 2 GB, read-only, never over another file), which reads them itself, outside every
session's sandbox. Each read is
bounded: at most its cap (10 MB an image, 25 MB a file), counted as it streams whatever size it
claimed, and 30 s (iMessage's download; Discord's own limits; the stash's outer bound), so a stalled
download can't hold up the text queue; one that fails is skipped and the person is told. An image
is what its bytes say (PNG, JPEG, GIF, WebP, HEIC): one that only claims to be is stored as a plain
file. HEIC is turned into JPEG with ImageMagick when the runner has it, and so is a PNG, JPEG or WebP
over 2048 px on its long edge (ATTACH_IMAGE_EDGE) or too big for the model APIs (NATIVE_IMAGE_MAX),
scaled to fit: `convert` told the input's coder, run with only PATH and its own temporary folder
in its environment (never the runner's tokens), `-limit memory 256MiB -limit map 512MiB -limit
disk 256MiB -limit area 128MP -limit width 16KP -limit height 16KP -limit time …`, its temporary
files in a `tether-magick-*` folder of its own that's removed after (ones older than an hour are
swept when texting starts), at most 2 at once (a finished one hands its slot straight on), waiting
and running within 30 s, output capped. Without it (or when it fails, or no slot frees in time) a big
image goes as it came, and a HEIC by path, named `.heic` whatever the sender called it, with a note
saying so in the message (`phoneLine.ts` heicNote). Files alone are "(sent a file)"; while a request
waits they go to the agent and the request still waits on the person; with an answer to a request
they follow it (queued after its turn). Files held with a text the picker holds go where it goes,
or with whatever text takes the held one over (`2 what's wrong here`), and a
caption sent after its photo takes the photo along. Held files are kept in memory only: after a
runner restart they're gone, and the person is told so when the held text goes (a hold of only
files isn't passed on as words). Held files the person never sends on (no pick within 10 minutes)
are dropped and the person is told then, once. A send that fails says so and that the file didn't
go, in one text. A voice note, contact card, poll or app card (iMessage) gets one short text per
message ("Only text and files get through, so I left the rest out."); the words with it still go.
Reactions and read receipts are ignored. Every call into a connector made while handling the
person's text (a send, the ✅, opening iMessage's chat) gives up after 30 s (`PHOTON.ms`): logged,
and the queue goes on; a text whose send timed out may have gone, so text_person tells the agent
not to send it again.

Out, images are read by the runner itself, outside every session's sandbox, and go only to the
person: their DM on Discord, their phone on iMessage. `text_person` takes an optional `image` where
the connector takes images (`Connector.images`:
iMessage, each image its own message after the words; Discord, an attachment): an absolute path to
a .png/.jpg/.gif/.webp/.heic file, opened once without following a final symlink or blocking on a
FIFO, checked on that handle (a regular file of at most 10 MB whose first bytes match), sent as the
bytes checked (`Outbound.files`; a path handed to a connector, `Outbound.images`, is checked the
same way). The file is read once, where it's sent. Every refusal says the same thing (no telling
which paths exist), a refused image doesn't use up the agent's text cap, and a session past 5
refusals in 10 minutes has every image refused before anything goes; nothing goes.

On iMessage only texts from the person's own number are heard (`link.ts` fromOwner): the sender's
Apple address must be a phone number (no `@`; an Apple ID email is never taken, whatever digits it
has) that is exactly the configured phone once both are in E.164 (`+1 555-123-4567` is
`+15551234567`); another country's number ending in the same digits isn't. (Discord: the owner user
ids.) A link sent with its preview (`richlink`) is its URL as words.
A text heard twice (same message id) is taken once.

*Agents texting the person.* Texts go through Tether (the text-me skill is removed): every
session Tether runs has `text_person(message)` (§9a). A session texts when its **Session can text
me** box is ticked; unticked, the tool refuses and nothing goes. Requests' own texts follow the same
box. A session's text is stamped with its number like any other (`[n] …`, status "texted you", the
link as usual) and goes out even while the session is open in Tether, cut at 300 characters, and
capped at 3 per sender and 10 in all per 10 minutes (a refused or failed one is the tool's error,
and says to put it in the reply instead). A reply routes like a reply to any of Tether's texts
(threaded, `n text`, the open session last texted; ✅, taken once), so it reaches that session as
the person's message, and its answer comes back by text.

**P5b: Shell from the main UI.** `!` commands in the composer (§9 Shell commands): run at once on the
runner, a card with live output, Stop, and the output sent to the agent through the queue (waiting
for a running turn, obeying holds and limits). The ❯_ button opens a project shell beside the live
session; the panel's **Claude Code** / **Codex** entry is the only way to drive the agent from its
own terminal UI, with labels that say which surface drives it; copying from any terminal, scrollback
included; on a phone a quick Chat/shell toggle (§8).
*Accept:* `!` on desktop and phone, both harnesses, mid-turn queueing, Stop, holds, huge output,
restarts; ❯_ keeps the session live while the composer messages the agent; only the agent's entry
hands over, switching back doesn't; copying works on desktop and phone; the phone toggle keeps the
shell.

**Later (each a module, in an order you choose):** the Tether judge (a policy step), checkpoints with
the Changes view and file panel, pi, opencode and other harnesses.

## 12. Carried over from v1 (`~/web-coder`)

Copy and adapt, with tests:
- `server/src/index.ts` and `identity.ts`: the relay pattern and Foliation identity (add subscriptions and terminal routing).
- `web/src/shared/protocol.ts`: `Msg`, `Part`, `SessionEvent`, `SessionSnapshot` only.
- `runner/src/adapters/claude.ts`, `codex.ts`: the protocol knowledge (SDK options, app-server
  methods, history parsing, quirks) and their fixtures. Not their structure.
- `runner/src/toolKind.ts`, `checkpoint.ts` (later), `attachments.ts` (P5).
- The service-token setup (`docs/foliation-app-service-tokens.md`) and the systemd unit.

Leave behind: `runner/src/session.ts` (rewrite as the core, §3), the guard (it returns as policy steps),
and everything in the non-goals list.

**Lessons recorded:** no god file; a feature must not change the session core; every harness is
tested for real before it counts as supported; don't build six adapters before two are solid.

## 13. Resolved questions

1. **Codex terminal notifications:** moot, because Tether stays attached to the shared thread.
2. **New sessions in terminal mode:** Claude takes `--session-id <uuid>`. Codex threads are created by
   Tether through the daemon, and the TUI resumes them.
3. **Terminal auth:** owner-only sign-in. No extra step.
4. **Several runners:** in the protocol now, in the UI when a second runner exists.
5. **A new session nobody sent to** is in no store. Runner.json remembers it (`blank`), so it leaves the
   lists when its process closes but its id stays good: opening it or sending brings it back in the same
   folder with the same settings. Claude starts the same id again. A Codex thread with no rollout can't
   be joined, so a new thread takes over and views follow (`continuedIn`, `movedTo`). A session that had
   a message and lost its store stays gone.

Still to verify by experiment (not decisions): Codex approval fan-out and cross-connection steer
(P4), and how daemon and CLI version mismatches behave.

## 14. Working agreement

- I build P0 through P5 autonomously, testing as I go. I don't wait for manual testing between
  phases. I report when everything is done, or earlier only if I'm blocked on a decision that's
  yours or on something I'm not allowed to do.
- Allowed without asking: commit, push to `main` (which deploys once the app follows it), the cutover
  at the end of P1, real test turns on cheap models, an isolated dev runner and tmux socket.
- Ask first: anything that spends notable quota on expensive models; anything outside this project.

## 15. Moving a session to another harness

**Change session harness** in a session's header menu makes a new session on another harness, or on the same
harness with another billing source, with all of the old one's context. The old session stays as it was, its store untouched. It is a module
(`runner/src/modules/move/`) and only ever an explicit choice: moving copies the history, secrets
included, to another provider, and nothing scans it or does it automatically.

**Neutral format.** No code knows a pair of harnesses. `shared/move.ts` has the format and everything
done with it. A source exports `Msg[]` (`Adapter.move.exportHistory`, else `readHistory`) plus its
subagents' transcripts (`listSubagents`); a target imports plain turns (`PortableItem`: a role, text,
images). A new harness declares `capabilities.move` and `Adapter.move`, once, and works with all the
others; `move.test.ts` proves it with a third and fourth harness that are only those declarations.
Only one field was added to `Msg`: `compactSummary`, on an exported compaction's notice.

**Two routes**, by `capabilities.move.import`:

| Route | What happens |
|---|---|
| `native` | The turns go into the new session's own store (`importHistory`) and are checked (`imported`). The newest that fit go in; the session's first send resumes it as usual. A failure anywhere falls back to `context`, and leaves no session |
| `context` | For a harness with no import: a new session whose first turn is Tether's message with a summary, the last reply and where the history is. The agent replies "Ready." `TETHER_MOVE_ROUTE=context` forces it for tests (`TETHER_MOVE_BUDGET` sets the token budget, to keep a test's turns small) |

Either way the **whole history** is written first to a private file: `<config dir>/modules/move/<new
session>/history.md`, folder 700 and file 600, outside any project, with `images/` and `attachments/`
(files are copied, as the old session's are swept). It names images by path. A session moved twice
carries on the earlier file under "Before that", so what didn't fit then stays reachable. These files
stay until removed by hand: deleting a session doesn't remove them.

| Direction | Route used, and why |
|---|---|
| Into Codex | `thread/inject_items`, the daemon's own call for model-visible history, as `message` items with `input_text`, `input_image`, `output_text`. It persists in the rollout and survives `thread/resume` (daemon 0.166). The daemon's turn lists don't show them, so `importedFrom` reads them back from the rollout (a thread marked in `codex-threads.json`), and the transcript starts with them. `thread/resume { history }` is marked "FOR CODEX CLOUD - DO NOT USE"; writing a rollout is private. Not used |
| Into Claude Code | Writing `~/.claude/projects/<folder>/<id>.jsonl`, a private format, as there's no import call. The SDK's `SessionStore` takes the same private entries, through an alpha API and a temporary copy, and `claude --resume` wouldn't find the session, so it adds risk and removes nothing. The risk is limited: a plain chain of `user` and `assistant` entries, the smallest shape `resume` reads (2.1.316), read back with the SDK's public `getSessionMessages`, every entry counted, and a mismatch deletes the file and takes the `context` route. Images are real image blocks. The title goes through the SDK's `renameSession`. Replies are model `<moved>`: readers skip it for the session's model and context |
| From Claude Code | The store's transcript plus each `isCompactSummary` entry's text |
| Into Antigravity | The `context` route: ACP has no import. Its driver approves reads of the moved history's folder itself |
| From Antigravity | The replayed transcript (§6 **Antigravity**) and its subagents' |
| From Codex | The turns (via `thread/turns/list`), what was imported into it, and images a TUI attached by path. Codex's compaction summaries are encrypted, so they can't move; the turns before them stay readable, so nothing is lost |

**Tool calls** don't exist on another harness. They travel as text in their turn, with name, input,
status and output, and never as a tool call: no id for the target to honor. Thinking travels as text
where it's stored. A subagent's work is whole in the file; in context it's its report on the call
that started it and a line saying where the rest is. A conversation that ends on the user gets a line
from Tether, so the target isn't left mid-turn.

**A history bigger than the target's window** (`planImport`) doesn't fail or drop anything silently.
The budget is half the window (`Adapter.move.contextWindow`), at most 200k tokens, 80k when the window
isn't known, estimated at 4 characters a token and 2k an image. The newest messages that fit go in;
one tool's text is cut at 12k characters, saying where the rest is; the newest 16 images go as images
and the others stay files. Tether's opening then says what was left out, with a digest made without a
model: the last compaction summary, what you asked in order, files changed, the last commands,
subagents. The notice on the new session says it too: "17 of 32 messages in context; the agent can
read the rest."

**When.** Refused, with the reason in the dialog and from the op: a running turn, an open request, a
terminal in use, waiting messages, a `!` command or a subagent running, a turn another Codex client
runs (`Adapter.move.busy`), a store written in the last 3 s while it isn't live, an empty session, a
subagent itself. Background work the harness keeps running (`backgroundRuns`, `Driver.busy`) doesn't
stop a move and doesn't move: the dialog says so, the agent is told, and the notice says "Background
work stayed there."

**Links.** Tether's own notices (§5), which are in no store: "Moved from Codex." on the new session,
under what came across (at the top for the `context` route) and "Moved to Claude Code." on the old,
each with Open it. `continuedIn` isn't set: the old session stays usable and views don't follow.

**Permissions.** A target never starts looser. Each harness places its modes on one scale
(`LEVELS`), and the target gets its loosest mode at or under the source's level. Unknown, none or
custom is the safest. Combinations go by their tighter side.

| Level | Means | Claude Code | Codex |
|---|---|---|---|
| 0 read only | changes nothing | `plan` | `read-only`, or any policy with a read-only sandbox |
| 1 ask | asks before edits and commands | `default`; `dontAsk` (source only) | `untrusted` |
| 2 edits | edits go ahead, commands ask | `acceptEdits` | none |
| 3 sandboxed | edits and commands go ahead, inside the folder, no network | none | `auto` (reviewer or not); `on-request+danger-full-access` |
| 4 judged | no sandbox; the harness judges what needs asking | `auto` (source only: it depends on the model) | none |
| 5 full | everything goes ahead | `bypassPermissions` | `full-access` |

So Claude `acceptEdits` becomes Codex `untrusted` (Codex has no edits-only mode), Codex `auto` becomes
Claude `acceptEdits` (Claude has no sandbox, so commands ask), Claude `auto` becomes Codex `auto`, and
`full-access` and `bypassPermissions` map to each other. The semantics differ: Codex limits what a
command can touch, Claude what's run without asking.

**Model and effort** are chosen in the dialog. Claude unset is `CLAUDE_UNSET`, as for any session;
Codex keeps its Default. On Azure the Model lists its deployments, each with the model it runs ("luna-a ·
gpt-6-luna"), here and in New session; there is no Effort choice.

**Billing.** The dialog's Source picks the new session's source, as in New session, with no fallback.
Its id comes with a snapshot of that source, a key's Codex thread is made on its private app-server
and imported there, and the source is saved with the session before anything starts it. A native
import starts the session at once, so the harness confirms the source and the loud badge shows before
anything is typed. If it can't confirm, the session opens with the error and refuses to send; it never
goes to another source. Thus a move can cross from a subscription to a key: the dialog is where
that's seen.

**The same harness** is a target when it has another source; the session's own isn't offered, and with
no other the harness isn't listed. The mode and, by default, the model and effort stay. The notices name
the sources ("Moved from ChatGPT plan."). The billing chip changes a session's source in place; this
keeps the old session as its own.

**Reading the history.** Codex reads anywhere in every sandbox. Claude would ask, so a moved
session's driver and TUI get one read rule for exactly its folder (`Read(//…/**)`), and nothing else;
it works in plan mode too.

**Core hooks.** The module needs the session core only through `ModuleContext.sessions`
(`SessionActions`, `core/runner.ts`), which is thin wrappers over what's already there, and
`SessionLook` says a bit more. Beyond those: `Adapter.move`, `capabilities.move`,
`OverlayNotice.first`, and `core/moved.ts` for the folder's path. No session lifecycle code changed.

## 16. Forking a session

**Fork** in the session's ⋯ menu makes a new session with the same conversation, in the same folder,
on the same harness and source, with the same model, effort and mode. **Fork from here** under a
reply makes one whose conversation ends at that reply. The original is never changed, and the fork
opens ("Forking…" in the chat meanwhile). It is a module (`runner/src/modules/fork/`, op
`forkSession { sessionId, messageId? }`); other modules fork through `SessionActions.fork` (side
chats, §16a, build on it).

**Fork points** (`shared/fork.ts`, the UI and runner alike): the assistant reply that ends a turn,
that is a reply with no error, ending on text (one ending on a tool call is mid-turn), followed by
your next message or by nothing. A stopped turn's reply counts: its turn ended. User messages,
notices and errors aren't fork points, nor is history the harness can't fork at (`Msg.noFork`:
Codex's imported messages and a source change's earlier thread, which aren't in its own turns).
Desktop shows Fork from here on hover (hidden, it takes no clicks but stays in the tab order);
touch, always.

**While a turn may run** the running turn is never forked: its replies aren't fork points, and Fork
takes the conversation through the last finished turn ("No turn has finished yet" when none has).
That's a turn in Tether, one another Codex client runs, and anything while a handoff harness's TUI
has the session (Claude's: Tether doesn't follow its turns). And Fork of a whole session whose store
doesn't end on a fork point (a turn in the CLI, outside Tether, ending on your message or mid-reply;
a failed turn) takes it through the last fork point too. A whole fork that stops short says so in
its notice: "Forked through the last finished turn; the failed (unfinished, running) turn after it
isn't included."

**Not forked:** a subagent (fork its main session; the fork's tool cards don't link the original's
subagents); a session whose source change isn't confirmed yet (`nextBilling`: send first); a harness
without `capabilities.fork`.

| Harness | How |
|---|---|
| Claude Code | The Agent SDK's `forkSession` (a file operation: fresh entry ids, `forkedFrom` on each entry), `upToMessageId` the last entry of the reply's API message (a moved-in `<moved>` reply too; only `<synthetic>` ones aren't replies). Replies keep their message ids, so the fork must read back ending on that id (a whole fork: as many messages), else it's deleted. Across a compaction, as recorded, too |
| Codex | `thread/fork` with `lastTurnId`, the reply's turn (inclusive), so nothing is rolled back: later turns are never copied. A reply followed by a message steered into its turn isn't a fork point here. Checked on daemon 0.169.1: no turn starts, turn ids are kept, and the fork's rollout holds only its own lines, its `session_meta` pointing at the original's (`forked_from_id`, `forked_from_ordinal_exclusive`). The fork is read back (its last turn) and named, else archived. So a fork reads its history from the original's rollout: archiving the original is safe, Codex refuses to delete an original a fork refers to, and removing its file by hand breaks the fork, whose opening (or history) then says "This fork's original history is gone (its Codex rollout was removed)." (the daemon's `missing source rollout`) |
| Codex, copied | Copied instead (`Adapter.fork.copyInstead`) with §15's native import of the history through that reply, into a new thread on the same source: a thread on a key's private app-server, which serves one thread; and a thread with history brought in (a move's import, a source change), as its fork wouldn't show that history (Tether reads it from the thread's own rollout head: checked, a fork reads none back). So Fork right after a source change copies it whole. Tool calls travel as text and Tether's opening reads as a move's |
| Antigravity | No fork call, so a copy of the store under a new id: a consistent snapshot (`VACUUM INTO`, safe while the original runs), the id rewritten wherever it appears (same length, so the protobuf framing holds), cut before the prompt after the fork point (`steps`, `step_type` 14, and the tables keyed by step), the brain folder copied. Checked on 1.5.13: it loads, is listed, continues with only the kept turns, and the original is unchanged. Read back by replay, else deleted (`antigravity/fork.ts`) |

A fork that can't be adopted once made (its settings, its notice) is removed from the store
(`Adapter.fork.discard`: Claude's file, Codex's thread archived) and its row archived.

**Billing.** A fork starts nothing and bills nothing: both harnesses fork in their stores. It's
saved as the original's source (`SessionPrefs.source`) and settings, stored, and its first send
starts it as any stored session, confirming the source first. Its chip meanwhile shows what the
original's latest start confirmed (copied in `claude-windows.json`, `codex-threads.json`): the one
exception to "the label changes only after harness confirmation". It's safe because the fork has
exactly that source saved (a pending change refuses the fork), the label says what the harness
confirmed for that source, so the API colour shows before anything is typed, and nothing is sent
until the fork's own start confirms it again; a mismatch refuses the send as for any session. A
key's copy starts that key's private app-server to make its thread, but no turn. The fork inherits `lastKey`. Each fork starts with its own fallback chain off.

**Links.** `SessionSummary.forkedFrom { sessionId, messageId?, title }` (`SessionPrefs.forkedFrom`,
kept across a source change like the session's other settings): the header says "Forked from
“<title>”", by the original's title now, and opens it. A notice under what the fork took says the
same, with Open it. The original gets nothing.

## 16a. Side chats

`/btw <question>` in a session's box, or **Side chat** in its ⋯ menu, opens a panel beside the
transcript (where the terminal panel goes; when there's no room, as on a phone, a full-screen sheet
over the session: a modal dialog that keeps focus, Escape tucks it away) holding a **side chat**: a
fork (§16) through the last finished turn, read-only, asked the question. The session keeps working
undisturbed: a running turn is allowed and never forked. It is a module
(`runner/src/modules/sideChats/`, ops `openSideChat { sessionId, question? } → { sessionId }`,
`bringBack { sessionId } → { text }`, `closeSideChat { sessionId }`).

- **`/btw` is Tether's.** It's first in the `/` menu of a session that can have side chats
  (`canSideChat`: it forks, its harness has `capabilities.readOnlyMode`, it isn't a side chat or a
  subagent; the runner refuses the same). The page intercepts it
  whatever the session is doing (send, steer, queue); it never reaches the harness. With files
  attached it's refused with a note under the box, which keeps them. Where side chats aren't
  offered it goes as typed.
- **A side chat** is a session with `SessionSummary.sideOf` (`SessionPrefs.sideOf`, indexed in
  prefs), titled "Side chat: <question>". It's left out of every list: Recent, projects, search,
  archived, Home's inbox, and what modules list or reach (peers). Nothing of it is pushed. The session's header shows **Side chats
  N**, closed ones too (`listSessions { sideOf }`, from the prefs index); picking one opens it in the
  panel (a closed one is unarchived). When the session goes on under a new id (a source change's new
  thread, a renewed id, a Move) its side chats follow (`moveSides`); a side chat's own successor stays one.
  Opened on its own, its header says "Read-only side chat of “<title>”", with a Read only chip for
  the Mode and no Terminal, Change session harness, Fork or source switch.
- **Read-only, by the harness.** Started with `StartOpts.readOnly`. In the core, both harnesses: its
  mode can't change ("A side chat stays read-only."), its approvals (a plan's included) are refused
  without asking anyone, questions still come to you; it can't change source or the plan-runs-out
  switch, move, be forked, run `!` commands or open a terminal, and takes no `/` command (sent,
  steered or queued: a custom command's text can run shell lines before the model sees it).

| Harness | Mode | Enforced by |
|---|---|---|
| Claude Code | `default` (Ask first) | A PreToolUse hook (`adapters/claude/readOnly.ts`) denying every tool but a fixed list that only reads: Read, Grep, Glob, LS, NotebookRead, WebSearch, TodoWrite, ToolSearch, AskUserQuestion. No WebFetch (it would send what was read anywhere), no shell at all (a list of "reading" commands doesn't survive quoting and options), no MCP tool (Tether's included), no subagents. It fails closed: anything it can't read is denied. A hook's deny stands over modes, allow rules and the auto classifier. The person's own hooks (settings, plugins: a Stop or PostToolUse hook could write) are off (`disableAllHooks`); the SDK's gate still runs (checked on 2.1.327). A read outside the folder asks, and the core refuses it. Plan mode isn't used: on 2.1.327 it let `echo hello > f` run without asking (the person's default being auto), and ran its turns on Sonnet instead of the session's model. The system prompt says it's a read-only side chat |
| Codex | `never+read-only` | Codex's read-only sandbox, with no approvals to escape it. MCP servers, apps, plugins and hooks run outside the sandbox, so the thread is made (a fork, or a copy's `thread/start`) and resumed (`adapters/codex/readOnly.ts`) with every server in the person's config turned off by name (`config/read`; a config it can't read fails the start), `features.apps`, `plugins`, `multi_agent` and `hooks` off, and without Tether's own server. After each resume the daemon must say, on every page of `mcpServerStatus/list` for the thread, that each server it knows is `disabled`, `failed` or `cancelled` with no tools (not started or unknown counts as on): a thread another client loaded keeps that client's config, so anything else fails the start. `config/read` takes no thread, so the features turned off at load can't be read back (apps would show as their own server). Checked with a stdio MCP server in a temporary CODEX_HOME: the session starts it, the side chat doesn't and can't call it |
| Antigravity | `default` | Its default mode asks before every edit, command and MCP call, and the core refuses a side chat's approvals (the driver too, without asking). The fork's process gets no MCP servers and no Tether tools, and `_meta.antigravity.systemPrompt.append` says it's a read-only side chat. A saved Always-allow rule in Antigravity's `settings.json` refuses the side chat. Not gated by Antigravity, checked on 1.5.13: `invoke_subagent` (a subagent inherits the gate, and its approvals never come back, so it can't write either) and `schedule`. An "always allow in this conversation" grant made in its TUI before the fork lives in the copied steps; `--sandbox` stops neither writes nor network, so it isn't used |

  WebSearch stays (Claude): a query can carry some of what it read. Read-only holds only inside
  Tether: the side chat's id resumed in the harness's own terminal (`claude --resume`, `codex
  resume`) runs ungated, in whatever mode that terminal picks.
- **Bring back** runs a turn in the side chat, Tether's ("[From Tether] Bring back: summarize …
  in at most 5 short lines"), waits for the end of the turn that message started (100 s at most),
  and returns "From a side chat:\n\n<its reply after that message>", which the page puts in the
  session's box as a draft to edit and send (`putDraft`; on a phone the sheet tucks away so the box
  shows). It's never queued or sent by itself: the person decides what goes into a working session.
  Refused while the side chat is answering; its box is off meanwhile.
- **Close** (×) stops a turn it runs, then archives it. Closed while it's still being made, the
  fork is closed when it arrives. Side chats opens it again.
- **Billing** is the fork's: the session's source, model and effort; its turns are real turns.
