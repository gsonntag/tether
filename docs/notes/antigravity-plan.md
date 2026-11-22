# Plan: Antigravity as Tether's third harness

Status: phases 1–3 built on 2026-11-21 (SPEC §6 **Antigravity**; acceptance in
`docs/acceptance/ANTIGRAVITY.md`). Phase 4 is still to do. Changed from this draft while building:
the reader is a fresh `agy acp` per call, not a long-lived one, because a long-lived process reads
stale history; Tether leaves Antigravity's own auto-update on; the TUI ignores `--model` and
`--effort` on a resumed conversation.

Original draft, 2026-11-20. Facts below were checked against the real `agy` on this machine
(CLI 1.4.6, ACP server 1.5.13, signed in, models list and turns work).

## What Antigravity gives us (probed)

| Need | What works | Notes |
|---|---|---|
| Live driving | **`agy acp`**: Agent Client Protocol, JSON-RPC over stdio. Hidden from `--help` | `initialize`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/close`, `session/prompt`, `session/cancel` |
| Approvals | `session/request_permission` with `allow` / `deny` options, before the tool runs | Verified: a `run_command` waited for our answer, then ran |
| Permission modes | `default` (ask), `accept-edits`, `plan`, from `session/new` → `modes` | Plus `--dangerously-skip-permissions` on the CLI; check whether ACP has a bypass |
| Model and effort | `configOptions`: `model` (Gemini 3.8 Flash, Claude Sonnet/Opus 4.6, GPT-OSS 120B) and `thought_level` (low/medium/high) | Set with `session/set_config_option`; don't use the combined `gemini-3.8-flash-high` ids |
| Transcript stream | `session/update`: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call` / `tool_call_update` (`kind`, `rawInput`, `rawOutput`, `status`) | Maps cleanly onto `Msg` and `ToolPart` |
| Context | `usage_update { used, size }` (1M window) | Use it as is |
| Title | `session_info_update { title }` | |
| Commands | `available_commands_update` (`/goal`, `/compact`, `/plan`, skills…) | Feeds the message-box menu |
| Turn end and cost | `session/prompt` result: `stopReason`, `usage` (input, output, cached, thought tokens) | |
| History | `session/load` replays the whole conversation as `session/update`s | Store: `~/.gemini/antigravity-cli/conversations/<id>.db` (SQLite with undocumented protobuf blobs: **don't parse**) |
| Discovery | `session/list` → `sessionId`, `cwd`, `title`, `updatedAt` | ACP, `-p` and TUI sessions all share one store |
| Terminal | `agy --conversation <id>` in the project folder | Same store, so a **handoff** works like Claude's |
| Headless `-p --input-format stream-json` | Multi-turn NDJSON | **Not usable for driving:** permissions auto-deny ("headless mode cannot prompt") |

## Design

1. **A generic ACP client, `runner/src/adapters/acp/`**: process, JSON-RPC framing, the request/notification
   loop, `session/update` → transcript events, `request_permission` → `Sink.request`. Antigravity is
   the first user. Any later ACP harness (Gemini CLI, others) reuses it, so the Antigravity
   adapter stays thin.
2. **`runner/src/adapters/antigravity/`**: the adapter, with:
   - `driver.ts`: one `agy acp` per live session (`session/new`, or `session/load` to resume).
     `send` = `session/prompt`, `interrupt` = `session/cancel`, `setPermissionMode` =
     `session/set_mode`, `setModel`/`setEffort` = `session/set_config_option`.
   - `discovery.ts`: one shared, long-lived **reader** `agy acp` for `session/list` and history
     replays (`session/load` → `Msg[]`), cached by the `.db`/`-wal` mtime. `watchHistory` =
     `fs.watch` on those files, then a fresh replay. This bends §6's "discovery: no process",
     because the only other option is reverse-engineering protobuf. Write that down in the SPEC.
   - `index.ts`: capabilities `{ canSteer: false, terminal: "handoff", subagents: { view: false,
     stop: false, steer: false }, commands: true }`. Add steer, subagents, move and fork once they're probed.
   - `terminalCommand`: `agy --conversation <id>`, plus `--model`, `--effort` and `--mode` from the session.
3. **Plumbing (mechanical)**: `HarnessId` gets `"antigravity"`. Update `HARNESS_BINS` (`AGY_BIN || "agy"`), `HARNESS_KEYS`
   (Gemini API key later), the permission-mode labels in `shared/labels.ts`, the harness list in `NewSessionDialog`,
   the Home agent's enum and the `sessionOps` harness parser, the update check (`agy update`), the
   harness glyph, and usage scanning (skip at first).
4. **Billing**: auth method from `~/.gemini/antigravity-*/settings.json` (`oauth-personal` → "Google
   account", `gemini-api-key` → "Gemini API key"). Plan limits are unknown for now (no signal found yet).

## Phases (one PR each, adversarial review per PR as in the T3 rollout)

1. **ACP client + read-only Antigravity**: plumbing, detection, discovery, history replay,
   watchHistory. Antigravity sessions show in the sidebar with full transcripts.
2. **Live driving**: driver, approvals through the broker, modes, model/effort chips, context,
   title, commands menu, cancel.
3. **Terminal handoff**: `agy --conversation` in tmux, read-only live transcript, and back again. Needs
   screen fixtures for the TUI's idle/asking states (like `claude/screens/`).
4. **Extras, each after a probe**: steering (prompt during a turn?), plan mode (does `plan` emit a
   reviewable plan, e.g. `brain/<id>/implementation_plan.md`?), subagents (`invoke_subagent` /
   `manage_subagents`), move/fork, Gemini API key source.

Each phase gets `docs/acceptance/P-antigravity-<n>.md` run against the real `agy` (Principle 4).

## Open questions and risks

- `agy acp` is **hidden and unversioned**. Gate on `initialize.agentInfo.version`; pin the probed
  version in fixtures; fail clearly if the protocol shape changes.
- **The CLI auto-updates** (CLI says 1.4.6, ACP reports 1.5.13). Set `AGY_CLI_DISABLE_AUTO_UPDATE` for
  runner-started processes and let Tether's update module own updates, as for the other harnesses.
- **Is a TUI and an ACP process on one conversation at once safe?** Assume not (handoff); probe it.
- **Is there a new-session-with-chosen-id flag for the TUI** (like Claude's `--session-id`)? If not, a
  session started in the terminal is found by `session/list` diffing.
- **Replay cost** for long conversations: cache, and page from the replay.

## Testing

Credentials are present (Google sign-in). The probes used `gemini-3.8-flash-low`, about 10k
input tokens per turn, so acceptance runs are cheap. Probe scripts are in `~/agy-scripts/`
(`acp.ts`: one turn with an approval; `load.ts`: list and replay).

## Phase 4 plan (2026-11-21): subagents, move, fork, plan review, side chats, Tether's tools

Built as planned on 2026-11-21 (SPEC §6, §6a, §7, §9a, §15, §16, §16a); `scripts/antigravity-modules-accept.ts` checks it. Changed since: subagents are loaded into the main agent's process, so their approvals reach you and Stop works (the stall below is gone); Bypass permissions was added as Tether's own mode.

Probed on agy 1.5.13 first; each line is what was found, then what Tether does.

- **Subagents.** `invoke_subagent` makes a separate conversation (its own `.db`, not listed). Its
  first step reads `[Message] … sender=<parent id> … content=<prompt>`. It runs inside the parent's
  `agy acp` process and dies with it. It reports with `send_message` to the parent, and the parent
  then runs a turn on its own: updates with no prompt and no end result. Its approvals never reach
  an ACP client, so a subagent that needs one stalls.
  → Child sessions (`subagents: { view: true, stop: false, steer: "via-parent" }`): the driver
  matches each `invoke_subagent` call to its new conversation (sender and prompt), opens it with
  `sink.subagent`, and replays it into the child's transcript when its store changes. It ends after
  its report and a quiet spell, or after 3 minutes without a change (stalled). The process stays up
  (`busy`) while children run. An unprompted parent turn shows as working and ends after 3 quiet
  seconds; its text joins the turn's reply, as a replay groups it. Steering goes through the parent's
  `send_message` to the child's id. Stored children come from a scan of the store for that `sender`.
- **Move** (§15): ACP has no import, so `move: { import: "context" }`. Levels: `plan` 0, `default` 1,
  `accept-edits` 2. Reading the moved history (outside the folder) is approved by the driver.
- **Fork** (§16): there's no fork call. A consistent copy of the `.db` (`VACUUM INTO`), with the
  id rewritten in every row (same length, so protobuf stays valid), cut before the user input
  that follows the fork point. It loads, continues with only the kept turns, and leaves the
  original untouched. The fork is read back (message count), else deleted.
- **Plan review** (§7): in `plan` mode the plan is a `write_file` to `brain/<id>/…md` with
  `ArtifactMetadata.RequestFeedback`, and then the turn ends. → After such a turn, a
  `planFollowUp` request with the file's text, as Codex does.
- **Side chats** (§16a): `readOnlyMode: "default"`. Default mode asks before every write, command and
  MCP call, and the core refuses a side chat's approvals. The fork gets no MCP servers and no
  Tether tools, and its system prompt says it's read-only. Not gated by Antigravity: `invoke_subagent`
  (a subagent inherits the gate, and its approvals never come back) and `schedule`. `--sandbox`
  stops neither writes nor network, so it isn't used. A saved Always-allow rule in Antigravity's
  settings refuses the side chat.
- **Tether's tools** (§9a): `mcpServers` on `session/load` takes Tether's server with its env. Its
  tools are `mcp_tether_<tool>`, and they ask, so the driver approves Tether's own. Instructions go
  in `_meta.antigravity.systemPrompt.append`, which works.

## Future work (not planned yet)

- **Gemini API key as a billing source.** Antigravity's ACP server offers a `gemini-api-key` auth
  method (`initialize.authMethods`), and `~/.gemini/antigravity-acp/settings.json` can name it. It
  would join Settings → Credentials like the Anthropic and OpenAI keys, with the same billing safety
  (confirmed source, never a key by surprise). Left out on purpose until asked for.
- **Usage outside Tether.** Settings → Usage records live Tether prompts with usage in their ACP
  response. Standalone turns would need a separate source, such as the store's per-step generation
  metadata in undocumented protobuf.
- **Antigravity's own Auto mode.** Its TUI has `--mode auto`; over ACP it's refused on 1.5.13
  ("needs the OS terminal sandbox and may not be rolled out to you yet"). Offer it once
  `session/set_mode` accepts it.
- **Tether auto mode.** A Tether-wide auto mode, for any harness. Future scope only; not planned.
