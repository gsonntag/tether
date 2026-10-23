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

### AWS Bedrock (branch `bedrock`)
Checked 2026-10-23 on a test runner (screenshots in `.claude/credentials/shots-bedrock/`): the
machine's `[default]` profile lists with account (root), region and "expired" state; Test and List
models report the expired `aws login`; "Sign in again" relays `aws login --remote` up to the URL;
the Add form for both key kinds. Not checked: anything that needs a live AWS session.
- [x] `aws login` profile shows on Credentials with account, region, state and expiry; root warning
- [ ] Bedrock API key added from the Credentials page (last 4 shown, never the key); Test
- [ ] Access key id + secret added; Test
- [ ] "Sign in again" end to end: open the URL, paste the code, row turns Ready
- [ ] List models shows the region's inference profiles; "Test and add" adds one; "Type an id" works
- [ ] Claude Code on `us.anthropic.claude-opus-…` · Bedrock answers; pi on `amazon-bedrock/…` answers
- [ ] The process only has that credential's AWS variables (names only: `env | cut -d= -f1 | grep AWS` in a Bash tool call)
- [ ] `/tether simulate-limit rate` on a Bedrock entry backs off; `quota` moves down the chain

### Credentials page, accounts, sign-in
- [ ] Every login on the runner listed with account, plan, state, usage
- [ ] Sign in to Claude Code from the phone (OAuth URL + paste code); Codex device code
- [ ] Second account for the same provider; usage shown per account; limit on one moves to the other
- [ ] Sign out; expired login shows "Sign in" inline and in the inbox
- [ ] The machine's own CLI logins still work after all of this
