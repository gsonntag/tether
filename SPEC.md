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

Fallback chains and cross-harness handoff, the judge, master context (shared memory),
the MCP registry, cross-harness subagents, `/goal` `/loop` `/schedule` `/review`, plan review,
forks, and libraries (hooks, commands, subagent definitions). Each may come back later as a
module (§3). None of them may require editing the session core.

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
  harness, after the adapters' discovery. Nothing is deleted. A session that is open or live right now
  stays listed, and a hidden session opens by id as usual. Unset, nothing is hidden.
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
  the queue held, "press Resume to continue". During the wait nothing starts Claude: a message you
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
messages, and open requests. **Not** transcripts.

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
settled. Only the reader's input stops following (finger, wheel, keys, scrollbar); a scroll on its own, as when
the composer grows, doesn't.

### Transcript

v1's `Msg` / `Part` model is kept, but trimmed: parts are `text`, `thinking`, `image`, and `tool`
(`id`, `name`, `kind`, `input`, `status`, `output`, `command?`, `path?`, `parentToolId?`).
`kind` (`shell`, `edit`, `write`, `read`, `search`, `fetch`, `todo`, `task`, `other`) is how the UI renders
tool calls from every harness the same way. Messages have roles `user`, `assistant` and `notice`.

Session events: `msg` (upsert by id), `delta` (streamed text), `tool` (patch a tool part), `state`
(patch live state), `reset` (replace the transcript, after compaction).

### Live state

`mode`, `status` (`idle`, `running` or `waiting`), `model`, `effort`, `permissionMode`, `requests[]` (open
approvals and questions), `queue[]` (waiting messages), `terminal?` (attach info), `error?`.

### Core ops

`listProjects`, `listSessions`, `subscribe`, `unsubscribe`, `newSession`, `checkFolder`, `send`, `steer`,
`queue`, `editQueued`, `cancelQueued`, `interrupt`, `answerRequest`, `setModel`, `setEffort`,
`setPermissionMode`, `listModels`, `deleteSession`, `openTerminal`, `closeTerminal`,
`terminalInput`, `terminalResize`, `runShell`, `stopShell` (P5b, §9 Shell commands).

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

### Codex

- **Drive:** the **shared local app-server daemon**, not a private `app-server` process. Its control
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
- **History:** rollout files under `~/.codex/sessions/`, or `thread/read`. The parser comes from v1.
- **Terminal:** `terminal: "shared"`. `codex resume <id>` in the project folder attaches the TUI to the
  same live thread through the daemon. Tether keeps driving; there is no handoff and no read-only mode.
  To verify with a real turn in P4: approval requests reach every connection and clear everywhere
  (`serverRequest/resolved`), and `turn/steer` works from either side.

## 6a. Subagents: precise turns and steering

You can open any subagent and see its exact turns (every message, thought, tool call and result, in
order), live while it runs and afterwards. The parent's tool card links to it, and the session shows
its subagents as children in the sidebar and in the session header.

| | Claude Code | Codex |
|---|---|---|
| Live turns | SDK frames with `parent_tool_use_id` / `agent_id`; set `forwardSubagentText: true` so text and thinking come through, not only tool calls | each subagent is its own thread (`parentThreadId`); its `item/*` events stream like any thread |
| Past transcript | `~/.claude/projects/<dir>/<session>/subagents/agent-<id>.jsonl` (+ `.meta.json`), or SDK `getSubagentMessages`. Thinking isn't saved there, so past thinking is empty | its rollout file, or `thread/read` / `thread/items/list` on the child thread id |
| Stop | `stopTask(taskId)` | `turn/interrupt` on the child thread |
| Steer | via the main agent's `SendMessage` tool (see below) | `turn/steer` on the child thread, as you (verify in P4) |

**Steering Claude subagents** (decided): the SDK can't address a message to a subagent (tested
2026-10-29: `parent_tool_use_id`, `agent_id` and `priority` on a pushed user message all go to the main
thread). Instead the subagent's message box steers the main agent with a tight instruction to call
Claude's own `SendMessage` tool to the subagent's agent id with exactly your text. The message shows in
the subagent's view marked "Sent via the main agent", delivered once the `SendMessage` call is seen,
or "Not delivered" if the main agent's turn ends without it. This is an implementation detail behind
`steer: "via-parent"`, so it can be swapped for a native path if the SDK ever adds one.

Adapter capabilities: `subagents: { view: boolean; stop: boolean; steer: "direct" | "via-parent" | false }`.
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

## 8. Terminal mode

### What the button does

The **Terminal** button on a session opens the harness's real TUI, mirrored in the browser
(xterm.js), resumed on the same session. While it's open, the structured view stays visible as a
**read-only live transcript** (tailed from the store) with a banner: "Driving in the terminal".

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
  permission prompt or a question shows, `Elicitation`, `Notification`), with what Claude waits for
  ("Claude needs your permission to use Write", "Claude is asking you something."), and pushed as
  ever. It clears only on evidence (the TUI's screen shows its prompt again, no dialog, for a few
  seconds) or when the TUI is left; a hook never clears it.
- **Settings as last seen**: the mode the hooks last reported; the model and effort chips are
  disabled ("Set in the terminal (last seen: …)").
- **Messages wait**: the composer never types into the TUI; what you send goes to Tether's queue,
  held "terminal", and is sent after Back to Tether.

