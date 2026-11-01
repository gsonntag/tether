# API credentials acceptance

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

## Credentials page

- [ ] Desktop and 375 px phone: open Credentials with the settings button beside the user's name. Exactly Claude/Anthropic,
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
- [ ] Compare the session estimate after two turns and a reload/resume with the provider's usage
  record. Enter the resource's Azure rates. Claude's TUI intentionally makes cost coverage unknown.
- [ ] Temporarily invalidate/revoke each key: the next turn fails on the named source with no
  subscription usage. Restore/unset through Credentials. Check all three provider usage records.
