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
