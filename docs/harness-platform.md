# Harness platform: connectors, Tether-owned features, strict fallback

Status: Phases 0-4 built on branch `harness-platform` (14 commits, 2026-10-11/12), not merged,
deployed or run against live harnesses; only stubbed-harness tests pass. Every Phase 4 row is built
(plan + todos, `ask_user`, loops and schedules, fork, `/review`, `/compact`, hooks), and so are the
Phase 2 "later slots" (commands, subagents, env/secrets). Not built: the "when CI finishes" trigger
(Phase 4 loops), a real Driver/Connector split, bundling pi-mcp-adapter, per-session MCP for
Antigravity, and `splitModelRoute` (Phase 0; it is in uncommitted work in the main checkout). What
was built, emulated or left unsupported per harness is in "Implementation notes" at the end; the
Decisions section overrides the plan text above it.

Phase 5 (cross-harness subagents) built on branch `xh-subagents` (2026-10-14), stub-tested only;
its status is at the end ("Phase 5: status").

Synced with master on 2026-10-14 (merge of `origin/master` at 686017d: plan review v2, sessions
model, uiPrefs, tool kinds, force send, Add project). Master's plan review (`LiveState.plans`,
`planReview.ts`, `~/.config/tether/plans/`) sits beside this branch's session plan
(`LiveState.plan`, saved in the session's prefs); Tether's own review card takes its Discuss (the
plan stays under review and comes up again after the agent answers) and auto-approval. Review
sessions stay out of the Working / Needs you / Recent lists; Tether's loops and schedules count as
"Scheduled" on Home. Force send runs Tether's commands like a normal send.

## Goal

The user configures things once, in Tether, and every harness gets them. Linking an MCP server,
adding a skill, setting a goal or a secret works the same in claude-code, codex, pi, opencode, kiro
and antigravity, and survives a fallback handoff from one to another. Where a harness lacks a
feature, Tether either provides it itself or says plainly that it's unavailable there.

## Where we are (audit 2026-10-11)

- `Adapter` (runner/src/adapters/types.ts) covers only create/resume/history/models. Everything
  else is wired by hand inside each adapter, so coverage is uneven.
- runner/src/context/ already shares memory, skills and the `tether-context` MCP server across all
  six harnesses. It is the seed of the connector layer.
- The user's own MCP servers are not shared at all (today `foliation` exists only in Claude, scoped
  to two repos). Nor are custom commands, subagent definitions, hooks, env/secrets or plugins.
- Per-harness gaps worth fixing regardless:
  - Antigravity gets no per-session MCP (global config only).
  - pi needs `pi-mcp-adapter` for any MCP.
  - Kiro is missing from the skill dirs (`skills.ts:47-57`).
  - Skill dirs aren't watched.
  - Codex declines every MCP elicitation (`codex.ts:768`).
  - `splitModelRoute` splits any `/` in a model id (uncommitted codex.ts).
  - `docs/master-context.md` still says "Not built yet".
- Fallback switching (session.ts:899-956) triggers on a regex over error text and has no tests
  beyond `classify`/`pickEntry`.

## Principles

1. **Per-session injection first.** A Tether session gets everything at launch through the harness's
   launch API (SDK options, ACP `newSession`, codex `-c`, CLI flags). Writing harness-global config
   files is a separate, opt-in export for using the CLIs outside Tether.
2. **Tether owns state that must survive a handoff** (goal, plan, schedules) or where working across
   harnesses is the point (review, fork). It delegates what lives deep in the agent loop (subagents,
   tools, web search, native compaction) and only displays it.
3. **Native when good, emulated otherwise.** Each connector declares, per capability, `native`,
   `emulated` or `unsupported`; the UI renders one consistent picture from that.
4. **Never switch providers on a guess.** Only a definite limit signal moves a session.

## Phase 0: groundwork (small, no behaviour change)

- Fix the per-harness gaps listed above, except Antigravity MCP (Phase 2).
- Unit tests for `handleTurnError` / `preferBest` / `waitThenContinue` with a fake adapter.

## Phase 1: strict fallback + fault injection

**Trigger rule.** A provider is marked exhausted only when one of these holds:
1. A structured signal from the harness:
   - Claude `rate_limit_event` `status: "rejected"`
   - Codex `codexErrorInfo: "usageLimitExceeded"`
   - Antigravity's exact "Individual quota reached … Resets in …" message
   - Kiro: TBD after capturing a real one
2. The error looks like a limit, and an immediate fresh usage fetch for that *account* confirms a
   window at 100% / `limit_reached`. Claude and ChatGPT accounts are checkable no matter which
   harness uses them, e.g. pi on the ChatGPT login.

Otherwise:
- **429/overloaded:** back off on the same model, never switch.
- **Anything else:** an error notice with a "Continue on <next>" action. No automatic switch.

Details:
- `classify()` becomes "possible limit → verify", not the trigger.
- Claude `billing_error` stops counting as quota.
- A chain entry can switch automatically only if its account is verifiable; others are manual-only,
  shown as such in the chain editor.
- **Pre-emptive switch at the turn boundary** when a verifiable window is ≥ the threshold. This
  avoids most mid-turn switches.
- Waiting sessions survive a runner restart: re-arm `waitThenContinue` from persisted
  `waitingUntil`.
- **Mid-turn handoff hygiene:**
  - The brief says the previous agent was interrupted mid-task and to inspect the working tree
    before continuing.
  - Open approvals and questions on the old session are cancelled and noted in the brief.
  - Background tasks on the old session are listed in the brief; still undecided whether they are
    stopped (see open questions).

**Fault injection** (dev only, behind `TETHER_DEV=1`):
- `/tether simulate-limit <quota|rate|other> [after <n> tools] [reset <dur>]` makes the adapter
  report its harness's real error shape on the next turn: Claude rejected event, Codex
  `usageLimitExceeded`, Antigravity's message, pi's provider error.
- A fake usage source lets the verification step be steered too.

**Test matrix** (on a test runner: local app, empty `TETHER_CONFIG_DIR`, `TETHER_NO_RESUME=1`,
distinct runnerId):
- Same-harness model switch: before the turn, mid-turn.
- Cross-harness handoff for each from→to pair that matters (claude↔codex first), mid-turn, with:
  - a half-done edit
  - a running background shell
  - a pending approval
  - an open question
- Whole chain exhausted → wait → reset → continue; same with a runner restart while waiting.
- `preferBest` moves back up after a reset.
- Unverifiable error text containing "billing" / "resets in" → no switch.

## Phase 2: connector interface + MCP registry

**Interface.** Split today's adapter into:
- **Driver:** turns, streaming, interrupt, steer, approvals, models/effort, history, usage.
  Roughly today's `Adapter` + `LiveSession`.
- **Connector:** maps canonical Tether config onto the harness. It has slots `mcp`, `skills`,
  `memory`, `commands`, `agents`, `hooks`, `env`, and each slot implements:
  - `capability()`
  - `forSession(ctx)` returns the launch args/options
  - optional `exportGlobal()` / `importGlobal()` for native CLI config

Move the existing context/ wiring (memory, skills, `tether-context`) behind it first: a pure
refactor.

**MCP registry.**
- **Store:** the canonical server list lives in Tether's config. Stdio and http servers, env and
  headers referencing Tether secrets.
- **Import:** read every harness's MCP config: `~/.claude.json` (user + per-project),
  `.mcp.json`, codex `config.toml`, opencode, pi `mcp.json`/adapter, kiro, antigravity, gemini.
  Duplicates are merged by command/url.
