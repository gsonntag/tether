# Fallback testing with real harnesses

A manual checklist for strict fallback (docs/harness-platform.md, Phase 1) on real harnesses. The
same matrix runs without any harness in `runner/src/fallbackScenarios.test.ts` and
`runner/src/faults.test.ts`; this is the check that the real harnesses behave like the stubs.

## Safety

- Never use the production runner (systemd `tether-runner`, `~/.config/tether`) for this. Don't
  restart it, and don't point the test runner at its config.
- The test runner uses an empty config dir and its own runner id, connects to a local server
  only, and doesn't resume sessions. Never let it inherit `TETHER_URL`/`TETHER_TOKEN` from your
  shell.
- The harnesses still run on your real logins and write to their own session stores, so test
  sessions show up in their history. A simulated limit still sends each message to the harness
  before it stops the turn, so it uses a little real quota.
- `/tether simulate-usage` never touches an account. It only replaces what Tether reads.
- Use a scratch git repository as the project, never a real one.

## Setup

```sh
W=$PWD/.work/fallback-test                       # from the repository root
mkdir -p $W/config $W/project
echo '{"runnerId": "fallback-test"}' > $W/config/runner.json
(cd $W/project && git init -q && echo 'export const a = 1;' > app.ts && git add . && git commit -qm init)

(cd server && bun --watch src/index.ts)          # :8787, dev mode
(cd web && bunx vite)                            # http://127.0.0.1:5173
(cd runner && env -u TETHER_URL -u TETHER_TOKEN \
  TETHER_URL=http://localhost:8787 TETHER_TOKEN=dev TETHER_NO_RESUME=1 TETHER_DEV=1 \
  TETHER_CONFIG_DIR=$W/config bun src/index.ts)
```

In the app, add `$W/project` as a project and pick the `fallback-test` runner.

## Commands

Type these into a session's message box. With `TETHER_DEV=1` the runner handles them, and the
harness never sees them. Without it, they are ordinary messages.

| Command | Effect |
|---|---|
| `/tether simulate-limit <quota\|rate\|other>` | The next turn ends with this harness's own error |
| `… after <n> tools` | Fires once n tool calls of that turn have finished. A turn with fewer ends with it anyway |
| `… reset <dur>` | When the simulated limit resets, e.g. `90m`, `2h`. Defaults: quota 1 h, rate 20 s |
| `… now` | Fires in the turn that is running now (with nothing running, in the next turn) |
| `/tether simulate-limit off` | Disarms it |
| `/tether simulate-usage <claude\|codex> <pct> [reset <dur>]` | Replaces that account's usage, in the usage bar and in fallback's check. `codex` covers both ChatGPT logins (Codex CLI and pi) |
| `/tether simulate-usage clear` | Back to the real usage |
| `/tether exhausted <chain entry> <dur>` | Marks that entry at its usage limit for `dur`, e.g. `claude-code:sonnet 3m` (a bare model is this session's harness) |
| `/tether exhausted clear` | Clears every entry of `exhausted` |

What each harness reports (`runner/src/faults.ts`):

| Harness | quota | rate | other |
|---|---|---|---|
| Claude Code | rejected `rate_limit_event`, then "You've hit your limit · resets …" | assistant `rate_limit` error (429) | API 500 |
| Codex | rate limits at 100%, then the turn fails with `usageLimitExceeded` | `responseTooManyFailedAttempts` (429) | `internalServerError` |
| pi | "You have hit your ChatGPT usage limit … Try again in ~N min." on `openai-codex`, else the provider's 429 text | "429 Rate limit reached … try again in Ns" | "500 Internal server error" |
| opencode, Kiro (ACP) | JSON-RPC internal error with limit text | the same with "429 … try again in Ns" | "Internal error" |
| Antigravity | "RESOURCE_EXHAUSTED (code 429): Individual quota reached … Resets in …" | RESOURCE_EXHAUSTED 429 without "quota" | INTERNAL 500 |

The runner stops the real turn the harness's own way (interrupt, abort, `session/cancel`, or
SIGINT for agy). It then feeds the error to the adapter's parser, so the real classification and
fallback code runs.

## Checklist

Use the "Claude, then Codex" chain `claude-code:opus, claude-code:sonnet, codex:gpt-5.5`
unless the step says otherwise. Check `exhausted` in `$W/config/runner.json` as you go, and
send `/tether exhausted clear` between steps. Don't edit the file while the test runner runs:
the runner keeps its config in memory and writes it back over your edit.