**Back to Tether (terminal → live).** A "Back to Tether" button always asks first: "Close Claude Code
in the terminal? If it's still working, that turn stops and anything in its own input queue is
lost." Then:
1. It quits the TUI cleanly: `/exit` when it sits at an empty prompt (Tether hides the command and its
   goodbye in the transcript), else Esc and Ctrl-C; it kills the tmux session after 5 seconds.
2. It resumes the driver on the same `nativeId` from the store, so whatever the TUI finished shows,
   with the mode and model as last seen. The mode becomes `live`; the held queue goes out.

If the TUI exits by itself (you typed `/exit`), the mode becomes `stored`.

### Project shells

The terminal panel has tabs: the session's TUI, then the project's shells. **+** opens a plain
`$SHELL` in the project folder (`tmux -L tether` window `shell:<projectKey>:<n>`). Shells belong to the
project, not the session. They persist across closing the panel and runner restarts until you close
them (× on the tab, or `exit`), so a dev server left running is still there next time.

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
- On desktop the panel sits beside the transcript, and the sidebar's and the panel's inner edges
  drag to change their width (arrow keys too; a double click goes back to the default). The widths
  are kept per device; the transcript never gets narrower than 300 px, and the terminal refits as
  it goes. Phones have no handles. On a phone it is full screen, with a **Chat**
  button that tucks it behind the transcript (still attached, the shell untouched) and a pill
  ("Back to the shell", "Back to Claude Code") that brings it back in one tap. While open, ❯_
  closes the panel.
- **Copying.** On desktop, a drag selects in a terminal even while tmux takes the mouse, and letting
  go copies the selection at once and leaves it on screen (nothing shows, nothing reaches the
  terminal; a blank selection copies nothing). A plain press waits to see whether it moves: a click
  still goes to tmux, press and release, so programs inside get clicks, but no longer a plain drag.
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
- **Phone:** a key bar above the keyboard (Esc, Tab, ↑, ↓, Ctrl-C, Ctrl-D, Enter) and a line under
  it that types its text into the terminal in front, then Enter, as a keyboard would. Tether's
  composer never types into a handoff TUI (its messages wait for Back to Tether).

### Requests and notifications in terminal mode

- **Codex (shared):** Tether stays attached to the thread, so requests, status and notifications work
  as in live mode.
- **Claude (handoff):** approvals are answered **in the terminal**, by the TUI itself. To keep
  "Needs you", its push and Home working, the runner launches the TUI with `--settings` adding hooks
  that report to the runner's local socket (`PermissionRequest`, `Elicitation`, `Notification`, and
  `SessionStart` to follow /clear). A runner restart readopts the TUI as "Driving in the terminal";
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
- A steer can't be taken back once the harness has it.
- Desktop keys: Enter send or steer, Tab queue (when the box has text), ⌘/Ctrl+Enter stop and send now,
  Shift+Enter newline, Esc stop (empty box). On phones Enter is a newline and buttons send.
- **Shell commands** (P5b): text starting with `!` is a shell command (below).
- **Attachments** (images and files, by paste, drop, picker or camera) are in the core because phone
  screenshots are a main use. Chunks go over RPC and are stored under
  `~/.config/tether/attachments/<session>/`. They go to the harness natively where supported, and as
  paths otherwise.

### Shell commands (P5b)

`!npm test` in the composer runs **right away** as a one-off `$SHELL -c` in the session's folder,
on the runner, even while the agent is mid-turn (`runShell`). It gets no stdin and has no time cap;
it runs in a process group of its own and gets the runner's environment without Tether's secrets.
At most 5 run at once per session (counted as they start, so commands sent together can't pass it).
Only the owner can run one (the same auth as sending).

- **Composer:** once the text starts with `!` the box visibly becomes a shell prompt (monospace,
  green, a "Shell" hint saying where it runs and when the agent gets the output) and Enter (or
  **Run**) runs it, whatever the agent is doing. A ❯ toggle in the composer adds or removes the
  leading `!`, which is the way in on a phone. Attachments wait for the next message.
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
  whole, then stripped, and so is every other control character but tab and newlines (NULs and
  binary output never reach the card or the agent, so frames stay under 200 KB).
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
  permission mode and the **Terminal** button. Always follow the bottom unless you scroll up.
- **Terminal panel:** full screen on phones, beside or instead of the transcript on desktop.
- **Home** (P5): one ranked inbox: requests, then finished-unread, then working.
- **Responsive:** one layout that works at 375 px. Every action reachable by touch.

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
composer into the PTY, hooks for turn-end and "needs you", the stop-and-open prompt with held queued
messages, project shells.
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
the Changes view and file panel, fallback chains, pi, opencode and other harnesses, `/goal` etc.

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

Still to verify by experiment (not decisions): Codex approval fan-out and cross-connection steer
(P4), and how daemon and CLI version mismatches behave.

## 14. Working agreement

- I build P0 through P5 autonomously, testing as I go. I don't wait for manual testing between
  phases. I report when everything is done, or earlier only if I'm blocked on a decision that's
  yours or on something I'm not allowed to do.
- Allowed without asking: commit, push to `main` (which deploys once the app follows it), the cutover
  at the end of P1, real test turns on cheap models, an isolated dev runner and tmux socket.
- Ask first: anything that spends notable quota on expensive models; anything outside this project.