- **Injection per session:**
  - Claude SDK `mcpServers`
  - Codex `-c mcp_servers.*`
  - ACP `newSession.mcpServers`
  - pi `--mcp-config` (or bundle `pi-mcp-adapter` if it's missing)
  - Antigravity: no per-session path, so write its global config (the one harness that needs it)
- **Disabling native copies:** avoid double-loading the same server where a harness also reads its
  own config. Dedupe by name; Claude `strictMcpConfig` when Tether supplies the full set.
- **Scope:** global, or per repo. A server linked "for this repo" replaces project-scoped
  `.mcp.json` without writing into the repo.
- **OAuth:** Tether holds the tokens (one auth per server, not per harness) and passes them as
  headers. Servers that need a browser flow get an "Authorize" action in the UI.
- **Guard:** tools from registry servers go to the judge like today. A per-server "trusted"
  switch auto-allows.
- **UI:** an "MCP servers" section next to Memory & Skills: list, add (paste a command/url or
  JSON), per-server on/off, and which harnesses got it.

**Later slots, same pattern.** Custom commands (`~/.claude/commands`, `~/.codex/prompts`, opencode
`command/`) become Tether commands. Subagent definitions translate where the harness supports them.
Env/secrets are injected into every agent and MCP process. Hooks are run by the guard (Phase 4).

## Phase 3: /goal

Modelled on the Claude/Codex goals; pi's goal extension is not used in Tether sessions.

- **State on the Tether session:**
  - objective
  - status (`active | paused | done | blocked | budget`)
  - budget (turns, tokens, wall time)
  - progress notes

  It carries across handoffs. `session.goal()` (used by the guard judge) reads it.
- **Driving:** the model reports through `tether-context` tools `goal_get` / `goal_update(status,
  note)`. When a turn ends with the goal still active, Tether sends a continuation prompt. A
  background-model check is the backstop for a model that never reports, or reports done falsely.
- **Native passthrough:** where Claude/Codex have native goals, Tether mirrors its goal into theirs
  and syncs status back; Tether's copy stays the source of truth.
- **Steering:** ACP/Antigravity can't steer, so continuation always waits for the turn to end
  (true of the emulated loop anyway).
- **Stops:** budget hit, a pending approval/question, or `blocked`. Each raises a Needs-you item and
  a push notification. "Done" raises one notification.
- **UI:** `/goal <text>`, `/goal pause|resume|clear`; a goal line at the top of the session with
  status and budget used.

## Phase 4: more Tether-owned features (pick order later)

| Feature | Why Tether owns it | Shape |
|---|---|---|
| Plan + todos | survives handoff; uneven natively | one session plan via MCP; guard-enforced "approve before edits" on every harness |
| Loops/schedules | Claude crons die with its process | `/loop`, cron, "when CI finishes" run by the runner, survive handoff and restart |
| Fork | no harness has it wired | fork from any message into any harness/model using the brief builder |
| `/review` | cross-harness is the point | a different harness/model reviews the session's diff, findings inline |
| `/compact` | missing on ACP/agy | restart the session on a Tether brief |
| `ask_user` | only Claude/Codex have question cards | MCP tool → question card on every harness |
| Hooks | guard sees every tool call already | user Pre/PostToolUse + Stop hooks run once by the guard, for all harnesses |

## Order and workflow

0 → 1 → 2 (interface, then MCP registry) → 3 → 4.
- Phase 1 and the interface half of Phase 2 can run in parallel.
- Each phase is one implementation subagent plus a separate review subagent, two at a time.
- No merge, deploy or runner restart without the user's go.

## Decisions (user, 2026-10-11)

1. **Global export: yes.** Linked MCP servers are written into each harness's own global config as
   well as injected per session.
2. **Precedence:** a server present both in Tether and natively needs no action. Leave the native
   entry alone and don't inject a duplicate.
3. **No pre-emptive switching.** Switch only once a limit is hit. A threshold setting is a future
   improvement.
4. **No visibility, no switching.** Chain entries whose account usage Tether can't verify never
   switch automatically.
5. **Background tasks on a mid-turn handoff:** stop them on the old session; the brief lists them
   and tells the new agent to restart the ones still needed.
6. **Goal carries over** on a handoff.
7. **No default goal budget.** A goal runs until it's done. An optional user budget is allowed.
   A no-progress guard marks it `blocked`: several consecutive turns with no tool calls, no diff
   change and no `goal_update`.
8. **MCP OAuth tokens live in Tether:** the runner's config dir, mode 600. They are never written
   into harness configs; they are injected as headers at launch.
9. **Antigravity switches automatically (2026-10-12)** on its exact "Individual quota reached … Resets in …"
   message, even without a usage feed. This is an accepted exception to Decision 4.
10. **Held calls need a second yes (2026-10-12).** "Run it myself" or "Approve & retry" on a call held back
    by plan mode or a review asks to confirm first ("Run anyway" / "Approve anyway").

## Open questions (answered above, kept for context)

1. **Global export.** Should linked MCP servers also be written into each harness's native global
   config (so `claude` / `codex` in a terminal see them), or Tether sessions only? Per-session only
   is safer; global is "no config" for the CLIs too.
2. **Native config precedence.** If the user's own `~/.claude.json` has a server Tether also has,
   which wins? Suggestion: Tether's, and import turns native entries into registry entries.
3. **Pre-emptive switch threshold.** 98%? Off by default?
4. **Unverifiable chain entries.** pi on an API key, opencode, Kiro until its error is known:
   manual-only switching, or allow regex-based switching as an explicit per-entry opt-in?
5. **Background tasks on a mid-turn handoff.** Stop them, or leave them running and tell the new
   agent?
6. **Goal across handoff.** Carry automatically, or pause and ask?
7. **Goal budget defaults**, and whether the backstop judge runs every turn (costs quota) or only
   when the model claims done.
8. **Where MCP OAuth tokens live** (runner config dir, 600 perms?) and whether they sync between
   runners.

## Implementation notes (2026-10-12)

Built on `harness-platform` in fourteen commits: Phase 0, Phase 1 strict fallback, Phase 1 fault
injection, Phase 2 connector interface, Phase 2 MCP registry, Phase 2 MCP OAuth, Phase 3 /goal, a
follow-up that closes gaps from the Phase 0-3 review ("Review follow-up (f1)" below), then six
Phase 4 units (4a plan/todos/ask_user, 4b loops and schedules, 4c fork and /compact, 4d /review,
4e hooks, 4f commands/subagents/env). Runner (881 tests), web and server tests pass with stubbed
harnesses only; nothing here has been run against live harnesses, looked at in a browser, or
deployed. The MCP sign-in callback needs the server deployed; everything else is runner + web.

**Phase 0.** Kiro skills (`~/.kiro/skills`, linked only when `~/.kiro` exists), watched skill dirs
(with a 10-minute backstop pass and a per-dir watch until `SKILL.md` appears), Codex MCP
elicitations (tool approvals go to the guard; forms become question cards; URL mode becomes a
confirm card), `docs/master-context.md` updated, fallback unit tests. `splitModelRoute` is not on
this branch: it is in uncommitted work in the main checkout.

**Phase 1.** `classify()` only means "possible limit, verify". Definite signals: Claude
`rate_limit_event` rejected (ignored while overage is in use), Codex `usageLimitExceeded`,
Antigravity's "Individual quota reached … Resets in …". Otherwise a fresh usage fetch for the
account must show a window at 100%. Verifiable accounts: Claude Code, Codex (ChatGPT login), pi on
`openai-codex/*` (its own ChatGPT login). Transient 429/529/503 back off on the same model. Any other
error gets an inline "Continue on <next>" button; using it skips the old entry for that session
only. No pre-emptive switching (Decision 3). Waits survive a restart (`waitingUntil`). Mid-turn
handoffs cancel open approvals/questions, stop background tasks where the harness allows it, and
the brief lists both. Dev-only fault injection (`TETHER_DEV=1`): `/tether simulate-limit`,
`/tether simulate-usage`, `/tether exhausted`; checklist in `docs/fallback-testing.md` (not yet run).

**Phase 2.** Connectors live in `runner/src/connectors/` with slots `mcp`, `skills`, `memory`,
`commands`, `agents`, `hooks`, `env`, `goal`. Driver and connector were not split: adapters call
`sessionLaunch()`. `commands`, `agents`, `hooks` and `env` declared a capability only (hooks were
mapped in p4e, the other three in p4f). The MCP registry (`$TETHER_CONFIG_DIR/mcp/servers.json`, mode 600) imports from every
harness, dedupes by command/URL, injects per session, and exports enabled global servers into each
installed harness's global config (Decision 1) through a ledger of the exact entries Tether wrote.
A server the harness already has natively is neither injected nor exported there (Decision 2).
Repo-scope servers are injected per session only. A per-server "Trusted" switch auto-allows its
tools in the guard. OAuth for http/sse servers runs in the runner (discovery, DCR or a hand-entered
client, PKCE); tokens stay in `mcp/tokens.json` (mode 600) and go out as headers at launch
(Decision 8). The sign-in callback is a server route, `/api/mcp-oauth/callback`. UI: an "MCP
servers" section on the Memory page, and a read-only "Harness support" table (the capability
matrix) below it.