1. **Same-harness switch before the turn.** `/tether simulate-limit quota`, then send a task.
   - Expect "Usage limit reached on Opus (resets …)", then "Switched to Sonnet."
   - Sonnet continues the task without the message being sent again.
   - `exhausted` has `claude-code:opus`.
2. **Same-harness switch mid-turn.** `/tether simulate-limit quota after 2 tools`, then a task
   that reads a few files. Same as step 1, but the switch comes after the second tool card.
3. **Cross-harness handoff mid-turn (Claude → Codex).** Use the chain
   `claude-code:opus, codex:gpt-5.5` and set the guard to Ask.
   - Ask for a task that starts a dev server in the background, then edits files.
   - While an approval card is open, send `/tether simulate-limit quota now`.
   - Expect the Claude session to end with "Opus hit its usage limit. Continued on GPT-5.5 in
     Codex. 1 open request was cancelled; 1 background task was stopped."
   - The approval card is gone, and the dev server stopped (Activity).
   - The Codex session opens on a brief with "## Interrupted work". It lists the cancelled
     approval and the stopped server, and it asks for `git status`/`git diff` first.
   - Codex inspects the tree before continuing.
   - Repeat with a question card (ask Claude to ask you something first) instead of an approval.
4. **Cross-harness handoff mid-turn (Codex → Claude).** Use the chain
   `codex:gpt-5.5, claude-code:opus`.
   - `/tether simulate-limit quota after 1 tools`.
   - Expect `exhausted.codex`, and a Claude session on the brief.
   - Codex background terminals can't be stopped from Tether, so the brief lists them as
     possibly still running.
5. **Whole chain exhausted, then wait, reset and continue.** Use the chain `opus, sonnet`.
   - Send `/tether exhausted claude-code:sonnet 3m`.
   - `/tether simulate-limit quota reset 10m`, then send a task.
   - Expect the status "Every model in this session's chain is at its usage limit", and a
     "Waiting on usage limits" push.
   - About 3 minutes later the session goes on with "Switched to Sonnet."
6. **The same, with a restart while waiting.** Repeat step 5 with `TETHER_NO_RESUME` unset for
   this run only (the config dir is the test one).
   - While the session waits, stop the test runner (Ctrl-C) and start it again.
   - Expect "The runner restarted while this session was waiting. It continues at HH:MM.", and
     the same continuation at that time.
   - Put `TETHER_NO_RESUME=1` back afterwards.
7. **preferBest moves back up.** After step 1 or 5, wait for Opus's simulated reset (use
   `reset 2m` to keep it short), then send a message.
   - Expect "Back on Opus: its usage limit has reset."
   - For a cross-harness chain, the Codex session hands the message back to Claude ("Opus is
     available again").
8. **Rate limits back off on the same model.** `/tether simulate-limit rate`.
   - Expect "Rate limited on Opus" waiting, then a retry on the same model.
   - Nothing appears in `exhausted`.
9. **No switch on unverified text.** Use the chain `pi:openai-codex/gpt-5.5,
   claude-code:opus`.
   - `/tether simulate-usage codex 60`, then `/tether simulate-limit quota`.
   - pi's limit text isn't confirmed by the usage, and its "Try again in" wording reads as a
     transient retry, so it waits on the same model. Nothing is exhausted.
   - Then `/tether simulate-usage codex 100` and repeat. Now it hands off to Claude.
   - `/tether simulate-usage clear` afterwards.
10. **Error text with "billing" or "resets in" on an unverifiable entry.** Use the chain
    `kiro:auto, claude-code:opus` (or opencode), then `/tether simulate-limit quota`.
    - The error shows with a "Continue on Opus in Claude Code" button, and nothing switches.
    - Pressing the button hands off as interrupted. `exhausted` stays empty.
    - Other sessions keep using Kiro.
11. **Antigravity.** Use the chain `antigravity:default, claude-code:opus`, then
    `/tether simulate-limit quota reset 5h`.
    - agy is stopped, and its quota message counts as a definite limit, with the reset it names.
    - The session hands off to Claude.
12. **Stop wins.** `/tether simulate-limit quota after 1 tools`, start a task, and press Stop
    before the first tool finishes. The turn ends as a stop: no limit, no switch.

## Cleanup

Stop the test runner, server and web. Remove `$W`. Archive the test sessions in each harness's
history if they're in the way.
