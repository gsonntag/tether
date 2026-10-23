# Manual testing checklist

Things automated tests can't cover: real phones, real pushes, real harness logins and limits.
Tick them off as they're checked (date + device). Add to this list whenever something ships that
only a person can verify. Never use the prod runner for limit/credential experiments; see
`docs/fallback-testing.md` for the isolated test-runner setup.

## Shipped, not yet checked

### UX rework (#22 – #25, live 2026-10-23)
- [ ] Transcript stays at the bottom while an agent streams; scrolling up stops following; new message jumps back
- [ ] Cmd/Ctrl+F finds text in a long session, desktop and phone
- [ ] Home inbox: a real permission request, question and plan show in the right order; Approve/Deny from Home reaches the session once
- [ ] Sidebar shows full session titles (two-line rows) on desktop and phone drawer
- [ ] Notifications banner: "Turn on" on desktop; iPhone "Add to Home Screen" path, then push permission from the installed app
- [ ] Composer while running: Enter steers, Tab queues, ⌘/Ctrl+Enter stops and sends, Shift+Enter newline, Esc stops (desktop); Steer button + chevron menu (phone)
- [ ] Docked approval card above the composer: Approve, Always allow, Deny
- [ ] Blocked-by-judge push arrives on the phone with the command and reason; Approve from the notification works; tapping opens the session at the card
- [ ] "Full access for 15 minutes" shows "Full · Nm" countdown and returns to the previous mode after 15 minutes
- [ ] Settings → Approvals: per-project Always allow rules show and can be removed

### Leader removal (#26) and #21, #7
- [ ] No Leader in sidebar, Home or Settings; old leader chat opens as a normal session under a "leader" project
- [ ] Old leader messages in that chat render as plain text, no crash
- [ ] Changes view: binary files are left out of the diff

### Fallback (never run end to end on real harnesses)
- [ ] Work through `docs/fallback-testing.md` checklist: same-harness switch, mid-turn switch, cross-harness handoff (Claude Code → Codex), every-entry-exhausted wait, return to earlier entry after reset

## Coming (check when each PR ships)

### Default order (PR a)
- [ ] Home shows "Set your default order" until saved; editor pre-filled with what's signed in
- [ ] New session with no model picked starts on the first entry; its chain is a copy of the default
- [ ] Editing the default changes new sessions only
- [ ] Old profile-based sessions still run

### Microsoft Foundry
- [ ] azure-luna / azure-sol / azure-astra Codex profiles appear as models; a session on each answers
- [ ] Key found from ~/.bashrc (shown as the source); "Store in Tether" works; the full key is never visible in the UI
- [ ] Add API key from the Credentials page; Test; Add model by deployment name; it appears in picker and default order
- [ ] pi on Foundry with the same key
- [ ] Fallback from ChatGPT login to Foundry when the ChatGPT limit hits

### AWS Bedrock
- [ ] Bedrock API key and `aws login` profile both show on Credentials with region and expiry
- [ ] Claude Code on a Bedrock model answers; pi on Bedrock answers
- [ ] Model list / inference profiles for the region; Test per model
- [ ] Throttling backs off; quota error moves down the chain

### Credentials page, accounts, sign-in
- [ ] Every login on the runner listed with account, plan, state, usage
- [ ] Sign in to Claude Code from the phone (OAuth URL + paste code); Codex device code
- [ ] Second account for the same provider; usage shown per account; limit on one moves to the other
- [ ] Sign out; expired login shows "Sign in" inline and in the inbox
- [ ] The machine's own CLI logins still work after all of this
