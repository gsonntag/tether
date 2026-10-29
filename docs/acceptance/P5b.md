# P5b acceptance: shell from the main UI

Manual checks for P5b: `!` commands in the composer (SPEC §9 Shell commands), and the ❯_ chip's two
choices, **Shell** beside the live session and the **agent's terminal** (SPEC §8 Shell beside the
chat vs the agent's terminal). Each check gives exact steps and the expected result. "Desktop" means
a browser window at least 1024 px wide; "phone" a real phone, or a browser at 375 × 812 with touch
emulation. "Two devices" means two browsers (or a browser and a phone) on the same app at once.

Phase acceptance (SPEC §11):
- `!` runs at once on desktop and phone, on both harnesses, mid-turn too; its card goes Running →
  Waiting in queue → Sent to <Agent>; Stop kills it and still sends; holds and the queue's limits
  apply; huge output stays bounded; restarts never leave a card Running (A–F).
- Shell keeps the session live while the composer messages the agent; the agent's tab hands over,
  switching back to a shell doesn't; the labels say which surface drives; the phone toggles between
  chat and shell without closing it (G–J).

`scripts/e2e-p5b.mjs` runs most of these headless against real Claude (Haiku) and Codex
(gpt-6-luna, Low); each check names its step. What needs a real phone is marked **Phone only**.

## How it works

