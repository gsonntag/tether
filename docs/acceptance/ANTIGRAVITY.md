# Antigravity acceptance

Antigravity sessions through `agy` (SPEC §6 **Antigravity**). The automated part drives the real `agy`
through Tether's own session core and terminal control:

```sh
cd ~/some-folder && agy   # once, to trust the folder (answer Yes), then quit with two Ctrl-Cs
bun scripts/antigravity-accept.ts ~/some-folder
```

It covers the checks marked *(script)*. The rest are in the UI, on a phone too.

## Sessions

- [ ] *(script)* New session → Antigravity, Gemini 3.8 Flash, Low: the first message asks before writing a
  file; Approve writes it. The header shows the model, Low, "Google AI Pro" and the context.
- [ ] *(script)* The title is Antigravity's own after the first turn, in the header and the sidebar.
- [ ] *(script)* A message sent while it works queues, and goes after the turn. There is no "steer".
- [ ] *(script)* Stop ends a running turn; an open request closes.
- [ ] Deny (no reason) stops the turn; "Deny with reason" isn't offered.
- [ ] Model, effort and mode changed between turns apply to the next turn. Plan mode plans without editing.
- [ ] Sessions started in `agy` itself are listed under their folder, with their transcripts (tool cards:
  command, diff, file written), and can be continued from Tether.
- [ ] The `/` menu lists Antigravity's commands and skills; `/compact` runs.
- [ ] Reload mid-turn: the turn streams on. Restart the runner mid-turn: the turn is marked cut off, and a
  new message continues the conversation.

## Terminal

- [ ] *(script)* The Antigravity entry in the Terminal panel hands the session to `agy --conversation`; a
  turn typed there shows in the read-only transcript; Back to Tether quits it, and Tether drives again.
- [ ] A permission prompt in the TUI, or the folder-trust question in a new folder, shows Needs you; it
  clears once the TUI's prompt is back.
- [ ] Back to Tether while the TUI asks, or with text typed: it still quits.
