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
