# Credentials: how to add a provider

Stage 0 of `.claude/credentials/SPEC.md` (branch `cred-foundation`). The seams every provider
branch (Foundry, Bedrock, accounts) builds on.

## Model

- A credential id is `"<provider>:<name>"` (`azure:east-coast`, `anthropic:work`). The prefix routes
  it to the plugin whose `provider` it is (`runner/src/credentials/registry.ts`).
- A chain / default-order entry names one as `harness:model#<id>`
  (`codex:gpt-6-luna#azure:east-coast`). `parseEntry` gives `ChainEntry.credential`; `entryProblem`
  checks the shape, and on save that the id exists on the runner.
- A session keeps it in `LiveState.credential` (persisted in `SessionPrefs.credential`) and sets it
  before `start()`. Every adapter calls `LiveSession.credentialLaunch()` once before it spawns its
  harness: the plugin's `envFor` goes over the runner env and your secrets (under Tether's own
  vars), `argsFor` goes on the command line (Claude Code: SDK `env` / `extraArgs`).
- Moving to an entry on another credential (or back to the harness's own login) is a handoff to a
  new linked session, never a model switch in the same process.
- Quota keys get `#<id>` (`providerOf(model, harness, credential)`, `quotaKey(entry)`): account A at
  its limit leaves account B usable. With a plugin `usage()` fallback confirms limits and switches on
  its own; without one the entry is "manual switch only".
- Values never leave the runner. `credentials/store.ts` keeps Tether-stored ones in
  `<config>/credentials.json` (mode 600); `views()` carries the last 4 chars at most. The guard
  protects `credentials.json`, `<config>/accounts/` and `secrets.json` wherever the config dir is.

## Interface changes after review (cred-foundation, after 49e7e1c)

Feature branches built on 49e7e1c adapt to these:

- `CredentialPlugin.action` answers a `CredentialActionResult` (`web/src/shared/credentials.ts`):
  `{ message?, url? (https only), code?, id?, models?: (ModelRef & { harness? })[], suggestions?: string[],
  next?: { action, prompt, field?, secret? } }`. Only those fields reach the app (`cleanActionResult`);
  anything else a plugin returns is dropped. `Ops.credentialAction` now answers `{ result?:
  CredentialActionResult; list }`. A sign-in flow returns `url` (and/or `code`) plus `next`; the page
  asks for `next.prompt` and calls `credentialAction(id, next.action, { [next.field ?? "code"]: input })`.
- `discover()` views are cut down to `CredentialView`'s own fields, each type-checked (`cleanView`); a
  `last4` longer than 4 is dropped. Messages (test, errors, discovery errors, `stateNote`…) are scrubbed of
  every known value (stored values, your secrets, values a process was given) as `••••`. A plugin's
  `test()` throwing becomes `{ ok: false, result: "error", message }`.
- `launchFor` checks env names: refused are `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `IFS`, `ENV`,
  `BASH_ENV`, `EDITOR`/`PAGER`, `NODE_OPTIONS`/`NODE_PATH`, `PYTHON*PATH/HOME/STARTUP`, `PERL5*`, `RUBY*`,
  `LD_*`, `DYLD_*`, `BUN_*`, `TETHER_*`, `GIT_*`, `SSH_*`, `XDG_*`, `SUDO_*`, proxies; always allowed are
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_*`, `AWS_*`, `AZURE_*`, `ANTHROPIC_*`, `OPENAI_*`, `PI_*`;
  anything else is allowed. New optional `envNames?(credId): string[]` declares names the deny list would
  refuse (a Codex provider's own `env_key`); those are allowed except the never-list (PATH, HOME, LD_*,
  DYLD_*, NODE_OPTIONS, BUN_*, TETHER_*, BASH_ENV…). `envNameAllowed(name, declared)` is exported.
- New optional `homeFor?(credId, harness): string | undefined` (absolute path): the harness's home for
  that credential (an account's `CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Tether then reads that session's
  native files there: Claude transcripts, listing, resume, native fork (`adapters/claudeHome.ts`, a session
  store over `<home>/projects`), Codex threads (`thread/list`, `thread/read` with `CODEX_HOME`).
  `context/paths.ts` has `claudeHome(cred?)`, `codexHome(cred?)` and `harness.claudeDir/claudeProjects/
  codexDir/codexMemories/codexMemoriesDb/codexAgentsMd/codexConfig(cred?)`; without a credential they
  are what they were. `usage.ts` exports `usageAtHome("claude-code" | "codex", home)` for a plugin's
  `usage()`. `envFor` must still set the home variable itself (homeFor only tells Tether where to read).
- Per-account homes go under `store.accountsDir()/<id>/<harness>/` with harness folder names `claude`,
  `codex`, `pi` (also `opencode`, `kiro`, `antigravity`, `gemini`). The guard treats only
  `.credentials.json`, `.claude.json` and `auth.json` at the top of such a home (and .env/keys anywhere)
  as secret; plans, memory, skills, tool output, `memories_1.sqlite` stay the agent's. Anything under
  `accounts/` outside a harness folder is secret. `settings.json`, `hooks.json`, `config.toml` and
  `mcp.json` in a home can't be edited by agents.
- `removeCredential(id, order?)` (registry) answers `{ usedIn }`; `Ops.removeCredential` answers the list
  plus `usedIn` ("Default order #2", "1 session"). A removed or plugin-less credential is unavailable at
  once (`credentialAvailable`, `entryAvailable`): `sessionStart`, `pickEntry` and `nextEntry` pass over its
  entries like an uninstalled harness. `usedIn` on views now also counts sessions ("2 sessions").
- `credentialModels` (model lists) answers from the last list and refreshes it in the background (the
  first ever call waits up to 2 s). The background model refuses `#` entries.
- Fork: a picked model without `#` runs on the harness's own login; "Default" keeps the session's
  credential. The fork dialog seeds the session's model as `modelKey({ id, credential })`. A fork or
  handoff onto another credential always goes by a brief (never the harness's native fork).
- Claude Code: `credentialOptions` refuses args that aren't `--flag [value]` instead of dropping them.
- `setChain` checks `#credential` entries against the runner's ids. `entryProblem` trims the credential
  (an empty one is no credential), like `parseEntry`.
- Web: the slot registry and types moved to `web/src/credentials/slots.ts` (re-exported from
  `credentials/index.ts`); tests import `./credentials/slots` so a slot importing the store (window) can't
  break them. Slot files can keep `import type { CredentialSlot } from "./index"`. The session usage pill
  shows nothing for a session on a credential (`UsagePill credential`).

## Adding a provider (a feature branch touches only these)

1. `runner/src/credentials/<branch>.ts` exporting a `CredentialPlugin`: `provider`, `label`,
   `discover()` (stored ones via `store.views(provider)` plus what it finds in shell/env/CLI; set
   `models` per harness and per-row `actions`), `envFor` (only this credential's variables), and
   optionally `argsFor`, `test`, `action` (also called with the bare provider id for provider-level
   actions such as `"add"`), `models`, `usage`, `remove`. Secrets go through `store.put` / `get` /
   `update` / `remove` (`get` is runner-only). Per-account homes go under `store.accountsDir()`.
2. `runner/src/credentials/index.ts`: replace your two `// slot <branch>:` comment lines (import,
   register) with the code they show. Keep the blank lines between slots so branches merge cleanly.
3. `web/src/credentials/<branch>.tsx` exporting a `CredentialSlot`: `provider`, optional `Add` form,
   `Row` (extra content under a row), `actionLabels`, `ownActions`. Forms call
   `rpc("credentialAction", { id, action, args })` and hand the returned `list` to `onList`.
4. `web/src/credentials/index.ts`: replace your two `// slot <branch>:` lines the same way.
5. Tests next to the plugin; `runner/src/credentials/credentials.test.ts` has the stub-session
   pattern that checks a credential's env and args reaching a spawned process.

Nothing else needs touching: model lists (`listModels` appends credential models), the chain
editor, the default order, the New session and fork pickers, labels ("GPT-6 Luna · Azure", from
`CredentialModel.credentialLabel` or the view's `label`), quota keys and the process-start hook all
work off the plugin. For local UI work, a test runner with `TETHER_EXAMPLE_CREDENTIALS=1` and a dev
web build show the example provider (`credentials/example.ts`, `web/src/credentials/example.tsx`).
