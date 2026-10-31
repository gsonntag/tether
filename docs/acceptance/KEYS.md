# API credentials acceptance

Use an isolated runner, data directory, tmux socket and ports. Never use production directories,
the running runner, or the shared Codex daemon for a key test. Keep artifacts under
`/tmp/claude-1001/keys/`; hold `flock -o /tmp/claude-1001/e2e.lock` for every test stack. Check load
below 8 and at least 5 GB free before starting. Hash `~/.codex/config.toml` before and after: stop
immediately if it changes. Never accept a trust prompt. Use only Haiku and gpt-6-luna at Low.

## Credentials page

- [ ] Desktop and 375 px phone: open Credentials from the sidebar. Exactly Claude/Anthropic,
  Codex/Azure and Codex/OpenAI slots appear. Multiple runners have a runner selector.
- [ ] Save a random fake Anthropic key. The password field clears immediately; status becomes Set,
  optionally with last four characters. Reload: only status is returned, never the key.
- [ ] Save OpenAI, then Azure with HTTPS endpoint and optional deployment. OpenAI becomes Not set.
  Reverse them: Azure becomes Not set. There is no separate enable switch or session picker.
- [ ] Unset an inactive slot: the active slot remains. Unset the active slot: both Codex slots are
  Not set, including after reconnect and runner restart. Neither old key returns.
- [ ] Invalid endpoint/key and unavailable runner show terse inline errors; no key is repeated.

## Harness and process boundaries

- [ ] Start a subscription session and confirm the harness reports Claude plan / ChatGPT plan.
  No API indicator appears. Plan usage, when reported, is early enough to see on a phone.
- [ ] Set a fake key while a turn runs. Its label stays on the original source and that turn ends.
  The next queued or manually sent message restarts an idle live process first.
- [ ] Anthropic: the new process confirms Anthropic API key before sending. A rejected fake key
  stops with an error; it never calls the subscription. An Unknown/mismatched report refuses send.
- [ ] OpenAI: a private Codex process confirms the key provider; its fake-key turn fails on that
  source. The shared subscription daemon's PID, environment, login and configuration remain intact.
- [ ] Azure: supply an endpoint and optional deployment. Its private process confirms Azure; a
  fake-key/invalid-endpoint turn stops there, without trying OpenAI or the subscription.
- [ ] Unset Anthropic; send again in the same idle session. A fresh process confirms the
  subscription, with no inherited API/provider variables. Confirm it can answer on Haiku.
- [ ] Unset a Codex key. Existing sessions belonging to another source refuse continuation rather
  than moving. A new gpt-6-luna/Low session confirms the ChatGPT subscription.
- [ ] Rotate a key while another session uses the previous revision. That turn finishes; rotation
  never restarts a daemon serving another session's active turn.
- [ ] Runner restart: key sessions list with their history and correct source. Resume the same
  source and confirm it again before send. Existing subscription sessions remain unchanged.

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
  spend is excluded. Unknown prior usage, cache-write breakdown or Azure rates says Cost unknown.
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
  records it. Unset; the next process confirms Claude plan and uses the subscription.
- [ ] OpenAI: a new gpt-6-luna/Low thread and TUI show OpenAI API key; Platform usage records it.
  Reload/restart and resume. Unset; a new subscription thread confirms ChatGPT plan.
- [ ] Azure: use the actual Foundry endpoint/deployment. A new thread and TUI show Azure and usage
  reaches that resource. Replacing Azure with OpenAI never reactivates Azure when OpenAI is unset.
- [ ] Temporarily invalidate/revoke each key: the next turn fails on the named source with no
  subscription usage. Restore/unset through Credentials. Check all three provider usage records.
