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
| Harnesses in the core | Claude Code and Codex. Others come later through the same adapter interface |
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
person starts (§15); an automatic one stays a non-goal.

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
  queued messages stays listed, and a hidden session opens by id as usual. Unset, nothing is hidden.
  New session can make a folder: the dialog asks the runner (`checkFolder`), warns when it doesn't
  exist yet, and only a confirmed `createFolder` on `newSession` makes it, parents too. Only a path
  starting with `/` or `~/` is made.
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
  the session's store (its .jsonl) to be unchanged for 15 s ("Waiting for Claude Code from before the
  restart to finish…", the queue held); it never inspects or signals processes. Then, if the store
  shows the turn finished (the agent's answer after the last prompt), nothing is continued and the
  queue goes on; otherwise it continues once. After 10 minutes of writes it gives up: Failed on Home,
  the queue held, "Send a message to carry on." During the wait nothing starts Claude: a message you
  send queues, held, and follows the continue; Resume can't release it. The wait is saved (`running`
  and `restartWait` in runner.json), so a restart during it comes back to it, and `continuedTurn` is
  set only once a continue goes out. Opening the terminal during the wait cancels the continue: your
  queue waits for Back to Tether. Residual risk: a left-behind process silent for over
  15 s (a long tool call) could still overlap; production's systemd unit (KillMode=mixed) ends a
  stopped runner's children anyway.
