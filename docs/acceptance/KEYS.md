# API credentials acceptance

## Per-session sources (2026-11-01)

Real Claude/Haiku and Codex/gpt-6-luna at Low, in a browser, with random fake keys, on a private stack:

- With a fake key set, a Claude plan and a ChatGPT plan session each started, confirmed its label and
  replied. Their processes (and their TUIs) had no key variable with a value in `/proc/<pid>/environ`.
- A session on each fake key (made through the picker) showed the badge and stopped with no reply from
  anywhere. A Codex key's process had no key value and its private home no login. A Claude key's process
  had no key variable. Side by side in the Sidebar at desktop and in the phone's menu.
- After a dev runner restart with the key set, the plan session resumed and replied. A stored Codex
  thread with no record, the kind that was refused, ran on the plan in place, with the key set.
- A replaced key carried on in the same session. An unset key stopped with the source named in chat and
  in the op, the badge unchanged, nothing sent.
- Claude's source, from the billing chip, went from plan to key and back at the next start, the label
  following the harness; an open TUI refused it. Move changed source on the same harness for both,
  with the old session unchanged (`scripts/e2e-move.mjs sourceChange`).
- A file in the version 1 shape read, offered its key and migrated on the next change, its revision
  kept. The new web on a runner from before this change showed no picker and worked.

## Cost reasons (2026-11-01)

No real key: `scripts/e2e-cost.ts` ran every response shape through the real private host and a fake
upstream, and `sourceCarry` followed the amount over takeovers with Azure rates on a fake endpoint.
Neither is a real OpenAI response: see Real-key checks.

## When the plan runs out (2026-11-01)

No source ever changes by itself, with one exception: the checkbox in the billing chip's menu, ticked
by you, for that session (SPEC §10 has the signals). Without it, an exhausted plan stops on the plan.

- Unit: `runner/src/adapters/claude/limits.test.ts` and `codex/limits.test.ts` have a fixture for each
  signal and each non-signal, `runner/src/core/planOut.test.ts` the switch on the real core.
- Browser, desktop and 375 px, on the real core with scripted frames through the real stream parsers
  (`scripts/limit-runner.ts`, `scripts/e2e-auto.mjs`, with made-up keys): plan lines on plan and key
  sessions, no line when nothing is reported, a stale figure's age, the box saved over a reload and
  hidden with no key, the switch and its one notice, tools run and not resent, a short 429 changing
  nothing, the target with two keys, the notice across a carry.
- Not run: a really exhausted plan, on either harness. The signals come from Claude Code's stored
  limit messages and CLI and from Codex 0.164's schema and stored rollouts, and a key that really
  works wasn't used. A Claude `rate_limit_event` of status `rejected` hasn't been seen live.

## Verification record (2026-10-31–2026-11-01)

- All four packages typecheck; 851 unit tests pass.
- The complete default P1 and P4 browser suites passed. Optional P1 stored paging/compacted-history
  fixtures were not supplied. P4's conditional subagent approval branch was skipped because the
  subagent did not request approval; its permission behavior has unit coverage.
- Real Claude/Haiku with a random fake key confirmed Anthropic API key, stopped on the SDK's
  authentication retry event, and emitted no fallback answer. After unset, a fresh process
  confirmed Claude plan and answered. Descendant argv/environment, transcripts and temporary
  logs/JSONL contained no complete fake key.
- Real isolated Codex/gpt-6-luna at Low confirmed the private OpenAI and Azure providers with
  fake keys. Local upstream probes independently returned 401 and 429, or refused the connection:
  each turn failed without fallback; 401/429 made exactly one upstream request. A provider error
  reflecting the complete key did not enter native notifications or files. The key was absent
  from process command lines and the Codex child's environment.
- Browser screenshots were inspected at desktop and 375 px in light/dark: Credentials, each API
  source, Unknown, subscription, Home markers, estimates/unknown costs and local retry time.
- `scripts/e2e-keys.mjs` with `REAL_HARNESSES=1` ran each source in the browser with fake keys,
  Azure included: confirmed label, stop without fallback, dev runner restart, TUI startup and unset.
  Process argv was read across every process while keys were live, and no key was found there or
  anywhere under the artifact root but the private file.
- Valid API-key inference, provider invoice/usage reconciliation and real-device touch behavior
  remain owner checks. A Claude TUI's unobserved spend, missing Azure rates and incomplete pricing
  metadata deliberately show Cost unknown.

Artifacts are under `/tmp/claude-1001/keys/`. The shared Codex configuration SHA-256 remained
`8b73d3941d6f02f411b3baedff3d4a936b5543a2b69a0d047bf123d201740493`.

