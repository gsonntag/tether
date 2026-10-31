# Open issues

Filed when review rounds ended on 2026-10-31, at 042a217. Nothing here has had a fresh review since the fix it follows.

## Review status

| Phase | Last review | Found | Since then |
|---|---|---|---|
| P0-P2 | Passed earlier | Nothing major or important | Scroll rework touches P1 (`e2e-p1` passes) |
| P3 | Round 10 | 2 important, 7 minor | All fixed, not re-reviewed |
| P4 | Round 9 | 2 major, 3 important, 8 minor | All fixed, not re-reviewed; no full e2e on the final code |
| P5 | Round 10 on e556827 | 6 minor | Later commits not re-reviewed |
| P5b | Round 5 | 2 important, 12 minor | All fixed, not re-reviewed |
| Scroll | Round 4 | 1 major, 3 important, 6 minor | Priority ones fixed, not re-reviewed |

## Decisions needed

- **Read-only turn driving a Full access process.** `write_stdin` with input from a Read only, Ask first or Auto turn raises an approval. Declining writes nothing. Approving lets the unsandboxed process write, and the card shows it only as a command. Approve for me, where Codex's reviewer answers, is untested.
- **Esc while scrolled back** only leaves copy mode and isn't delivered, so it can't stop a Claude turn. To deliver it, pass `leave: true` for Esc (`TerminalPanel.tsx` key bar, `forProgram` in `tmux.ts`).
- **Streaming look vs memory.** See the stall below; the candidate fix changes how streaming looks.

## Tests

- `scripts/e2e-p4.mjs`: `tuiReadOnly`, `tuiSteer` and `tuiAnswerAway` were written but never run, and are in the default list. A full run may fail on them. `tuiAnswerAway` needs `STOP_RUNNER` and `START_RUNNER`.
- `scripts/e2e-p4.mjs`: no full run on the final code. Stream, approve, steer, midturn, restart, settings, the sub* steps and `bgStop` didn't run on it.
- `tuiPermissions` (`e2e-p4.mjs:928`): 2 of 2 since the fix, was 7 of 10; the 10-run check is still open.
- `subMessage`: the "no Deny with reason" check skipped because the subagent didn't ask. Covered by unit test and daemon probe, not in a browser.
- `copymode` Enter race in `e2e-p5b.mjs` failed once and hasn't since `closeShells` was added. Cause unconfirmed; check shell leftovers from `copy` first.
- Runner test `review round 3 > after /clear, the old session's own TUI gets its own hooks` failed once, then passed. Not investigated.
- `scroll-jank`: `huge-*` not rerun after the rework; `typing-webkit` "selecting all and deleting" didn't run; `lost finger` read 20 and 106 px on WebKit's last sample, unconfirmed; `short rows` recorded one write during a fling on Chromium.
- `e2e-p5b` `hide` runs only with `HIDDEN=1` and isn't in a plain run.
- `layout-p3.mjs`: after its check was corrected, only `g5` and `placeholder` were rerun.

## P3 (terminal, Claude)

- A truly hung TUI is unit-tested only; `kill -STOP` didn't hang one.
- `mdisc` wasn't rerun after launches moved to prefs only (`live.chosen`). Codex launches on that path had no full e2e.
- A TUI killed within 1 s of tightening, with no poll in between, relies on the stored entry.
- Back racing `gone` (`control.ts` `end()`): not reproduced, seen in code only.
- After Back kills a TUI with a background shell, Claude runs a short turn from the task notification, so a send right after gets "still working".
- A prompt starting with "/" that got no answer lists as "Untitled" (`titleOf`).
- Coarse-pointer focus in cover mode and font size on rotation: emulation only.

## P4 (Codex)

- Delivery to a subagent can read as delivered when the main agent messaged it on its own.
- Messages to a nested subagent weren't trialled. After a restart, an adopted child is addressed by leaf name only (`stream.ts targetOf`), so a nested one may show "Not delivered".
- Stored look on a thread that isn't loaded: an error or empty reply reads as nothing running (`codexBackgroundRuns`). That branch wasn't seen on the real daemon, and it fails open.
- `live.ts confirmSettings` no longer runs for any shipped adapter. Dead code.
- A steer in the moment `driver.send` awaits `pins()` can get "Nothing is running…", on model "default".

## P5

- A left-behind finished turn tells nobody.
- The fallback path has no quiet wait.
- Stop during the wait leaves a later message paused (raw rpc only).
- Cold-start steer and the wait row are covered by unit tests only.

## P5b (shells)

- Scrolled-back input in the agent's TUI isn't in the e2e, only in shells. Same input path.
- User-key bindings need tmux 3.0 or later, with no fallback. This machine runs 3.4.
- A key sent right before closing a terminal can be lost. Only the phone's line Enter is protected.
- A CR split across two output chunks can give an extra blank line (`shellRuns.ts decode`).
- Firefox right-click not run.
- Reattach retries are unit-tested only.
- Everything marked `by hand` in P5b.md wasn't run in the last round.

## Scroll

- Jump during inertia failed on Chromium's final run after passing before (`scrollKeep.ts:15`, `:53`). May need a longer window.
- About 1 s stall on huge sessions while streaming: an Oilpan major GC, 2,654 ms in one 10 s trace. Removing the reveal and fade cut tasks from 9.8 s to 6.2 s per 10 s; also removing the footer spinner took them to 3.4 s. Sites: `Markdown.js:1312`, `:1409`, `SessionView.tsx:196`. Candidate: a CSS-transform spinner plus `speed: 'instant'`.
- Chromium RSS peaks 2.3-2.8 GB during a stream, freed by GC. Same cause as above. Android under memory pressure is unknown.
- `reset` events replace the window and lose the reader's place, by design for a rewind. Not exercised for a runner restart.
- Selection autoscroll stops at the top of the mounted slice (`scrollKeep.ts:158`).

## Needs real devices

- iPhone: finger swipes in terminals, momentum, keyboard, rubber-banding, focus. WebKit touch here is synthetic. P1 G3b, G3d-G3k; P5b I5d, F3, I6.
- Mac trackpad inertia. Only synthetic wheel steps were tested.
- Push delivery with the regenerated VAPID keys.

## Backlog

- Harness update notice on the dashboard.
- Revert `TETHER_HIDE_PROJECTS=/tmp/*,*/scratch` and remove the two test trust entries in `~/.codex/config.toml` when the build-out ends.