**Phase 3.** `/goal <objective> [--turns n] [--tokens n] [--time d]`, `/goal status|pause|resume|clear`,
handled by the runner on every harness. State on the session (`SessionPrefs.goal`), carried across
handoffs (Decision 6; the old session's goal is paused). Tools `goal_get` / `goal_update` in
`tether-context`, which every keyed session now gets (goal-only while the master context is off).
Continuation prompts after each turn; a background-model check confirms "done" claims, runs after
3 turns with no tool call, no tree change and no `goal_update` (Decision 7: blocked unless the check
finds it done), and runs every 5 goal turns in any case (done / continue / blocked). No default budget. A goal line sits at the top of the session view.

**Review follow-up (f1).**
- MCP scope is "global" or a list of repos (`scope: string[]` of `repo:<key>`; the old single
  `repo:<key>` string is read as a one-repo list). A server found in several repos (Claude's
  per-project entries) is linked to each, so `foliation` reaches both of its repos everywhere;
  pasting a server for another project adds that repo. The MCP list shows one token per repo.
- Claude: registry stdio servers with env values are held off the `claude` command line like
  http headers; the full set goes over stdin with `setMcpServers` before the first message
  (`tether-context` stays on argv: its env is paths and the guard key).
- Goal: besides "done" claims and stalls, the background model checks every 5 goal turns
  (`GOAL_CHECK_EVERY`) and answers done / continue / blocked; done or blocked stops the loop.
- pi: Tether launches pi with `--no-extensions` and `-e <path>` for every extension pi itself
  would load (asked from pi's own package manager, `connectors/piResolve.ts`), minus goal
  extensions (`pi-goal-x` here). Not applied in a project with its own `.pi/settings.json` or
  `.pi/extensions` (pi's project trust step), or when pi's answer can't be had; then pi-goal-x
  loads alongside Tether's goal tools, and Tether's loop still drives the goal.
- Rate-limit wording (pi's "ChatGPT usage limit … Try again in ~N min", an Anthropic 429) is
  checked against the account's usage when it has one. On an entry without one, the session backs
  off 3 times, then the error shows with "Continue on …" (still no automatic switch); your own
  next message starts a fresh run of retries. "Checking usage on …" shows inline in the chat while
  the check runs.
- A Codex model routed to another provider (`provider/model`, provider ≠ `openai`) has no
  verifiable account: manual only, its own quota key `codex:<provider>`.
- Runner code reads the home through `home.ts` (`$HOME` first); a test checks that nothing else
  calls `os.homedir()`.
- A "Harness support" table on the Memory & Skills page renders the capability matrix (features
  × installed harnesses; Native / Tether / Not available, the note on hover).
- Capability notes corrected: Codex 0.162 has no custom-prompt loader left (skills are its
  commands; older versions read `~/.codex/prompts`), Claude and opencode get registry servers in
  their global config on every change, and opencode/Kiro notes say they're unverified.
- The server's OAuth relay (`askRunner`, `/api/mcp-oauth/callback`) has a test with a fake
  runner socket.

| | MCP per session | MCP global export | MCP OAuth token | Skills | Memory | Stop bg tasks on handoff | Limit signal | Auto-switch | Goal |
|---|---|---|---|---|---|---|---|---|---|
| Claude Code | native (SDK `mcpServers`; headers and stdio env via `setMcpServers`, not argv) | `~/.claude.json` | header, swapped live on refresh | native | native | yes (`stopTask`) | rejected `rate_limit_event` + usage check | yes | emulated (its own `/goal` has no status/pause API, hidden from the menu) |
| Codex | native (thread `config["mcp_servers.*"]`; no SSE) | `config.toml` managed block | header at launch only | native | native | subagents only; background terminals can't be stopped | `usageLimitExceeded` + usage check | yes (manual only for a model routed to a non-OpenAI provider) | native mirror (`thread/goal/*`), Tether's copy is the source of truth |
| pi | native only with pi-mcp-adapter (`--mcp-config`), else unsupported | `~/.pi/agent/mcp.json` | header at launch, only with the adapter | native | native | no (listed in the brief) | text only; usage check on the ChatGPT login; elsewhere 3 backoffs, then the error with "Continue on …" | ChatGPT login only | emulated; goal tools need pi-mcp-adapter; pi's own goal extension is left out (`--no-extensions` + every other extension by path), except in a project with its own pi settings or extensions |
| opencode | native (ACP `mcpServers`; http/sse only if advertised; unverified) | opencode config | header at launch | native for listed commands, else expanded | emulated (preamble) | no | none | manual only | emulated |
| Kiro | native (ACP; unverified) | `~/.kiro/settings/mcp.json` | header at launch | native for listed commands, else expanded | emulated (preamble) | no | none captured | manual only | emulated |
| Antigravity | unsupported (global config only, no repo-scope servers) | `~/.gemini/config/mcp_config.json` (+ Gemini CLI `settings.json` if present) | none (signs in by itself, if it can) | emulated (expanded) | emulated (preamble) | no | exact quota message | yes (reads the message as the signal) | emulated; goal tools only if its global tether-context reaches the bridge |

**Phase 4a: plan, todos, ask_user.**
- State: `LiveState.plan` (`SessionPlan`: markdown, todos, status draft / review / approved /
  feedback, the plan part showing it), saved with the session (an open review comes back as draft
  after a restart). Tools in `tether-context`, which every keyed session has (also while the master
  context is off): `plan_get`, `plan_set(markdown)`, `todo_set(items[{text,status}])`,
  `ask_user(question, options?, multiSelect?)`, over the bridge's new `/session` route (`/goal` kept
  for older processes). The MCP server now handles calls concurrently, cancels a call on
  `notifications/cancelled` and sends progress every 30 s while ask_user waits.
- Rendering: `plan_set` adds the existing plan card (rewritten in place within one turn until
  reviewed); `todo_set` the existing todo card (TodoWrite shape, updated in place until you write
  again). The harness's own plans (ExitPlanMode, Codex plan items, agy) and todo lists (TodoWrite,
  Codex `turn/plan/updated`, ACP plan checklists) are recorded as the session's plan as they go by.
- Review gate: Claude Code and Antigravity keep their own. Codex and ACP plan modes (and pi's new
  Tether "Plan" mode, `PI_MODES`) get Tether's review card when a plan-mode turn ends with a plan:
  `plan_set`, a Codex `plan` item, or (pi, ACP) the turn's last reply turned into a plan card. While
  planning or waiting for review the guard denies anything that would change something (`plan.ts
  mutates`: edits except `plans/*.md`, non-read-only shell, other MCP and unknown tools) with a
  reason telling the agent to call plan_set and end its turn. An ACP agent leaving plan mode by
  itself gets the same hold until its plan is approved. Approve leaves plan mode (Codex Default, the
  ACP mode it came from or its first non-plan mode, pi Default) and sends "Implement the plan."
  (Codex's own words); "Send feedback" sends the comments as a message and stays in plan mode.
  Plan review's Discuss sends the comments as a message without a verdict: the agent's answer is
  not taken as a plan, and the plan being discussed goes up for review again when the turn ends.
- ask_user: the existing question card on every harness, blocking until answered; with the guard
  on Auto or Dangerously skip it gives up after 15 minutes like Claude's AskUserQuestion ("Nobody
  answered…"). Harness MCP timeouts raised for `tether-context`: Claude `timeout` 24 h, Codex
  `tool_timeout_sec` 86400 (also in its global block), pi-mcp-adapter `timeout` 86400 s.
- Handoff: a "## Plan" section in the brief (status, plan, todo list), and the new session adopts
  the plan (its plan and todo cards shown again).

| | Plan review | Todos | ask_user |
|---|---|---|---|
| Claude Code | native (ExitPlanMode) | native (TodoWrite) + todo_set | native (AskUserQuestion) + ask_user |
| Codex | emulated: review card after a plan-mode turn | native (turn/plan/updated) + todo_set | native (request_user_input) + ask_user |
| pi | emulated: Tether Plan mode, guard-enforced | todo_set (needs pi-mcp-adapter) | ask_user (needs pi-mcp-adapter) |
| opencode | emulated: review card, changes held until approved (unverified) | native (ACP plan) + todo_set | ask_user |
| Kiro | emulated where it has a plan mode (unverified) | todo_set | ask_user |
| Antigravity | native (Tether holds its first change) | todo_set only via its global tether-context | ask_user only via its global tether-context |

**Phase 4b: loops and schedules.**
- Commands, handled by the runner on every harness (never sent to it): `/loop <interval> <prompt>`
  (`10m`, `1h30m`, `1d`, optional `every`; at least 1 minute; the first run is immediate),
  `/loop` / `/loop list`, `/loop stop [n|all]`; `/schedule <5-field cron|@daily…> <prompt>` (runner
  local time, quotes allowed around the expression), `/schedule at [today|tomorrow|YYYY-MM-DD]
  <15:00|3pm> <prompt>`, `/schedule in <duration> <prompt>`, `/schedule` / `list`, `/schedule
  delete <n|all>`. A prompt can be a `/skill` but not `/loop`, `/schedule` or `/goal`. At most 20
  per session. They replace Claude Code's own `/loop` and `/schedule` in the `/` menu.
- State: `LiveState.schedules` (`SessionSchedule`: kind loop / cron / once, prompt, label, nextAt,
  runs), saved in the session's prefs in runner.json. Missed runs (runner down, session busy) are
  skipped, not caught up: one run, then the next on the loop's grid or the cron's next match.
- Timer: one runner-wide `Scheduler` (`runner/src/schedule.ts`) armed for the soonest run of any
  session (re-checked hourly), over live sessions' state and the stored prefs of closed ones. A due
  run in a closed session opens it (`getLive`, now deduplicated so a browser and a run can't open
  two processes); one that can't be opened is skipped and the stored schedule moves on. Started
  after `resumeActive`; with `TETHER_NO_RESUME` only sessions the runner has open run theirs.
  Sessions marked done are left out: their runs wait and run once (then on schedule) when the
  session is back. `/loop` and `/schedule` in a handed-off session are refused.
- Delivery: a run is a queued (`followUp`) message in `pending`, tagged `scheduleId`. Idle with
  nothing waiting on the user: it starts a turn at once; busy, waiting on a limit, or a question /
  plan review open: it waits (the turn's end drains it; an answered question sends it). Held
  after Stop, your messages stay held but the loop doesn't stop: a run that comes due afterwards
  goes alone (a run of it already waiting collapses into it). While one run waits, more runs of
  the same schedule collapse into it, and an idle session sends it. A restart re-queues a waiting run with its tag. Loop turns
  don't send the per-turn "Finished" push; one-off and cron runs do.
- Handoff: schedules move to the new session (`adoptSchedules`; the old one keeps none, also
  after a reload), and a waiting run moves with the rest of `pending` (merged with runs the new session queued
  during the brief turn, collapsing runs of the same schedule). The brief doesn't mention
  them: the runner, not the agent, runs them.
- UI: a compact line per loop/schedule under the goal line (kind, label, next run, prompt, one
  click to stop/delete via the `deleteSchedule` op); queued runs show a "Loop"/"Schedule" token;
  Home: `SessionPulse.nextRun`, "Next run 14:20" in the running row, and a live session with a
  schedule counts as running (like an armed wakeup). Capability matrix: new `schedules` slot.

| | Loops and schedules |
|---|---|
| Claude Code | Tether's (emulated). Its own CronCreate / ScheduleWakeup / `/loop` crons stay as they are and show as activity; they fire only while its process runs (durable crons from `.claude/scheduled_tasks.json`, recurring ones expire after 7 days) |
| Codex | Tether's; the app-server has no scheduling requests (`ScheduledTaskSummary` only describes a plugin's tasks) |
| pi | Tether's; pi has no scheduler |
| opencode, Kiro | Tether's (queued messages; unverified, not installed) |
| Antigravity | Tether's |

**Phase 4c: fork and /compact.**
- Fork: a "Fork from here" button on your messages and finished replies opens a dialog (harness,
  model, an optional message). Runner op `forkSession` → `runner/src/fork.ts runFork`. The new
  session is in the same directory with the conversation up to and including that message; on one
  of your messages it keeps what came before and sends that message again (plus anything added), so
  the new agent answers it anew. Linked back through `LiveState.forkedFrom` (saved in prefs), shown
  like `handoffFrom` ("Forked from …"); its title is the source's plus " (fork)". Goal, plan,
  schedules, pending messages and the fallback chain are not carried: the original goes on.
- Native when the target is the same harness and a fork point exists (`LiveSession.forkPoint`, from
  `forkMarks` the adapters record live and from history): Claude Code `forkSession(id, { dir,
  upToMessageId })` at the message's last transcript entry (its tool results included; Tether's own
  user messages now go to Claude Code under their own uuid so they can be cut at), then resumed;
  Codex `thread/fork { lastTurnId }` only where a turn ends and not through the running turn. A failed
  native fork falls back to the brief. Otherwise: a new session seeded with `buildBrief({ kind:
  "fork" })` (memories carried as in a handoff, but no capture: the source goes on, and capturing
  over a prefix of it would move its watermark back), which says the files may include later
  changes; with no message it is told to catch up and wait. A fork at the very first message is a
  plain new session. Images a harness kept inline in your message (Claude Code, pi, ACP history) are
  stored with the source's attachments (`storeInlineImage`) and sent again as attached files; an
  image-only message is asked again too.
- `/compact [focus]` (a Tether command on every harness, `compactCommand`): refused while the agent is
  busy or the session was handed off. Native: Claude Code's own `/compact <focus>`, pi's `compact`
  RPC (`customInstructions`), Codex `thread/compact/start` (no focus parameter, so with a focus Codex
  goes the emulated way), an ACP agent's own `compact` command when it lists one. Emulated
  (`handoffRun.ts runCompact`): `runHandoff` onto the same harness and model with `buildBrief({ kind:
  "compact", focus })`, so goal, plan, schedules and waiting messages move like a handoff; the old
  session is marked done (out of the sidebar) and closed, the new one keeps its title. Refused while
  background tasks run (the restart would stop them). While the new session starts, an inline notice
  says so, messages you send wait (and move over; if the restart fails they go out on the old
  session), scheduled runs don't start, and a second /compact is refused. Compaction turns send no "Finished" push and
  never turn into a plan review.
- Capability matrix: new `fork` and `compact` slots ("Fork from a message", "Compact (/compact)").

| | Fork | /compact |
|---|---|---|
| Claude Code | native into Claude Code (forkSession, any message); brief into others | native (its /compact, focus included) |
| Codex | native into Codex where a turn ends (thread/fork lastTurnId); brief elsewhere | native (thread/compact/start); with a focus, Tether's restart |
| pi | brief (its fork RPC only branches before a user message, inside the running process) | native (compact RPC, focus as instructions) |
| opencode | brief (ACP's unstable session/fork has no message point) | native if it lists /compact (unverified), else Tether's restart |
| Kiro | brief | Tether's restart, unless it lists /compact (unverified) |
| Antigravity | brief | Tether's restart |

**Phase 4d: /review.**
- `/review [harness[:model]] [focus]` (a Tether command on every harness, `reviewCommand`; `/review
  codex`, `/review codex:gpt-6-sol the auth changes`, `/review claude/opus`, `/review check the
  migrations`; a first word naming a harness picks the reviewer, the rest is the focus). Refused
  while the agent works, in a handed-off session and in a review session. Reviewer: the harness
  asked for (its model, else the session chain's model for it), else the first other harness in the
  session's chain that's installed, else the first other installed harness (HARNESSES order), else
  the same harness in a fresh session.
- `runner/src/review.ts runReview`: the diff since the session's first checkpoint (`diffBase`; HEAD
  when there is none) through `computeDiff` capped at 120 KB for the prompt ("Nothing to review"
  when it's empty, inline). A card goes into the session at once (`LiveState.reviews`, saved in
  prefs, at most 10), then a new session on the reviewer in the same directory with `reviewOf`
  (saved in prefs; `SessionSummary.reviewOf`), guard Auto, title "Review of …". Its prompt
  (`REVIEW_PREFIX`, folded in its transcript like a brief): what the session was asked
  (`goal()`), the focus, the base commit and `git diff <sha>`, what to look for, how to report, the
  diff (credential and secrets files, `guard.ts isSensitive`, listed without their patch).
- Read-only: in a review session `checkTool` denies everything `plan.ts mutates` says changes
  something (edits, non-read-only shell, other MCP tools; builds and tests too), and every edit,
  plan files included, whatever the guard mode, and allows the rest without the judge (the rules still deny secrets). On top of that, where
  the harness can: Claude Code without Edit/MultiEdit/Write/NotebookEdit (`disallowedTools`),
  Codex in its read-only sandbox (`sandbox: "read-only"`, turn `sandboxPolicy: readOnly`, approvals
  "untrusted", even if the guard is switched to Dangerously skip), pi with `--exclude-tools
  edit,write`. "Approve & retry" on a blocked call still lets you through.
- Report: `review_report(summary, findings[{file, line, severity critical|high|medium|low, issue,
  fix}])` in `tether-context`, listed only for a review session (`TETHER_CONTEXT_REVIEW=1` from
  `mcpLaunch`, set when the launch's `session.review`). Other agents' field names and severities
  (path, priority P0-P3, description, suggestion…) are taken. Without the tool, the last JSON block
  of the first turn's reply counts; a first turn that ends with neither marks the card failed ("Open
  the review session to read what it said"), Stop too. A later review_report (you asked it again)
  still fills the card. The result reaches the session reviewed through `SessionSink.reviewResult`
  (index.ts → `applyReview`): live, its card updates; closed, its stored card; handed off, every
  session down the `handoffTo` links (a handoff copies the cards, `adoptReviews`). One push
  ("Review finished: 3 findings (1 high)" / "Review failed") from the session reviewed; the review
  session sends no "Finished" of its own. A review under way keeps the session reviewed from its
  idle close (for at most 3 hours), and the 30 minutes count from the review's result. A review
  session that hands off (a /compact without native compaction, a fallback) passes `reviewOf` on
  (`inheritReview`, before the new session starts): the successor is read-only too and reports,
  unless the review had reported already.
- Card (`web/src/components/ReviewCard.tsx`): after the message that was last when the review
  started (or after the last message when that one isn't there any more), with who reviews, the
  changes reviewed, the focus, the verdict, the findings most severe first (severity token,
  `file:line` with the open-file button, issue, fix) and per finding "Send to agent"; "Send all"
  (or "Send the other n") sends the ones not sent. Both are the `sendReviewFindings` op: a queued
  (followUp) message "A review by Codex (GPT-6 Sol) found these in your changes. Check each one,
  and fix the ones that hold: …"; sent findings say "Sent". "Open review" opens the review session,
  which says "Read-only review of … Its findings show there." at the top and is left out of the
  sidebar unless it's the one open (`showInSidebar`); Home still lists it while it runs.
- Codex's own review (`review/start`) is not used: its targets are uncommitted changes, a base
  branch, one commit or custom instructions (not the session's diff, which may span commits and the
  working tree), and it returns only rendered text (`exitedReviewMode.review: string`), so it can't
  fill the structured card. Capability matrix: new `review` slot ("Review (/review)").

| | /review as the reviewer |
|---|---|
| Claude Code | Tether's review session; Edit/Write tools removed natively, Bash through the guard; review_report |
| Codex | Tether's review session in Codex's read-only sandbox; review_report (its own review/start returns text only) |
| pi | Tether's review session, edit/write excluded natively; review_report with pi-mcp-adapter, else the reply's JSON |
| opencode, Kiro | Tether's review session, every change held by the guard; review_report (unverified, not installed) |
| Antigravity | Tether's review session, held by the guard hook; findings from the reply's JSON (its global tether-context has no review_report) |

**Phase 4e: hooks.**
- Store: `$TETHER_CONFIG_DIR/hooks.json` (mode 600; `runner/src/hooks.ts`), entries in Claude Code's
  matcher-group shape plus on/off and provenance: `{event, matcher, hooks: [{type: "command",
  command, timeout?}], enabled, sources}`. Events: PreToolUse, PostToolUse, Stop, UserPromptSubmit
  (others, and `prompt`/`agent`/`http` hook types, are skipped with a warning). "Find hooks" and the
  master context's Import read `~/.claude/settings.json` (never written); a deleted import isn't
  brought back by the next Find (pasting it is). Ops `listHooks`, `addHooks` (pasted settings JSON,
  its hooks map, or one `{event, matcher, hooks}` / `{event, matcher, command}`), `setHook` (on/off,
  delete, edited JSON), `findHooks`.
- Contract (Claude Code's): the event JSON on stdin (`session_id`, `cwd`, `hook_event_name`,
  `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `prompt`, `stop_hook_active`,
  `last_assistant_message`, plus `tether: {harness, session_id, tool_name}`; `transcript_path` is
  empty outside Claude Code), `CLAUDE_PROJECT_DIR`, `TETHER_HARNESS`, `TETHER_SESSION_ID`, never
  the relay or guard credentials; the project as cwd; its own process group, killed at the timeout
  (600 s default). Matching hooks run in parallel. Exit 2 blocks (stderr is the reason), exit 0
  with JSON is read (`permissionDecision` allow/deny/ask, `decision: "block"`, `reason`,
  `additionalContext`, `continue: false` + `stopReason`, `systemMessage`), other exits and timeouts
  are shown inline as "Hook" notices and don't block. Deny beats ask beats allow.
- Where they run (the base `LiveSession`, for every harness but Claude Code):
  - PreToolUse first thing in `checkTool` (plan/review holds and "Approve & retry" excepted): deny
    is a guard verdict `by: "hook"` ("Blocked by your hook" on the card, Approve & retry works);
    allow skips the judge and the person but not the guard's deny rules; ask shows the permission
    card in Ask/Edits and goes to the judge in Auto.
  - PostToolUse when a tool card turns done during a turn (or a shell command that ran and failed),
    from the adapters' existing items; block reasons and additional context go to the agent as
    "PostToolUse hook feedback for Edit: …" (a steer where the harness steers, else queued).
  - Stop when a turn ends normally (not after Stop, an error, a handoff or a restart): a block sends
    "Stop hook feedback:\n<reason>" as the next turn; `stop_hook_active` is true in that turn; at most
    20 in a row (`MAX_STOP_CONTINUATIONS`). The goal loop waits for Stop hooks before continuing.
  - UserPromptSubmit before each message goes out (`sendTyped`: typed, queued, scheduled runs): a
    block holds it back with an inline notice that quotes it (the next queued one goes instead);
    context and plain stdout ride along in a `<user-prompt-submit-hook>` block the transcript hides.
    Steers into a running turn don't run it.
- Tool names normalized to Claude Code's (`hookTool`): bash/shell/exec/run_command → Bash,
  read/view_file → Read, edit/apply_patch/replace_file_content/str_replace_based_edit_tool → Edit,
  write/write_to_file/create_file → Write, glob/find/find_by_name → Glob, grep/grep_search/search →
  Grep, ls/list/list_dir → LS, fetch/webfetch/read_url_content → WebFetch,
  websearch/web_search/search_web → WebSearch, update_plan/todo_write → TodoWrite, task/agent →
  Task; MCP: `mcp__s__t` as is, pi-mcp-adapter's `mcp({server, tool})` and opencode's `server_tool`
  (registry names) → `mcp__server__tool`. Inputs get Claude's field names too (`command`,
  `file_path`, `content`, `url`, `pattern`), alongside the harness's own.
- Claude Code: native. The same hooks go in as SDK hook callbacks (`options.hooks`, one callback per
  event; Claude passes its own input), minus every command Claude already runs from the settings
  files Tether's sessions load (user, project, local: `claudeNativeKeys`), so an imported hook never
  runs twice. A hook's allow isn't passed to Claude (it would skip `canUseTool` and with it plan
  mode, review holds and the deny rules); it is handed to the guard by tool call id instead. Deny,
  ask, block, context, `continue: false` and `systemMessage` go back in Claude's own output shape.
- Codex: Tether runs them. Codex 0.162 has its own Claude-style hooks (stable `hooks` feature,
  `hooks/list`), and per-session ones can be passed with `-c hooks.*` (listed as `sessionFlags`),
  but those come up `trustStatus: "untrusted"` and don't run until you review them in Codex; Tether
  doesn't work around that trust step. Its trusted, enabled hooks (from `hooks/list` at launch) are
  skipped by Tether. PreToolUse sees only what Codex asks approval for: its known-safe read-only
  commands never ask. With a PreToolUse hook on, Full access runs with `approvalPolicy: "untrusted"`
  (sandbox still off) so the hook sees commands and patches; the guard then allows what the hook
  lets through.
- pi and Antigravity: every tool call already reaches the guard (pi's guard extension, agy's
  PreToolUse hook), so PreToolUse covers all of them. opencode, Kiro: only calls the agent asks
  permission for (unverified).
- UI: a "Hooks" section on the Memory & Skills page under MCP servers (`web/src/components/Hooks.tsx`):
  each hook's label ("Before Bash", "When a turn ends"), its commands, event and matcher tokens,
  "Claude Code runs it itself" when it's in Claude's own settings, on/off, edit as JSON, delete,
  a paste box and "Find hooks". The capability matrix's `hooks` slot says the above per harness.

| | Hooks |
|---|---|
| Claude Code | native: SDK hook callbacks on every call; hooks in its own settings run only there |
| Codex | Tether's: PreToolUse at its approvals (not its known-safe reads; Full access asks again while a PreToolUse hook is on), PostToolUse on items, Stop, UserPromptSubmit; its own trusted hooks run only there |
| pi | Tether's, every tool call (guard extension) |
| opencode, Kiro | Tether's; PreToolUse only on permission requests (unverified, not installed) |
| Antigravity | Tether's, every tool call (guard hook) |

**Phase 4f: commands, subagents, env and secrets (the Phase 2 "later slots").** The `commands`,
`agents` and `env` slots are mapped on every connector; no slot says "not mapped yet" any more.
- Env and secrets (`runner/src/secrets.ts`): `$TETHER_CONFIG_DIR/secrets.json` (mode 600), edited in
  Settings ("Env and secrets": name + value, Replace, Remove; ops `listSecrets`, `setSecret`; values
  never go back to the browser). Names are env names; PATH, HOME, TETHER_*, CLAUDE_CODE_* and a few
  others are refused. Every agent process gets them (`agentEnv`: runner env, then secrets, then
  Tether's own guard env): Claude Code through the SDK `env` option (the whole environment, as the
  SDK replaces it), Codex's app-server, pi, ACP agents and agy at spawn. Registry MCP servers: at
  launch only (`sessionMcp` → `withSecrets`), `${NAME}` / `${NAME:-default}` in env values and
  headers is resolved and a stdio server gets every secret under its own variables; unknown names
  stay as written, `:-default` included (the harness may expand them from its own env). Codex
  starts stdio servers with an allow-listed environment (HOME, PATH, USER, LANG, TERM, TMPDIR, …;
  codex-cli 0.162 rmcp-client), so once you have a secret every exported stdio registry server is
  injected again per session with the secrets in its own `env`; the stdio servers in your own
  Codex config don't get them (not changed per session; gap). The registry file and the global export keep `${NAME}`; a server whose export is
  already in the harness's config but uses a secret is injected again (resolved) under the export's
  name, like an OAuth token. Claude's argv-safe path already keeps stdio servers with env and
  headers off the command line. pi's `--mcp-config` copy (runner config dir, mode 600) holds the
  resolved values, as it already did OAuth tokens.
- Commands (`runner/src/commands.ts`, `$TETHER_CONFIG_DIR/commands.json`, mode 600): imported read
  only from `~/.claude/commands/**/*.md` (the name is the file's), `~/.codex/prompts/*.md`,
  opencode's `command/` and `commands/` dirs and its config `command` map, and
  `~/.pi/agent/prompts/*.md`; same name and text merges sources, a different text is a warning;
  deletions are remembered. "Find commands" on the Memory & Skills page, the master context's Import,
  or paste one (name + text). Each command keeps whose argument rules it was written for: `claude`
  (`$ARGUMENTS`, `$ARGUMENTS[N]` and `$N` counting from 0, unused arguments appended as
  "ARGUMENTS: …", Claude Code 2.1.296's documented substitution) or `shell` (pi, Codex, opencode:
  `$1` first, `$@`, `${1:-d}`, `${@:-d}`, `${@:N[:L]}`, `$$`); arguments split like a shell.
  `/name args` in any session: Tether's own commands first, then skills, then your commands: when
  the harness lists the command (its live command list; with no answer, Claude Code's command files
  and pi's prompts) it goes through as typed, otherwise Tether fills in the template and sends the
  text (also inside joined messages and handoff briefs). `!`-shell lines and `@file` references
  aren't run when Tether fills a template in. The `/` menu lists them after skills with source
  badges and "inline" where Tether fills them in. Nothing is written into repos or harness command
  dirs. opencode (1.18.35's SessionPrompt.command) knows only `$ARGUMENTS` and `$1`…`$N` with the
  highest taking the rest, so it gets only templates whose sole placeholder is `$ARGUMENTS` (or
  none); Tether fills in the others.
- Subagents (`runner/src/subagents.ts`, `$TETHER_CONFIG_DIR/subagents.json`, mode 600): imported
  read only from `~/.claude/agents/**/*.md`, `~/.codex/agents/*.toml`, opencode's `agent(s)/` and
  config `agent` map (subagents only; `{file:…}` prompts skipped) and pi-subagents'
  `~/.pi/agent/agents/**/*.md`; "Find subagents", Import, or paste a Claude Code agent file. Each
  harness gets the ones it doesn't have under that name: Claude Code per session as SDK `agents`
  (tools and model when they're Claude's; pi tool names mapped), Codex per session as agent roles
  (thread config `agents.<name> = {description, config_file}`, the role file in
  `$TETHER_CONFIG_DIR/run/codex-agents/`), opencode per session in `OPENCODE_CONFIG_CONTENT`
  (`agent.<name>`, mode subagent, merged under Tether's plan rule and any inline config of yours),
  pi only with pi-subagents, written to Tether's own `~/.pi/agent/agents/tether/` (marked
  `.tether-owned`, synced on every change and pi launch, removed when pi-subagents goes; pi-subagents
  has no per-session path). A tools list is never widened: opencode gets it as the agent's
  permission rules (`{"*": "deny", <tool>: "ask"}`, the way its own explore agent is restricted;
  "ask" keeps Tether's guard in the loop), and Claude Code or pi leave out an agent none of whose
  tools they have ("None of its tools are pi's"). Codex roles still don't carry tools. The list
  shows per harness how it gets each one.

| | Commands | Subagents | Env and secrets |
|---|---|---|---|
| Claude Code | native for its own command files; yours filled in by Tether (the SDK has no per-session commands) | native per session (SDK agents) | native (SDK env); MCP servers resolved at launch |
| Codex | Tether fills them in (0.162 has no custom prompts) | native per session (agent roles via thread config) | app-server env; MCP servers Tether hands it resolved at launch (its own config's stdio servers don't get them: Codex filters their env) |
| pi | native per session (`--prompt-template`) where pi fills arguments the same way, else Tether | native through pi-subagents only (Tether's folder), else unsupported | process env; `--mcp-config` copy resolved |
| opencode | native per session (`OPENCODE_CONFIG_CONTENT` command) where compatible, else Tether (unverified) | native per session (`OPENCODE_CONFIG_CONTENT` agent; unverified) | process env; ACP servers resolved |
| Kiro | Tether fills them in, unless it lists one (unverified) | unsupported (its custom agents are whole agent configs) | process env; ACP servers resolved |
| Antigravity | Tether fills them in | unsupported (no subagent definitions) | process env; its MCP servers come only from its global config, where `${NAME}` isn't resolved by Tether |

Not built, or left as is: the "when CI finishes" trigger; Kiro's limit signal (no real error
captured); bundling pi-mcp-adapter (pi without it gets no per-session MCP and none of Tether's
session tools); Antigravity per-session MCP (global config only, so its goal/plan/ask/review tools
depend on that global entry); the goal on the Home dashboard; hook events other than the four, and
non-`command` hook types; secrets for hook processes and for Codex's own stdio MCP servers;
Decision 4 is bent for Antigravity (its exact quota message counts as the signal; it has no usage
feed).

Unverified pending live runs: opencode and Kiro (not installed on the dev box), Codex's
`persist: "session"` elicitation reply, Codex's own goal continuation timing, whether Claude/Codex/
opencode let a per-session server override a same-named server in their own config, whether Codex
rollouts or ACP agents persist session MCP headers, the OAuth redirect through the Foliation
edge, Codex `thread/fork` with `lastTurnId` on a thread with turns, a native Claude Code fork
resumed and prompted by a live process, and a whole /review on live harnesses (reviewer prompt,
review_report through each harness's MCP client, the card in a browser), hooks on live harnesses (Claude's SDK callbacks alongside its settings hooks, Codex approvals in Full access with a hook on, PostToolUse feedback timing), and for p4f: Claude Code's 0-based `$N` on a live 2.1.296, a Codex
role used by its multi-agent tools (the thread config was checked to parse it), opencode's inline
`agent`/`command` config, pi-subagents picking up Tether's folder, and the Settings and Memory &
Skills sections in a browser. Also from p4a-p4c: Codex honouring `tool_timeout_sec` from a thread
config override (a long ask_user), ACP agents' MCP call timeouts (no field), Kiro's mode names,
pi's `--no-extensions` + `-e` launch on real pi sessions, Codex `thread/compact/start` with a login,
the emulated /compact restart, and the plan review, goal line, schedule line, review card, fork
dialog and Harness support table in a browser.
## Phase 5: cross-harness subagents

Any Tether session can start another agent on any harness and model, follow it, and get its work
back. The user just says it ("use a Kiro subagent on Sonnet to write the tests"); the agent sees
Tether's tools and does it. Native subagents (Claude's Task, Codex's, pi's) stay as they are; this is
for the cross-harness case, where Tether is the only piece that can start every harness.

### Tools (tether-context MCP, every harness)
- `agent_start({ harness, model?, effort?, mode?, task, name?, cwd?: "worktree" | "shared", guard? })`
  → `{ id, name, harness, model, worktree? }`. Granular: harness plus any model that harness lists
  (validated against its model list, the same ids the model picker shows; `provider/model` for pi),
  effort/thinking level, permission mode. `guard` can only be the parent's or stricter.
  `agent_harnesses()` lists installed harnesses with their models and effort levels so the agent
  can choose (and tell the user what's available).
- `agent_status({ id })` → state (working/waiting/finished/failed/stopped), what it's doing now,
  elapsed, tokens/cost when known, pending questions.
- `agent_wait({ id | ids, timeoutSec ≤ ~100 })` → returns when one finishes or the timeout passes
  (MCP calls block; keep under harness tool timeouts and Tether's limits).
- `agent_message({ id, text, mode?: "steer" | "queue" | "force" })` → steer / follow up.
- `agent_result({ id })` → final report (last assistant message), `git diff --stat` and the diff
  (truncated sensibly) against where it started, changed files, the worktree path and branch.
- `agent_stop({ id })`.
- `agent_list()` → this session's subagents.

### Behavior
- A subagent is a real Tether session: listed under its parent (sidebar/Home: "started by <parent>"),
  openable, steerable, stoppable by the user. The parent's activity strip shows each one as a
  `subagent` item with the harness badge, model and its live "doing now" line.
- Isolation: by default a git worktree on a new branch `tether/<parent-short>/<name>` from the
  parent's current HEAD (uncommitted parent changes are NOT included; say so in the tool result).
  `cwd: "shared"` runs in the parent's folder. Non-git folders: shared only.
- Completion: when a subagent's turn ends (Finished, failed, stopped, or it asks a question the
  parent may answer), Tether sends the parent a message: steer if the parent is running, else a
  queued follow-up that starts a turn: "Kiro subagent 'write-tests' (claude-sonnet-…) finished:
  <report excerpt>. Use agent_result for the full report and diff." Questions/approvals from the
  subagent go to the user as usual (Needs you), never auto-answered by the parent.
- Guardrails: never more permission than the parent's guard mode; depth limit 2 (a subagent may start
  one more level); at most N (default 4) running subagents per parent tree; a stopped/archived
  parent stops its subagents; subagent sessions survive a runner restart like any session.
- Prompting: the tools' descriptions tell the agent when to use them; the parent's injected context
  mentions that cross-harness subagents exist and how to verify their work (read agent_result, run
  the tests, then merge the worktree branch or cherry-pick).
- Idle close (5 min) must not close a parent that is waiting on subagents (they count as activity).

### Phase 5: status (2026-10-14, branch `xh-subagents`)

Built; tested with stub harnesses only (runner `crossAgents.test.ts`, 20 tests: real git
worktrees, fake sessions). Not run against live harnesses or looked at in a browser.

- **Tools** (`runner/src/context/mcp.ts` `AGENT_TOOLS`): `agent_harnesses`, `agent_start`,
  `agent_status`, `agent_wait`, `agent_message`, `agent_result`, `agent_stop`, `agent_list`, listed
  in every keyed session's `tether-context` (also while the master context is off) except review
  sessions. Like the goal/plan tools they reach the runner over the loopback bridge
  (`bridge.ts` `/session`) as the session whose key is in `TETHER_SESSION_KEY` (the guard key; or
  `TETHER_GUARD_KEY`), so the runner knows which parent calls. Bridge timeouts: `agent_wait` 130 s
  (it blocks ≤ 100 s), `agent_start` / `agent_harnesses` 180 s, the rest 60 s. The guard allows
  them by rule, like every `tether-context` tool. The server's `instructions` (where the MCP client
  passes them to the model) and the tool descriptions say that cross-harness subagents exist,
  when to use them, how to pick (agent_harnesses) and how to verify; the memory preamble doesn't
  mention them.
- **Runner** (`runner/src/crossAgents.ts` `CrossAgents`, wired in index.ts as `sink.agents`):
  - `agent_start` validates the harness (ids, labels, `agy`/`claude`), that it's installed, the
    model against the harness's `listModels` (the picker's ids; also a case-insensitive id, a
    label, or pi's model without its `provider/`), effort against its levels, mode against its
    modes (approving modes refused), guard (`ask` < `edits` < `auto` < `full`; never looser than the
    parent's, default the parent's). Refused in review sessions and while planning.
  - Worktree: `git worktree add -b tether/<parent-short>/<name> ~/.tether/worktrees/<repo>-<hash>/<parent-short>-<name> <HEAD>`
    (outside the repo, so the parent's diff, tests and searches don't see it, and outside
    `~/.config/tether`, which the guard keeps agents off); the same subfolder as the parent's cwd.
    The result says when the parent had uncommitted changes (not included). `cwd: "shared"`, a
    non-git folder or a repo without commits: the parent's folder. Worktrees and branches are left
    for the parent (agent_result says how to merge and remove them).
  - The subagent is a session from the same path as fork/review (`adapter.create`, `start`,
    `track`), titled `<name>: <task>`, with `startedBy {sessionId, name, depth, rootId,
    projectPath}`; its first message (`SUBAGENT_TASK_PREFIX`) says who started it, where it works,
    to commit on its branch and to end with a report, then the task. The parent keeps a
    `SubagentLink` per subagent (`LiveState.subagents`, saved in prefs) and an activity item
    `xa:<name>` (kind subagent, `harness`, `sessionId`, model, `latest` = the subagent's
    `currentAction`, tokens, worktree, report), updated at most once a second (status changes at
    once).
  - Completion: a subagent's turn end (Finished / failed / stopped) settles for 1.5 s (no next
    goal or Stop-hook turn, nothing queued, no question, none of its own work running), then the
    link is updated and the parent hears: an `agent_wait` waiting on it returns instead; otherwise
    `LiveSession.tetherNote` sends "[Tether] Subagent "write-tests" (Kiro, Claude Sonnet 4.5)
    finished: <500 chars>. Use agent_result…" (a steer while running, queued while waiting on a
    limit or held after Stop, else a message that starts a turn). A closed parent is reopened for
    it; an archived one isn't told. A subagent's questions and approvals stay in its session
    (Needs you): its item says "Waiting for you", `agent_wait` returns, the parent isn't messaged.
    Subagents send no "Finished" push of their own.
  - `agent_result`: the last reply (12k chars), `computeDiff` from the worktree base (or the
    subagent's diff base when shared) to its working tree, committed or not, per-file stat, the
    diff (40 KB, `formatDiff`), commits on its branch, whether it left changes uncommitted, and the
    merge / cherry-pick / cleanup commands.
  - Guardrails: depth ≤ `MAX_SUBAGENT_DEPTH` (2), ≤ `MAX_RUNNING_SUBAGENTS` (4) working or waiting
    per tree (counted over every session's links), the parent's Stop, archive (Mark done) and
    removal stop its running subagents (and theirs) without messaging it; `agent_stop` likewise;
    the Stop button on the item stops it and the parent hears. Subagents count in the parent's
    `activeCount` / `workingCount` (the idle close and "Finished" wait for them) but not in `busy`
    (a restart doesn't report them as stopped work, and they resume on their own as sessions).
  - Handoffs: a parent's handoff or emulated /compact moves its links to the new session
    (`adoptSubagents`); a subagent's handoff keeps `startedBy` (`inheritStartedBy`) and the link
    follows `handoffTo`.
- **Lists**: a subagent in a worktree has `listedUnder` (the parent's project) and `startedBy`
  (`{sessionId, name, title}`) on its summary; `listSessions` of the parent's project includes it,
  worktree folders aren't projects of their own, the web keys session lists by `listPath`. Sidebar:
  nested under its parent with a subagent marker; Home: "subagent of …"; the session: a banner back
  to the parent; the parent's strip: harness badge, model, doing now, Open session, Stop.

| | Starts subagents (agent_* tools) | Can be started as one |
|---|---|---|
| Claude Code | yes (SDK `mcpServers`, per session); its own Task subagents stay native | yes |
| Codex | yes (thread config, per session) | yes; effort from its levels |
| pi | only with pi-mcp-adapter (`--mcp-config`) | yes; `provider/model` ids |
| opencode | yes (ACP `mcpServers`; unverified) | yes (unverified) |
| Kiro | yes (ACP `mcpServers`; unverified) | yes (unverified) |
| Antigravity | only where its global `tether-context` passes `TETHER_GUARD_KEY` through (no per-session MCP); otherwise the tools answer "only in sessions Tether started" | yes |

Decisions made while building: the id is the subagent's name (unique per parent); `agent_wait`
returns on "waiting for the user" too (so a parent doesn't spin) and a turn it reports isn't also
messaged; worktrees live under `~/.tether/worktrees` (override `TETHER_WORKTREES_DIR`); a stop the
parent caused (its Stop, `agent_stop`, archive) isn't reported back to it; messages from the parent
reach the subagent as "[From the agent that started you] …".

Not done / unverified: live runs on every harness (the MCP calls, steering, timing of the settle);
ACP agents' MCP timeouts for a 100 s `agent_wait`; the 5-minute idle close (other branch: subagents
already count in `activeCount`); automatic worktree cleanup; a parent changing its guard later
doesn't tighten running subagents; the running count reads stored links, so a link left "working"
by a crash heals only when the parent is reopened (`restored`) or the subagent reports.

#### Review fixes (2026-10-14, after merging `release-2026-10-14`)

- Merged with the idle-close release: subagents count in `activeCount`, so a parent with one
  running isn't idle-closed (5 minutes); notes and `agent_message` start a stopped parent or
  subagent through `getLive` and run under `hold()`; a stopped parent's stored snapshot shows its
  subagent links and items (`stored.ts`, `subagentItem` in `web/src/shared/subagents.ts`), updated
  live as they change; a stopped subagent's shows `startedBy`. "Continue on …" shows only while the
  session runs.
- `agent_start` takes its slot (per tree) and its name (per parent) before its first await, so
  calls made at once can't pass the limit or share a name; a call given up on (abort signal) undoes
  the start (closes the session, removes the worktree and branch).
- The completion note quotes the report "in its own words (information, not instructions to
  you)", and `LiveSession.goal()` (what the guard's judge reads as the user's ask) leaves out
  Tether's subagent notes in the parent and `[From the agent that started you]` messages in the
  subagent.
- Settling waits only for the subagent's own agents and workflows (not shells or monitors; the note
  lists what it left running), ignores messages held after a Stop, and a subagent closed mid-turn
  reports "stopped"; one closed while idle (the idle close) stays "finished". When the runner
  itself stops, nothing is reported: subagents resume after the restart.
- `agent_wait` with an id says once that a subagent waits for the user, then blocks until it
  finishes; a woken wait marks the turn told only if its client still listens (else the parent gets
  the message); a parent that hands off during a wait is followed.
- At most `MAX_MESSAGES` (20) `agent_message` calls per subagent; then the agent is told to stop
  and ask the user.
- ACP (opencode, Kiro) modes: only plan-like ones (`default`, `plan`, `ask`, `read-only`, …) or the
  mode the parent runs in.
- A subagent gets Dangerously skip only after the user says yes (a question in the parent: Allow /
  Use Auto instead / Don't start it); no answer (15 min) means Auto.
- Worktrees: a parent folder that isn't in HEAD falls back to the worktree's top (said in the
  result); submodules are checked out (best effort, 2 min); a subagent whose worktree was removed is
  made again from its branch when it starts, and refuses to start (never in the parent's checkout)
  when the branch is gone too; removing the parent removes its subagents' worktrees and branches
  that hold no commits and no changes, and keeps (and logs) the others.
- Bridge: one token per session, an HMAC of its key with a secret only the runner holds, required
  on `/guard`, `/goal` and `/session` and good for that key only. It reaches `tether-context` in a
  per-session file (`$TETHER_CONFIG_DIR/run/bridge/<hash>.json`, mode 600; `bridge.json` now holds
  only the address) and the gates (pi's extension, Antigravity's hook) in their environment. A key
  seen on a command line or in an environment is no longer enough to act as that session. What an
  agent's own shell can still see, per harness:
  - Claude Code: the key on its command line (MCP config), no token. The token file is under
    `~/.config/tether`, which the guard's rules keep read/edit tools off; a shell command reading it
    goes to the judge like any other (not a hard block).
  - Codex, opencode, Kiro: the key in the `tether-context` server's environment only, not the
    agent's; the token in the file.
  - pi: the extension takes `TETHER_GUARD_*` out of pi's environment when it loads, so commands its
    tools run don't inherit them (unverified on a live pi).
  - Antigravity: its hook is a separate process that needs the key and token in agy's environment,
    so agy's own shell commands inherit them; not scrubbed (no per-process path).
  Same-user processes can always read each other's environment and the runner's files: this keeps
  agents from acting as another session by accident or prompt injection, not a hostile local process.

#### Security re-review fixes (2026-10-14)

- Tether's notes about subagents and a parent's messages to its subagent are flagged
  (`PendingMessage.alone`) and never joined with the user's own queued messages in one turn
  (`nextTurnSize` and steer delivery stop where who wrote them changes); text joined anyway is
  split by paragraph (`splitAgentWritten`), so `goal()`, the goal judge's `transcriptTail` and
  handoff briefs (`renderTranscript`) never present agent-written text as the user's (they label it
  "Tether (about a subagent, or another agent's message; not the user)").
- A subagent's `goal()` is the top session's user asks (when that session runs, else "not
  available") plus its task, labelled as written by the agent that started it.
- `agent_start` has no bridge time limit (like ask_user, with progress pings); a given-up call
  cancels its Dangerously-skip question and frees its slot and name. The slot is also freed as soon
  as the link exists.
- Removing a parent removes a subagent's worktree only when `git status --untracked-files=all
  --ignored` shows nothing and it has no commits, and then without `--force` (git refuses if that
  changed); `--force` is used only to undo a worktree Tether just made.
- `agent_message`: at most 20 per subagent turn (the count starts over when a turn settles), and no
  more after 100 turns of one subagent (a runaway back-and-forth).
- Settling is skipped while the runner stops; stale per-session bridge files are swept at start.

## Phase 6: the leader agent (removed 2026-10-23)

A per-runner leader session that followed every session and passed on the user's words (built
2026-10-15) was removed: Home's ranked inbox and push for blocked calls cover what it was for, at
far less complexity. What stays: `defang()` (`web/src/shared/subagents.ts`) still defuses
authorship markers (`[Tether]…`, `[From the agent that started you]`, `You are a subagent:`, in
any case, spacing, look-alike letters or brackets, invisible characters dropped) in subagent
reports and a parent's messages to its subagent. An older `runner.json`'s `leader` key,
`ui.leaderUpdates` and per-session `leader` / `createdBy` prefs are dropped on load
(`dropLeader`, `runner/src/config.ts`); the old leader session is an ordinary session in its
folder (`~/.tether/leader`), and the messages it relayed show as plain text.
