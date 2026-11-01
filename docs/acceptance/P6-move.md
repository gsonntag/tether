# P6 acceptance: moving a session to another harness

Manual checks for SPEC §15. Each says how it's verified, in brackets: `e2e: step` is a step of
`scripts/e2e-move.mjs` (real Claude on Haiku and Codex on gpt-6-luna, Low), `unit` is
`runner/src/modules/move/move.test.ts` or `shared/move.test.ts`, `by hand` has no automated check.
"Phone" means a browser at 375 × 812 with touch emulation.

## Setup

A private stack with its own ports, config and tmux socket. Nothing here uses Codex's TUI, so no
folder needs trusting: the SDK and the daemon's read-only start ask nothing.

```sh
D=/tmp/tether-move-dev; mkdir -p $D
echo '{"runnerId":"tether-dev-move","name":"tether-dev-move"}' > $D/runner.json
cd server && env -u TETHER_URL -u TETHER_TOKEN -u PORT PORT=8871 bun src/index.ts
cd runner && env -u TETHER_URL -u TETHER_TOKEN TETHER_DEV=1 TETHER_URL=http://localhost:8871 TETHER_TOKEN=dev \
  TETHER_CONFIG_DIR=$D TETHER_TMUX_SOCKET=tether-dev-move bun src/index.ts
cd web && TETHER_SERVER=http://127.0.0.1:8871 bunx vite --port 5271 --strictPort
CONFIG_DIR=$D node scripts/e2e-move.mjs errors keyRefused stored long round codexFirst
# The file route: a runner with TETHER_MOVE_ROUTE=context, then
CONFIG_DIR=$D node scripts/e2e-move.mjs fallback
# Codex asked about a cut history: a runner with TETHER_MOVE_BUDGET=12000, so its turns stay small, then
CODEX_TURNS=1 CONFIG_DIR=$D node scripts/e2e-move.mjs long
```

Compare `sha256sum ~/.codex/config.toml` before and after: a move must not change it.

## Checks

1. **The action** [e2e: errors] Session header ⋯ → Move to… opens a small dialog: harness (a choice
   when there are several), Model, Effort, Mode, Billing when known. Not on a subagent.
2. **Cancel** [e2e: errors] Cancel, ✕ or Esc: nothing is made, the session stays open.
3. **Refused** [e2e: errors for a turn; unit for the rest] A running turn, an open request, a
   terminal, waiting messages or a `!` command: the dialog says what to do and Move is disabled. The
   op refuses too.
4. **Phone** [e2e: errors, codexFirst] The dialog fits 375 wide, with no sideways scroll, and a move
   from a phone works.
5. **Codex to Claude** [e2e: stored, codexFirst] The moved session opens on its own. Asked about a
   tool's output from the old session, the agent quotes it without running anything.
6. **Claude to Codex and back** [e2e: round] A session with a tool call and an image: Codex
   answers from the tool result and names the image's color, edits a file, moves back; Claude answers
   from both, edits the file.
7. **The source is left alone** [e2e: round, long] The old session's `.jsonl` has the same sha256
   after every move. It shows "Moved to …", and it still works.
8. **Links** [e2e: round] "Moved from …" and "Moved to …" with Open it, both ways, on a phone too.
9. **Bigger than the window** [e2e: long] A session of about 350k tokens: the notice says how many
   messages are in context; asked for something from its first message, the agent finds it in the
   file; moved again, it still can.
10. **The file route** [e2e: fallback] With `TETHER_MOVE_ROUTE=context`, each target replies Ready,
    then answers from the file, Claude without a prompt.
11. **Native import fails** [unit] Falls back to the file route, logged, with no half-made session.
12. **N-way** [unit] Three harnesses, every direction, through one code path.
13. **Modes** [unit, e2e: round for two] The table in SPEC §15: never looser, unknown the safest.
14. **Background work** [unit] A stored Codex thread with a background command: the dialog says
    "Background work stays here", and the agent and the notice say it too.
15. **Billing** [unit, for the source; by hand with a real key] With a key set for the target, the
    dialog shows it in the API colour; the moved session starts at once, with the loud badge. A
    refused key shows its error and nothing is sent. Without a key: the plan's label, quiet.
16. **Title and folder** [e2e: stored] The moved session has the old title and folder.
