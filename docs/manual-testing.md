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
Groups Claude, ChatGPT, Kiro, Antigravity (`runner/src/credentials/accounts.ts`). Machine logins are
`claude:machine`, `chatgpt:codex`, `chatgpt:pi`, `kiro:machine`, `antigravity:machine`; extra accounts
live in `<config>/accounts/<provider>:<name>/{claude,codex,pi}` (mirror of the machine's config by
symlinks, minus the login file). Do this on a test runner (`TETHER_CONFIG_DIR=<scratch>`).
- [ ] Every login on the runner listed: "Max (you@)" style label, email/org, state, usage windows; the machine rows say "own login on this machine" and offer Sign out only
- [ ] Claude → Add → name "work" → "Open sign-in page" opens claude.ai in a new tab (from the phone); paste the code → row turns Ready with its own email and usage; `ls <config>/accounts/claude:work/claude` shows symlinks plus its own `.credentials.json`
- [ ] ChatGPT → Add → name → a device code and "Open page"; enter it at auth.openai.com → row Ready; "Sign in for pi too" shows the `PI_CODING_AGENT_DIR=… pi` command, `/login` there flips it
- [ ] Cancel a half-done Add: the account's folder is gone
- [ ] "Opus · Max (work@)" appears in the model picker / default order; a session on it answers and shows in the sidebar; reopening it resumes
- [ ] Default order "Opus on machine" → "Opus on work": simulate the limit on the first (`/tether simulate-usage`), the session moves to work
- [ ] Remove an extra account: folder gone, `~/.claude` untouched
- [ ] A session with an expired/missing login: the error notice has "Sign in to Claude" (opens Credentials), the inbox row reads "Sign in to Claude · …"
- [ ] The machine's own CLI logins still work after all of this (`claude auth status`, `codex login status`)