Use an isolated runner, data directory, tmux socket and ports. Never use production directories,
the running runner, or the shared Codex daemon for a key test. Keep artifacts under
`/tmp/claude-1001/keys/`; hold `flock -o /tmp/claude-1001/e2e.lock` for every test stack. Check load
below 8 and at least 5 GB free before starting. Hash `~/.codex/config.toml` before and after: stop
immediately if it changes. Never accept a trust prompt. Use only Haiku and gpt-6-luna at Low.

## When the plan runs out

- [ ] Desktop and 375 px: the billing chip's menu shows the plan's windows on a plan session and on a
  key session, by the plan's name; nothing reported is no line; the chip shows a % only on a plan.
- [ ] The box shows only on a plan session with a key set, off by default, and toggling keeps the menu
  open. With two Codex keys it names the target, the session's last-used key, else OpenAI.
- [ ] Ticked, a real exhausted signal switches once, with one notice and the loud badge, and the message
  goes once more; if tools ran it isn't resent and the notice says so. It stays on the key.
- [ ] Unticked, or on a short 429, a network error, auth, overloaded or a 5xx: nothing switches.
- [ ] A key that fails after the switch stops with the usual error, with no further switch.

## Credentials page

- [ ] Desktop and 375 px phone: open Settings with the button beside the user's name; Credentials is its only subpage. Exactly Claude/Anthropic,
  Codex/Azure and Codex/OpenAI slots appear, and only keys: nothing says which is in use. Multiple
  runners have a runner selector.
- [ ] Save a random fake Anthropic key. The password field clears immediately; status becomes Set,
  optionally with last four characters. Reload: only status is returned, never the key.
- [ ] Save OpenAI, then Azure with HTTPS endpoint and optional deployment, then Anthropic. All three
  stay Set, including after reconnect and runner restart. There is no enable switch.
- [ ] Unset one: the others stay Set, and no session changes source. An unset key doesn't return.
- [ ] Invalid endpoint/key and unavailable runner show terse inline errors; no key is repeated.

## Source picker

- [ ] New session, desktop and 375 px: Source lists only what exists for the harness. A key that isn't
  set isn't listed; a harness with no login has no plan. One source shows without a picker. A key in
  the picker has the API colour, and Create is reachable on a phone.
- [ ] It starts on the subscription, even with keys set. Choose a key and create: the next New session
  starts on that key, on this runner, and the picker shows it. Unset it: back to the subscription.
- [ ] `newSession` with no source (an older web) is the subscription, with keys set.
- [ ] A web ahead of its runner shows no picker, and New session and Move still work.
- [ ] A version 1 `credentials.json` reads; its key is offered, and the next change rewrites it.

## Harness and process boundaries

- [ ] With a key set, start a subscription session and confirm the harness reports Claude plan /
  ChatGPT plan. No API indicator appears. Plan usage, when reported, is early enough to see on a phone.
  `/proc/<pid>/environ` of what it starts has no key variable with a value.
- [ ] Set a fake key while a subscription session is idle or running: nothing changes for it, and its
  process isn't restarted. Replace a key while a turn runs on it: that turn ends on the old key, and
  the next queued or manually sent message restarts the idle process with the new key first.
- [ ] Anthropic: the new process confirms Anthropic API key before sending. A rejected fake key
  stops with an error; it never calls the subscription. An Unknown/mismatched report refuses send.
- [ ] OpenAI: a private Codex process confirms the key provider; its fake-key turn fails on that
  source. The shared subscription daemon's PID, environment, login and configuration remain intact.
- [ ] Azure: supply an endpoint and optional deployment. Its private process confirms Azure; a
  fake-key/invalid-endpoint turn stops there, without trying OpenAI or the subscription.
- [ ] Unset a key; send again in a session on it. A chat error names the source, nothing is sent, the
  badge stays, and no process starts. Set it again: that session carries on.
- [ ] An existing subscription session resumes with keys set, and a stored Codex thread with no record
  runs on the ChatGPT plan in place.
- [ ] The billing chip, quiet, loud and Unknown, opens the harness's sources with its own marked, at
  desktop and 375 px with no sideways scroll. The ⋯ menu has no Source. A subagent and an old runner:
  plain text. A key that isn't set: Add API key… opens Credentials.
- [ ] Claude: pick another. A chip says what's next, the label stays what's confirmed until the next
  start confirms it. An open TUI and a running turn refuse it, with the reason on the item.
- [ ] Codex, the same menu with the same wording (`scripts/e2e-move.mjs sourceCarry`): a refused key
  stays on its thread and label with the message in the box, an error in the chat and the change
  waiting; a source that answers takes over with no new-session wording, the same title and history
  and one row; old links follow, also after a runner restart; there and back stacks no rows, and the
  real plan answers from what came across. A fake key can't prove a real key accepts the imported
  history: that's in the owner checks.
- [ ] Move to the same harness with another source: a new session with the context, confirmed before
  anything is typed; the old session stays as it was.