- **The composer.** Text that starts with `!` is a shell command. The box turns into a shell
  prompt: monospace, a green outline, the ❯ toggle lit, the button **Run**, and a hint above it:
  "Shell · Runs now in <folder> · the output goes to Claude when it finishes" (mid-turn: "when this
  turn ends"; while the TUI drives "when you go Back to Tether"; with the queue held "waits in the
  queue, paused after Stop", or whichever reason holds it). Enter (or ⌘/Ctrl+Enter, or Run) runs it, whatever the agent is doing; Tab and Esc do
  nothing special. On phones Enter is a newline and Run runs it. The ❯ toggle beside the paperclip
  adds the leading `!` or takes it off (the way in on a phone). Attaching is off in shell mode;
  files already attached stay for the next message.
- **Running.** `$SHELL -c '<command>'` in the session's folder, on the runner: no stdin (reads get
  end of file), no time limit, its own process group, the runner's environment without `TETHER_*`.
  At most 5 at once per session, counted as they start. Only the owner (the app's sign-in) can run
  one; subagents can't. Output is read at most 16 MB a second (a runaway command waits on its pipe).
- **The card** (yours, full width, a terminal look): "You ran `$ command`", a spinner and **Stop**
  while it runs, then its exit code ("exit code 0" green, other codes red, "Stopped", "ended by
  SIGKILL"); the output (scrolls, follows the end unless you scroll up); and a status line:
  - **Running · the output goes to Claude when it finishes**
  - **Waiting in queue · goes to Claude when this turn ends** (or "next", or "(paused after Stop)",
    "(until you're back from the terminal)", "(paused after a failed turn)", "(paused after a
    restart)")
  - **Sent to Claude**
  - **Not sent: …** (You removed it from the queue. / the queue's own refusal when it is full / It
    couldn't start. / The runner stopped while it ran, so it was ended and nothing was sent.)
- **To the agent.** When it ends, a message goes to the agent through the queue: "I ran a shell
  command in the project folder: `$ npm test` · It exited with code 1. Its output:" and the output
  fenced (stopped: "I stopped it before it finished. Its output up to then:"). It is an ordinary
  queued message: it never steers; mid-turn it waits for the turn to end; holds hold it; it counts
  toward the 1 MB and 50-message limits; it is in runner.json. In the queue it reads "Output of
  `$ npm test`" with no ✎ (cancel only). Where the agent got it, the transcript shows one quiet line
  "Output of `$ npm test` sent to Claude" that opens to the exact message.
- **Bounds.** Output keeps its first and last bytes; the middle is counted and dropped. Card: 16 KB +
  44 KB (a note says how much was cut, and that the agent gets the start and the end); streamed as
  ≤16 KB deltas every 100 ms, or once cut, the whole card output at most once a second. Agent: 8 KB +
  22 KB with "[… N MB of output cut from the middle …]". notices.json keeps 4 KB + 12 KB of a finished
  card, which is what shows after the session leaves memory or the runner restarts.
- **Restarts.** A graceful stop (SIGTERM) ends running commands (SIGKILL 2 s later, before it exits)
  and marks their cards **Cut off · Not sent: The runner stopped while it ran…**. A running card is
  saved with its process group and its output every 2 s; after a crash the next start kills that
  group if it is still the same (the leader's start time matches, or the leader is gone) and ends
  the card the same way, with what it printed. Output already queued is in runner.json and goes as
  usual.
- **Titles and markers.** A session whose first message is a command's output is titled "$ npm
  test", never "[Shell command run from Tether] …" (Claude and Codex alike). Typed text that starts
  with Tether's markers shows as yours (a zero-width space goes in front of it).
- **❯_ Terminal chip.** A menu with **Shell** ("A shell in this folder, beside the chat. Claude stays
  driven from here.") and **Claude terminal** ("Claude's own terminal UI. It drives Claude until you
  go Back to Tether.") / **Codex terminal** ("Codex's own terminal UI, joined to this session. Tether
  keeps driving it too."). While the panel is open the chip closes it (on a phone with the panel
  tucked away, it brings it back).
- **The panel.** Tabs: "<Agent> terminal", then "Shell 1", "Shell 2"…, then +. Under the tabs, a line
  says who drives the agent:
  - a shell tab, session in Tether: "Shell 1 · a plain shell in this folder. It doesn't touch Claude:
    the chat still drives Claude."
  - a shell tab, handed off: "… Claude is still driven from the Claude terminal tab until Back to
    Tether."
  - the agent's tab, handed off (highlighted): "Claude terminal · it drives Claude now. The chat
    follows along; Back to Tether hands the session back."
  - the agent's tab, shared: "Codex terminal · joined to this session. Tether's chat drives Codex too."
  Clicking the agent's tab when its TUI isn't open opens it as the chip would: idle Claude hands
  over at once; busy Claude asks in the panel ("Stop this turn and open the terminal?" — Stop and open
  terminal / Keep working); Codex joins. Going back to a shell tab never hands back.
- **Phone.** The panel is full screen; **Chat** in its header hides it (still mounted and attached)
  and the transcript shows with a "❯_ Back to the shell" pill above the composer; the pill (or the
  chip) brings back the same terminal as it was.

## Setup

An isolated dev stack with its own ports, config and tmux socket:

```sh
D=~/.local/share/tdp5b
mkdir -p $D/projects/scratch && echo '{"runnerId":"tdp5b","name":"tdp5b"}' > $D/runner.json
cd $D/projects/scratch && git init -q && echo '# Scratch' > README.md && git add . && git commit -qm init
cd server && env -u FOLIATION_ISSUER -u PORT -u TETHER_URL -u TETHER_TOKEN PORT=8796 bun src/index.ts
cd runner && env -u TETHER_URL -u TETHER_TOKEN TETHER_DEV=1 TETHER_URL=http://localhost:8796 TETHER_TOKEN=dev \
  TETHER_CONFIG_DIR=$D TETHER_TMUX_SOCKET=tdp5b bun src/index.ts
cd web && TETHER_SERVER=http://127.0.0.1:8796 VITE_PORT=5186 bunx vite
PLAYWRIGHT=/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs SCRATCH=$D/projects/scratch \
  RESTART_RUNNER='…' node scripts/e2e-p5b.mjs
```

Notes:
- **RESTART_RUNNER** must leave the runner down for a moment (e.g. `kill -TERM <pid>; sleep 2` with a
  loop that starts it again a second later), so the step sees the restart; **CRASH_RUNNER** the same
  with SIGKILL.
- The scratch folder must be named `scratch` (checks match it in the hint) and already **trusted** by
  Claude Code (open `claude` there once and accept), or the handoff's TUI stops at the trust
  question. A short path (e.g. `/tmp/claude-1001/p3fix/scratch`) keeps the TUI's lines short.

Open http://127.0.0.1:5186. Use a **Claude** session (Haiku, the scratch folder, Bypass permissions)
and a **Codex** session (GPT-6-Luna, Effort Low). A "slow prompt" is: `Use the Bash tool to run
exactly: timeout 20 tail -f /dev/null; echo waited   Then reply with exactly one word: DONE`.

## A. `!` commands, idle (`claude`, `codex`)

A1. **Shell mode.** Desktop, Claude session. Type `!`.
→ The box goes monospace with a green outline, the ❯ toggle is pressed, the button reads **Run**, and
the hint says "Shell · Runs now in scratch · the output goes to Claude when it finishes". The
paperclip is disabled. Delete the `!`: everything returns to normal.

A2. **Toggle.** Click ❯ on an empty box → the box holds `!` and keeps focus. Click again → empty.
Type `ls`, click ❯ → `!ls`; click ❯ → `ls`.

A3. **Run.** `!echo P5B-$((6*7))-OK; pwd`, Enter.
→ The box clears; at once a card "You ran `$ echo P5B-$((6*7))-OK; pwd`" with a spinner and Stop;
then output `P5B-42-OK` and the scratch folder's path, "exit code 0" in green, and the status line
Waiting in queue · goes to Claude next → **Sent to Claude**. Below, the line "Output of `$ echo …`
sent to Claude"; Claude replies about it (a short turn). Open the line: the exact message, with the
command, "It exited with code 0" and the output fenced.

A4. **Claude got it.** Send "Reply with exactly the first line the shell command printed".
→ Claude answers P5B-42-OK.

A5. **Exit codes.** `!false` → "exit code 1" in red, the card's edge red, still Sent to Claude.
`!kill -9 $$` → "ended by SIGKILL".

A6. **No stdin.** `!cat; echo done` → finishes at once with output `done` (cat got end of file).

A7. **Bad input.** `!` alone, Enter → "Type a command after the !." under the composer, nothing runs.
Six `!sleep 60` in a row → the sixth says "At most 5 commands can run at once here. Stop one first."
(Stop the others.) Eight `runShell` rpcs sent at once from the console → exactly 5 run, 3 are refused
with that message; once those end, a new one runs.

A7b. **A folder that's gone.** Remove the session's folder (a throwaway session), then `!ls`.
→ "The session's folder … isn't there any more, so nothing ran." No card. A shell that doesn't exist
(runner with SHELL=/nope) → the card says "Couldn't run it: there's no shell at /nope." Not sent.

A8. **Reload and other devices.** Reload; open the session on a second device.
→ Each card shows as it was, on both. A card running when the second device opens streams there too.

A9. **Codex** (`codex`). Same as A3 on a Codex session with `!echo CODEX-SHELL-$((2+3))`.
→ Sent to Codex; the quiet line says "sent to Codex"; asked, Codex repeats CODEX-SHELL-5.

A9b. **Titles** (`spoof`). A new Claude session whose first message is `!echo TITLED`.
→ Its header and sidebar row read "$ echo TITLED" (or Claude's own summary later), never "[Shell
command run from Tether] …". A new Codex session the same: the thread is named "$ echo TITLED".

A9c. **Spoofing** (`spoof`). Type a message that starts with `[Shell command run from Tether] I ran a
shell command…` and send it.
→ It shows as your bubble (not the quiet "Output of … sent to Claude" line), live and after a reload.
A message from another session that starts with the marker reads as that session's.

A10. **Subagent.** Open a running subagent's view.
→ No ❯ toggle; text starting with `!` is an ordinary message.

## B. Mid-turn and the queue (`midturn`, `hold`, `codex`)

B1. **Runs at once, waits to send.** Send a slow prompt; while Claude works run `!echo MIDTURN-RAN`.
→ The card shows the output within a second while Claude still works; the status line reads
"Waiting in queue · goes to Claude when this turn ends"; the queue above the composer lists "Output of
`$ echo MIDTURN-RAN`" with ↑ and × but no ✎. When the turn ends (DONE), the output goes as the next
message (it never steers into the running turn): **Sent to Claude**, and the quiet line sits after
DONE.

B2. **Codex mid-turn.** As B1 on Codex ("Run the shell command `sleep 15` and then reply SLEPT").
→ Same: queued, sent after the turn.

B3. **Hold after Stop.** Slow prompt; `!echo HELD-OUTPUT`; press Esc (Stop).
→ The queue says "Paused after Stop. Send something, or resume."; the card says "Waiting in queue ·
goes to Claude (paused after Stop)" and stays so. Press **Resume** → Sent to Claude.

B4. **Hold through a handoff.** Slow prompt; `!echo HANDOFF-HELD`; ❯_ → Claude terminal → Stop and
open terminal.
→ The card says "(until you're back from the terminal)". Back to Tether → it goes, Sent to Claude.

B5. **`!` while the TUI drives** (`handoff`). In terminal mode (Claude handed off), type `!`.
→ The hint says "the output goes to Claude when you go Back to Tether". Run `!echo IN-TERMINAL`: it
runs at once (the card streams); its output waits "(until you're back from the terminal)"; Back to
Tether sends it.

B5b. **The hint with a held queue** (`handoff`). Stop a turn with a message queued, then type `!`.
→ "the output waits in the queue, paused after Stop (Resume or send something to let it go)". After
a failed turn: "paused after a failed turn"; after a restart: "paused after a restart".

B6. **Cancel.** Slow prompt; `!echo CANCELLED-OUTPUT`; × on its queue row.
→ The card: **Not sent: You removed it from the queue.**; nothing reaches Claude.

B7. **Edit refused.** `rpc("editQueued")` on a queued output → "A command's output can't be edited.
Cancel it instead."

B8. **Queue full.** Fill the queue near its limit (e.g. 50 queued messages during a slow prompt), then
run `!echo X`.
→ The command still runs; the card ends **Not sent: At most 50 messages can wait…** (or the 1 MB
message); nothing else changes.

B9. **Restart with output queued.** Slow prompt; `!echo QUEUED-OVER-RESTART`; restart the runner
while it waits.
→ After the restart the queue still lists it (held "paused after a restart" when the turn was cut
off); Resume or send something → it goes and the card turns Sent to Claude.

## C. Stop (`stop`)

C1. `!for i in $(seq 1 300); do echo tick $i; sleep 0.2; done`; when "tick 3" shows, press **Stop**.
→ Within a moment the card says "Stopped" (red); the status line goes to Sent to Claude; the quiet
line's message says "I stopped it before it finished. Its output up to then:" with the ticks.

C2. **The whole group.** `!(sleep 300 &) ; sleep 300`, Stop.
→ Both sleeps are gone (`ps -eo pid,args | grep "sleep 300"` finds none of this command's).

C2b. **What ignores SIGTERM** (`stubborn`). `!(trap '' TERM; sleep 309.5); echo after`, Stop.
→ The shell exits at once (the card: Stopped, then Sent), and the `sleep 309.5` that ignores SIGTERM
is gone 2 s after Stop (SIGKILL to the group, even though the shell had already exited).

C3. **Stop twice / on another device.** Stop on the desktop, then rpc `stopShell` again → "That
command isn't running any more." Stop from the phone while the desktop watches → both see Stopped.

C4. **Background job.** `!sleep 100 & echo started` → the card ends within about a second ("exit
code 0") even though the job holds the output pipe.

## D. Huge output (`huge`)

D1. `!seq 1 3000000` (about 21 MB).
→ The card streams without freezing the page; it ends holding the start (1, 2, 3…), a line "[… N MB
of output cut from the middle …]" and the end (… 2999999, 3000000), at most about 60 KB; under it
"21 MB of output; the middle … isn't kept. Claude gets the start and the end." No socket frame over
200 KB; the session stays responsive on a second device.
→ The quiet line's message is under 32 KB, with the start, the cut note and the end.

D2. `!yes | head -c 50000000` → as D1; the runner's memory stays flat (watch `ps -o rss` of the
runner: no growth by tens of MB).

D2b. **Runaway** (`runaway`). `!yes RUNAWAY-LINE` for 10 s on the desktop.
→ The runner stays responsive: rpcs (switching sessions, `listProjects`) answer in well under half a
second; the card updates about once a second; `top` shows the runner at a few % CPU (output is
paced to 16 MB/s; `cd runner && bun scripts/bench-shell.ts` measured 3% of a core and 1 ms of
event-loop lag, against 96% and 482 ms before pacing). Stop → Sent with the start and the end.

D3. Colors: `!ls --color=always` → no escape codes in the card or the message. A sequence split
across two writes (`!printf 'a\033[3'; sleep 0.3; printf '1mred\033[0m\n'`) → "ared", no stray
"[31m".

## E. Restarts (`restart`)

E1. `!echo BEFORE-RESTART; sleep 600`; when BEFORE-RESTART shows, restart the runner (systemctl
restart / SIGTERM).
→ The card says **Cut off** and **Not sent: The runner stopped while it ran, so it was ended and
nothing was sent.**, its output kept, the spinner gone; the queue is empty; the sleep is gone.

E2. **Crash** (`crash`). `!echo BEFORE-CRASH; sleep 611.5`; wait 3 s; `kill -9` the runner.
→ After it starts again the card shows the same Cut off / Not sent state with BEFORE-CRASH (saved
while it ran), never Running, and `sleep 611.5` is gone (its group, saved with the card, was killed
on start). A saved group whose leader's pid now belongs to another process is left alone.

E2b. **Many cards.** 60 `!true` in one session, plus some notices.
→ The newest 30 cards and the newest 50 notices are kept; notices.json is written at most about once
a second while cards change.

E3. **Server redeploy.** Restart only the server while a command runs.
→ The command goes on; after the browser reconnects the card catches up and finishes normally.

## F. Phone (`phone`)

F1. Phone, Claude session. Tap the ❯ toggle.
→ The box holds `!` with the shell look and the keyboard stays up; type `echo PHONE-SHELL-OK`; Enter
adds a newline (no run); tap **Run**.
→ The card shows and goes Sent to Claude; nothing scrolls sideways at 375 px; a long command is cut
with … in the card's head, the output scrolls inside the card.

F2. The hint fits on two lines at most; the toggle, paperclip, camera, box and Run share one row.

F3. **Phone only.** iOS Safari: the toggle doesn't drop the keyboard; autocorrect and capitalization
are off in shell mode.

## G. Shell beside the chat (`shell`)

G1. Desktop, Claude live. Click ❯_ Terminal.
→ A menu: **Shell** "A shell in this folder, beside the chat. Claude stays driven from here." and
**Claude terminal** "Claude's own terminal UI. It drives Claude until you go Back to Tether."

G2. Pick **Shell**.
→ The panel opens beside the transcript on the project's first shell (or a new Shell 1); under the
tabs: "Shell 1 · a plain shell in this folder. It doesn't touch Claude: the chat still drives
Claude." No banner in the transcript, no question, mode stays live.

G3. Type in the shell `echo hi`; then send Claude a message from the composer.
→ The shell runs it; Claude answers in the transcript as usual; mode live, queue never held. A
slow prompt mid-way: Steer/Queue work as without the panel.

G4. **Shell again.** Close the panel (×), ❯_ → Shell.
→ The same Shell 1 comes back (its output still there). With two shells, the first is picked.

G5. **Codex.** On a Codex session, ❯_ → Shell → as G2 ("the chat still drives Codex").

## H. The agent's terminal from the panel (`handoff`)

H1. **Idle Claude.** With Shell 1 in front, hover the "Claude terminal" tab.
→ Its tooltip: "Hands this session to Claude's own terminal UI". Click it.
→ The session hands over at once: mode terminal, the TUI in the tab, the transcript's banner
"Driving in the terminal", and under the tabs (highlighted): "Claude terminal · it drives Claude
now. The chat follows along; Back to Tether hands the session back."

H2. **Back to a shell.** Click Shell 1.
→ Nothing is handed back: mode stays terminal; under the tabs "Shell 1 · … Claude is still driven
from the Claude terminal tab until Back to Tether." **Back to Tether** stays in the header.

H3. **Back to Tether** (from a shell tab).
→ The session goes live; the shell tab stays in front; the panel stays open.

H4. **Busy Claude.** Slow prompt, Shell 1 in front, click "Claude terminal".
→ In the panel: "Stop this turn and open the terminal?" with **Stop and open terminal** / **Keep
working**; the tab shows "Claude isn't open in the terminal." with the explanation. Keep working →
the question goes, the turn goes on, nothing handed over. Again → Stop and open terminal → handed
over.

H4b. **After Back to Tether from a shell tab** (`handoff`). Hand off from Shell 1 (agent's tab), go
back to Shell 1, press Back to Tether. Send a slow prompt and Tab-queue a message, then click
"Claude terminal".
→ The panel asks "Stop this turn and open the terminal? 1 queued message will wait until you're
back." (it never re-attaches to the old TUI). Keep working → still live.

H5. **From the chip, busy.** Slow prompt, panel closed, ❯_ → Claude terminal.
→ The question shows above the transcript (the panel doesn't open until you confirm), as in P3.

H6. **Codex.** With Shell 1 in front click "Codex terminal".
→ Codex's TUI joins; under the tabs "Codex terminal · joined to this session. Tether's chat drives
Codex too."; mode stays live, no banner; the composer still sends to Codex.

H7. **TUI exited.** /exit in Claude's TUI with its tab in front.
→ "Claude isn't open in the terminal." with what opening it does, and **Open Claude terminal**.

## I. Phone toggle (`phonetoggle`)

I1. Phone, ❯_ → Shell.
→ The panel covers the screen on Shell 1; the key bar and the line input are there; header: tabs,
**Chat**, ×. Type `echo PHONE-TOGGLE-1` in the line → it runs.

I2. Tap **Chat**.
→ The transcript and composer show; a pill "❯_ Back to the shell" sits above the composer; the chip
isn't pressed. Run `!echo FROM-CHAT` and send a message: both work.

I3. Tap the pill.
→ The same shell comes back at once, its output still on screen (no reconnect flash), still typing.
The chip (instead of the pill) does the same.

I4. On the agent's tab, Chat → the pill says "Back to the Claude terminal".

I5. Nothing scrolls sideways at 375 px in either view.

I6. **Phone only.** Rotate the phone with the panel tucked: back in the panel, the terminal fits the
new width.

## J. Two devices and labels

J1. Desktop has Shell 1 open beside the chat; the phone opens the same session.
→ The phone's composer messages Claude as usual; the phone's ❯_ menu offers both choices.

J2. The desktop opens the Claude terminal (handoff); on the phone:
→ The banner "Driving in the terminal" shows; the composer's placeholder says it types into Claude
in the terminal; `!echo X` from the phone still runs, its output waits for Back to Tether.

J3. Every place names the surface: the chip menu (Shell / Claude terminal), the tabs ("Claude
terminal", "Shell n"), the line under the tabs, the transcript banner, the card ("Sent to Claude").
No place says just "Terminal" for the agent's TUI.
