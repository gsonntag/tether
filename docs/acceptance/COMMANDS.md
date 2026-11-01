# Commands and skills acceptance

Against a dev stack (P1.md, P4.md Setup), Claude on Haiku, Codex on gpt-6-luna at Low. Never run
`/login`, `/logout`, `/config`, `/install`, `/plugin` or anything that changes `~/.claude` or
`~/.codex` by hand here; through Tether, `/config` must stop at Tether. No prompt in plan mode.

Scratch: a command `.claude/commands/slash-hello.md` and a skill `.claude/skills/slash-probe/SKILL.md`
for Claude; a skill `.agents/skills/slash-probe/SKILL.md` for Codex.

## The menu (desktop and 375 px)

- [ ] "/" at the start of the box lists the session's commands and skills, name and description.
- [ ] Typing filters; the full name comes first; a plugin's come after the session's own.
- [ ] ↑/↓ move, Enter and Tab pick, Esc closes and stays closed until the box changes.
- [ ] A command with arguments lands in the box with a space and the cursor after it.
- [ ] Enter on a command that takes nothing, or typed in full, sends it.
- [ ] On a phone rows are at least 44 px, a tap fills the box, nothing scrolls sideways.
- [ ] `!` still turns the box into a shell; "/" after text opens nothing.
- [ ] A session with no process has a menu too. A runner without `listCommands` has none, no error.
- [ ] A command file added mid-session shows within 30 s, between turns.

## Claude

- [ ] `/context`, `/usage`: output in the chat. `/compact`: "Context compacted."
- [ ] `/goal <condition>`: "Goal set", Claude works, "Goal met: …". Unmet: "Not done yet: …".
- [ ] `/goal` that can't be met: 9 tries, then the chat says Claude Code ended the turn.
- [ ] `/slash-hello Gavin`, `/slash-probe`, a plugin skill run.
- [ ] `/help`, `/config`: "/… needs the terminal." `/config` doesn't reach Claude Code.
- [ ] `/model` and `/effort` say what's set; with a value, the header changes; nothing writes settings.
- [ ] `/rename x` changes the title. `/clear`: new conversation, chat carries on.
- [ ] "/tmp/x is a path" and "/nosuch" reach the model as typed.
- [ ] A session reopened from the store reads the same.

## Codex

- [ ] The menu has `/compact`, `/goal`, `/review` and the folder's skills, marked Skill.
- [ ] `/compact`: "Context compacted."; `/goal x`: "Goal set", a turn, "Goal met"; `/goal`, `/goal clear`.
- [ ] `/slash-probe` runs the skill; the message reads as typed.
- [ ] `/review` and `/review <instructions>` end; the session goes idle.
- [ ] `/status`: "/status needs the terminal." `/model` says what's set.
- [ ] `sha256sum ~/.codex/config.toml` is the same before and after.

## Queue

- [ ] A command during a turn (Enter or Tab) shows in the queue, runs after the turn, in order.