- **Not** for a session waiting on the person (a saved request is asked again instead), one the
  person stopped (saved at once, so a restart before the stop takes effect doesn't continue it), one
  whose TUI drives; at most once per cut-off turn (a
  continued turn cut off again is left for the person), and not within 2 minutes of the last
  automatic continue. Those fall back to Failed on Home and a held queue. A harness that keeps turns
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
`setPermissionMode`, `listModels`, `listCommands`, `deleteSession`, `openTerminal`, `closeTerminal`,
`terminalInput`, `terminalResize`, `runShell`, `stopShell` (P5b, §9 Shell commands). The move module
adds `moveOptions` and `moveSession` (§15).

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
- **Plan exhausted:** §10 **When the plan runs out** has the signals.
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
- **Plan exhausted:** §10 **When the plan runs out** has the signals.
- **Plan limits:** `account/rateLimits/read` when a session opens (at most once a minute, no turn) and
  `account/rateLimits/updated` on a live connection (sparse). `primary`/`secondary` are placed by
  `windowDurationMins` (300, 10080); `usedPercent`, `resetsAt` in seconds.

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

| | Claude Code | Codex |
|---|---|---|
| Live turns | SDK frames with `parent_tool_use_id` / `agent_id`; set `forwardSubagentText: true` so text and thinking come through, not only tool calls | each subagent is its own thread (`parentThreadId`); its `item/*` events stream like any thread |
| Past transcript | `~/.claude/projects/<dir>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json`), or SDK `getSubagentMessages`. Thinking isn't saved there, so past thinking is empty | its rollout file, or `thread/read` / `thread/items/list` on the child thread id |
| Stop | `stopTask(taskId)` | `turn/interrupt` on the child thread |
| Steer | via the main agent's `SendMessage` tool (see below) | via the main agent's `send_message` tool (see below): Codex refuses input on a subagent's thread |

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
- **Plans** (Claude's `ExitPlanMode`, Codex's plan item) open as a document (`PlanReview.tsx`).
  Select text or click a paragraph to comment; comments sit beside their text (a sheet on phones)
  and stay in the browser until sent. **Send feedback** sends one block per comment in plan order,
  the quote as a `>` blockquote then the comment, then a general comment (`shared/plan.ts`): Claude
  gets it as the denial's reason and keeps planning; Codex gets it as a message, still in plan mode.
  **Approve** goes back to the mode the session had before Plan (`SessionPrefs.beforePlan`, else
  the harness's own choice), and any comments follow as notes: steered into Claude's turn, or after
  "Implement the plan." for Codex. A plan whose harness isn't waiting in a turn (`planFollowUp`) is
  answered by the runner and passed by when another turn starts.

## 8. Terminal mode

### What the button does

The ❯_ **Terminal** button opens a project shell beside the chat (below). The panel's entry named
after the agent, **Claude Code** or **Codex**, opens the harness's real TUI, mirrored in the browser
(xterm.js), resumed on the same session. While a handoff TUI drives, the structured view stays
visible as a **read-only live transcript** (tailed from the store) with a banner: "Driving in the
terminal".

### Shared (Codex)

The TUI joins the live thread next to Tether. Both can type, both see everything, and nothing changes
mode. Closing the terminal just detaches.

### Handoff (Claude: live → terminal)

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
  control keys and a paste, in the same write, so nothing comes between. Scrolling keys stay in
  copy mode; Esc only leaves.
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
  Shift+Enter newline, Esc stop (empty box). On phones Enter is a newline and buttons send.
- **Shell commands** (P5b): text starting with `!` is a shell command (below).
- **Attachments** (images and files, by paste, drop, picker or camera) are in the core because phone
  screenshots are a main use. Chunks go over RPC and are stored under
  `~/.config/tether/attachments/<session>/`. They go to the harness natively where supported, and as
  paths otherwise.

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

## 10. UI

- **Sidebar:** a flat list of recent sessions across projects (title, harness glyph, project, how long
  ago, status dot), with projects below. Search. New session (pick a project, harness, model).
- **Session view:** the transcript (markdown, thinking folded, tool cards rendered by `kind` with
  diffs and shell output), the requests dock, the queue, the composer, and a header with model, effort,
  permission mode, the context chip ("Context 42%", tooltip "84k of 200k context"), the usage chip (what it
  draws from, and on a plan its fuller window, "Claude plan · Week 63%"; tooltip the windows and
  their resets) and the **Terminal** button. Those two
  chips come last in the row, so on a phone they are what scrolls out of view. Always follow the bottom unless you scroll up.
- **Terminal panel:** full screen on phones, beside or instead of the transcript on desktop.
- **Home** (P5): one ranked inbox: requests, then finished-unread, then working.
- **Responsive:** one layout that works at 375 px. Every action reachable by touch.

### Credentials and billing safety

Settings belongs to a runner and has two subpages in one nav. **Credentials** (`#/settings/credentials`)
holds keys only: **Anthropic API key** for Claude and **OpenAI API key** for Codex. **Azure**
(`#/settings/azure`, below) holds Azure's key, its resource and its deployments, for Codex. All can be
set together. Setting, replacing or
unsetting a key touches no other slot and changes no session's source. There is no enable toggle,
fallback chain or automatic source migration, with one exception you tick per session (**When the
plan runs out**, below). AWS for either harness is backlog only.

**Each session has one billing source**, chosen when it's made and saved with it (`SessionPrefs.source`,
which is a source's name, never a key). New session and the Move dialog show **Source**, listing what
really exists for that harness: a subscription when the harness reports a login (Codex's `account/read`
on the shared daemon, Claude's read-only `auth status`), a key when it's set (Azure: its key, its
resource and at least one deployment), labelled "ChatGPT plan",
"OpenAI API key", "Azure", "Claude plan", "Anthropic API key". With one source it's shown without a
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
no `billingSources` answer are plain text. There is one way in: the ⋯ menu has only Change session harness.

The menu opens with the **plan's usage**, whether the session is on the plan or a key, so you see it
before switching: under the plan's name, each window the harness reported, "Week 64% · resets Nov 5,
6:00 PM", "5 hours 12% · resets 3:10 PM". Unknown is no line. A figure over an hour old says so
("· 3h ago"). Opening the menu asks for a refresh (`refreshPlan`): Codex reads
`account/rateLimits/read`, at most once a minute; Claude has only its latest report. The chip itself
keeps its rule: plan % only on a plan session.

**When the plan runs out.** The menu has a checkbox, "Switch to API key when plan runs out"
(`SessionPrefs.autoKey`, off by default, per session; it doesn't close the menu), shown on a plan
session when a key is set for that harness. With two keys it names its target: the session's last-used
key (`SessionPrefs.lastKey`, set by anything picked on the chip), else OpenAI. This is the only
automatic source change there is, and it exists because you ticked it for that session.

When a turn on the plan ends on the harness's own exhausted signal (`Sink.limitReached`,
`LiveControl.planOut`), the source changes as from the chip, one chat notice says so ("Plan limit
reached. Switched to OpenAI API key."), with when the plan resets if that's known, and the message that
started the turn goes again, once. A Codex switch takes the carry route above, with its cost of
re-sending the history. The loud badge shows as for any key. Push is unchanged.

| Harness | Exhausted | Not exhausted, whatever it says |
|---|---|---|
| Claude | A failed turn with a `rate_limit_event` of status `rejected` that nothing later cleared; or the assistant frame's `error: "rate_limit"` with Claude Code's own text ("You've hit your session limit · resets 8:40am (UTC)"); or, with no error code at all, that text as an error `result` | `rate_limit` with other text (a short 429: "Server is temporarily limiting requests (not your usage limit)", which has no rejection); any other `error` code (`overloaded`, `server_error`, `authentication_failed`…); `api_error_status` other than 429; a stopped turn; a finished one |
| Codex | A `failed` turn whose `error.codexErrorInfo` is `usageLimitExceeded`; or, with no code at all, a message starting "You've hit your usage limit" | Any other code (`rateLimitExceeded`, `serverOverloaded`, `internalServerError`, `unauthorized`, `responseStreamDisconnected`, `responseTooManyFailedAttempts`, `other`…) whatever its text; a retry; a subagent's turn |

Codes come first: text decides only with no code, except that Claude's `rate_limit` code needs its
text, since a short 429 has the same code. The reset is the signal's `resetsAt`, else that of the
fullest window a fresh read shows at 100%.

A turn that had already run a tool or taken a steer isn't resent, since replaying could repeat
edits: the source still changes and the notice says so, leaving you to continue. The same goes for
background work still running, and a turn Tether didn't start. An open terminal keeps the session
where it is and the notice says why, as does no key being set.

It stays on the key until you change it from the chip. It never switches back, and a key session
never comes here: a key that fails stops with the usual error, with no further switch. A queue the
failed turn held goes on after the resend.

On Claude (`capabilities.sourceSwitch`) the next message's process start takes the new source.

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

`credentials.json` is version 3: one slot per key, and `azureSettings` (`endpoint`, `deployments`)
apart from Azure's key, so either can be set first and unsetting the key keeps them. A version 2 file
(Azure's endpoint, one optional deployment and its rates in the key's slot) and a version 1 file (one
`codex` slot) still read, their revisions kept: the one deployment becomes a list of one with its rates,
and rates with no deployment are dropped (they priced whatever model was picked). A deployment saved
before types is Global; its rates, if it had any, become its Override with the same numbers. The file is rewritten
by the next change. A runner from before version 3 can't read it, and disables sending. A web deployed
ahead of its runner gets no `billingSources` answer and hides the picker.

Keys are written only to `credentials.json`, mode 600, under the runner's data directory
(`TETHER_DATA_DIR`, otherwise its existing config/data directory). The runner sends browsers only
set/unset status and optional last four characters, plus Azure's endpoint and deployments. The
browser clears the password field when submitting. Keys never belong in session prefs, summaries,
transcripts, notifications, logs or argv. Subprocesses receive them by private file or environment.
The relay forwards credential RPCs without recording their arguments. Error paths redact submitted
and retired keys; terminal output is redacted before it is encoded for transport.

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
phone width without sideways scrolling; matching composer colour; and markers on Sidebar and Home
rows. Subscription sessions remain quiet. Unknown billing is plainly neutral. Plan usage appears
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
session with a chat error naming it, and nothing is sent; no other deployment stands in. The header's
model menu can't change it: Move does.

### Session names

Clicking a session title opens an inline editor. Enter saves, Escape cancels, and leaving the editor
saves a nonempty change. Names chosen in Tether persist through rediscovery and runner restarts,
and update on every connected device. Renaming starts no harness process.

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
had spent, and plan turns add nothing to it. Subscription sessions show no dollars.

**Where a session's API cost starts.** The first time a session's source is a key, its cost is whole
when Tether knows what it spent on an API before; otherwise it's partial, `earlier-usage`, and stays
so. Known means: a new session (nothing before), a session whose confirmed source until now was the
plan (`state.billing` from the harness, kept across restarts as Claude's `keptBilling` and Codex's
remembered thread), or what the ledger already holds. The chip's switch and the plan running out
(`planOut`) decide it at the switch, while the plan is still what's confirmed; otherwise the first
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
the Changes view and file panel, fallback chains, pi, opencode and other harnesses.

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
