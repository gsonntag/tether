# Harness platform: connectors, Tether-owned features, strict fallback

Status: draft plan, 2026-10-11. Nothing built. Open questions at the end.

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