- [ ] Rotate a key while another session uses the previous revision. That turn finishes; rotation
  never restarts a daemon serving another session's active turn.
- [ ] Runner restart: both kinds list with their history and correct source. Each resumes on its own
  source and confirms it again before send.

## Terminal and indicators

- [ ] Open each source's TUI. It uses exactly the session's confirmed source, including after a
  handoff/rejoin. If confirmation cannot be established, opening fails clearly before any send.
  No trust, env-key-choice or login prompt is accepted. User harness configuration is unchanged.
- [ ] API badge names the precise source: Anthropic API key, OpenAI API key, Azure. It is first in
  the chip row, fully visible at desktop and 375 px, even beside a long permission Mode chip.
- [ ] Composer, sidebar row and Home row use the same API colour. Contrast is accessible in light
  and dark. API sessions never show plan percentages. Unknown is neutral and says Unknown.
- [ ] Take and inspect desktop/phone screenshots in both themes. No horizontal page overflow.
- [ ] Click title: focused, selected inline input. Enter saves and updates Sidebar/Home/another
  browser; Escape cancels. Refresh and rediscover preserve the title. Renaming runs no harness.
- [ ] API badge shows cumulative USD with `est.` for estimates. Repeated usage events do not
  double-count; restart/resume does not add restored earlier totals again. Subscription-equivalent
  spend is excluded. Unknown prior usage or Azure rates says Cost unknown, its reason in the tooltip.
  A report that can't be priced beside ones that are reads `~$0.02+`; without a figure, Cost unknown.
- [ ] `NODE_TLS_REJECT_UNAUTHORIZED=0 bun scripts/e2e-cost.ts <dir> <port>`: the real private host
  in front of `scripts/fake-responses.ts`, each response shape; `costs.json` holds only numbers, ids
  and codes. A source change carries the amount, there and back (`scripts/e2e-move.mjs sourceCarry`).
- [ ] Azure optional USD / 1M rates persist beside the key. Cached reads are priced once; writes
  without sufficient rates remain unknown. A pending request/crash never leaves a false complete
  total. Opening a Claude key TUI marks its unobserved cost incomplete.
- [ ] With browser timezone America/Los_Angeles, a usage-limit retry at `Nov 1st, 2026 2:33 AM`
  (runner UTC) displays `Oct 31, 2026, 7:33 PM PDT`. Raw transcript text is unchanged; UTC and DST
  boundary tests cover conversion.

## Secret audit

- [ ] `credentials.json` is mode 600. No other file in the isolated data/artifact roots contains
  any complete fake key (source code generates them in memory, rather than embedding literals).
- [ ] Inspect runner/relay logs, notices, session prefs, rollouts, terminal helper files and captured
  protocol frames. No full fake key appears outside the credentials file, even in failure text.
- [ ] Inspect `/proc/<pid>/cmdline` for runner, harness, helper and tmux commands. No key appears.
- [ ] Inspect browser DOM, returned RPCs and screenshots after saving. Only Set/Not set and last
  four may be visible. No secret is sent back through events, errors or terminal output.
- [ ] Reject auth, quota and network paths independently. Every failure stops with its source
  unchanged. Split a reflected fake key across terminal chunks and verify complete redaction.

## Real-key checks (owner only)

Enter keys only in Tether's Credentials page, never in chat.

- [ ] Anthropic: a short Haiku turn and its TUI show Anthropic API key; the Anthropic usage record
  records it. A plan session beside it uses the subscription.
- [ ] OpenAI: a new gpt-6-luna/Low thread and TUI on it show OpenAI API key; Platform usage records it.
  Reload/restart and resume. A ChatGPT plan thread beside it records nothing on Platform.
- [ ] Azure: use the actual Foundry endpoint/deployment. A new thread and TUI show Azure and usage
  reaches that resource, with the OpenAI key set too.
- [ ] From a ChatGPT plan session with history, tool calls and a compaction, pick OpenAI API key, then
  Azure, then the plan: each first message is answered from the history, and Platform usage records
  only the key's turns.
- [ ] A real OpenAI key's first turns are what prove the pricing, since nothing here has seen a real
  response. In the session's private `costs.json`, `resp_…` reports should have `usd`. Their `notes`
  name what the API left out: `no-cache-ttl` means no lifetime breakdown, `tier:missing` or
  `tier:auto` means no tier. A report with `reasons` and no `usd` names the real cause.
- [ ] Compare the session estimate after two turns and a reload/resume with the provider's usage
  record. Enter the resource's Azure rates. Claude's TUI intentionally makes cost coverage unknown.
- [ ] Temporarily invalidate/revoke each key: the next turn fails on the named source with no
  subscription usage. Restore/unset through Credentials. Check all three provider usage records.
