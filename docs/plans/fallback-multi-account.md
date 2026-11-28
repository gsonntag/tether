# Fallback chain: several Claude accounts as separate steps, and a redesigned editor. Final plan, revised after review

All code references are to `/home/ubuntu/tether-worktrees/fallback-plan` @ 6606eb4. I edited nothing.

## What changed after the critic's review (checked against the code)

| Critic point | Verdict | What the plan does now |
|---|---|---|
| 1. Comparing by source breaks the main login | **Confirmed.** `confirmClaudeBilling` returns `billing` without a `source` for the main login (`claude/credentials.ts:87-88`). The adapter label for `subscription` has no `source` either (`claude/index.ts:161`). | Compare `(billing.source ?? "subscription") === asked` together with the label. Moved down to low priority. |
| 2. `sameAccountAs` is mostly blocked already | **Confirmed.** Adding an account fails with "This Claude account is already added." (`harnessLogin.ts:300-301`). | Kept as a cheap runner-side warning. No longer a headline feature. |
| 3. `wakeAt` duplicates existing state | **Confirmed.** `prefs.fallbackResumeAt` (`live.ts:1929-1938`) is re-armed after a restart (`:1916`). | Expose `fallbackResumeAt` instead. |
| 4. The name `fallbackStatus` is taken | **Confirmed.** It is a bus event (`events.ts:15`, emitted at `live.ts:2114,2135,2150`). | Renamed to `fallbackRun`. |
| 5. Moving Bedrock to `DeploymentPicker` breaks validation | **Confirmed.** `fallbackStepProblem` (`shared/fallbackChain.ts:51-53`) special-cases only Azure. There is also a gap the critic missed: a Bedrock step whose model doesn't resolve passes validation but is **silently skipped** at hop time (`live.ts:2105-2106`). | Bedrock keeps the harness model `<select>`, filtered to models that `resolveSourceModel` can map. `fallbackStepProblem` gets a Bedrock check. |
| 6. A signed-out extra account stops the chain | **Partly verified.** `sources()` filters out only accounts that are mid sign-in (`live.ts:1537-1538`), so a signed-out account passes `fallbackStepProblem`. I inferred the failure that follows (`confirmClaudeBilling` throws on resend, then the chain stops). | New rule B8: check the account's sign-in at hop time, and treat a failed account start as a failed step. |
| 7. Account-wide backoff vs per-model limits | **Confirmed.** Claude's `PlanUsage` has only `fiveHour`/`week`, with no model pools (`shared/transcript.ts:328-338`, `live.ts:2184-2188`). | Backoff is shared only between steps with the same account **and the same model**. Steps on other models rely on the usage check (B1). |
| 8. B1 should use `planFor`, not refresh | **Confirmed.** `refreshPlan(harness)` takes no source (`sessions.ts:523-527`). `planReset` already reads `s.state.plan`, which `notePlan` scopes per account (`sessions.ts:509-516`). | B1 reads `planFor` directly. B7 shrinks to persistence only. |
| 9. Hex labels on other surfaces | **Confirmed.** `SessionHeader.tsx:153,160`, `MoveDialog.tsx:174`, `sourceMenu.ts:30` (the critic said `:83`). | Added to PR 2. |
| 10. Transcript notices stay hex | **Valid.** | Notices name the step number, which owners can match to the card. Proper renaming waits on open question 1. |
| 11. The background-work wait has no cap | **Confirmed.** The loop at `live.ts:1987-2001` exits only on Stop, shutdown or a chain change. Manual switches are refused meanwhile (`:1608,1624`). | 30-minute cap, a visible "Waiting…" state, and Stop as the escape. Open question 3. |
| 12. Live status must be restored on open | **Valid, wrong location.** The restore on open is `sessions.ts:343`. `live.ts:1853-1858` is `keptPrefs`, which hands `fallbackProgress` to a session's successor after a move. | Derive `fallbackRun` in both places. |
| 13. The account sort key is fragile | **Confirmed.** The file is written once with `wx` (`accounts.ts:61`); the list is sorted by directory name (`:67`). | Store `createdAt` in `.tether-account.json`. Older files fall back to that file's mtime. |
| 14. `{stored:true}` and older runners | **Verified compatible.** The relay copies args through (`server/src/relay.ts:275,322`) and the runner passes them untyped (`ops.ts:24-30`). But `useAccountLabel` still runs `harnessLoginStatus` for the main login (`accountLabel.ts:25`), and `{stored:true}` would lose `available`. | `{stored:true}` dropped from scope. The dialog renders right away with runner labels and swaps names in when they arrive. |
| 15. Existing duplicates become unsaveable | **Valid.** | On load, duplicates are marked with a one-tap "Remove duplicate". Save is blocked until they are fixed. |
| 16. Steps with no explicit mode aren't re-mapped at hop time | **Wrong.** `advanceFallback` fetches a fresh `fallbackCatalog` for each hop (`live.ts:2079`). `defaultMode` and the permitted modes come from the session's *current* mode (`:1755-1766`). Steps with no mode use `catalog.defaultMode` at that moment (`:2104`). Explicit modes above the ceiling are caught by `fallbackStepProblem` and skipped. | No design change. One narrow race remains: the mode is lowered between fetching the catalog and `setSource` (`:1627-1628`). It gets a test, and is treated as a step problem instead of ending the chain. |
| 17. The pinning test needs more cases | **Valid.** | The test list now covers waking, returning, problem-step backoff and the identical-step skip. |
| 18. Moving preset ops to manage-only is a policy change | **Confirmed.** No fallback op is in `VIEW_OPS` or `MANAGE_OPS` (`shared/access.ts:18-45`). | Now open question 5, not part of a PR by default. |
| 19. A new `LiveState` field reaches every subscriber | **Valid.** | `fallbackRun` carries no `sessionId`, `after` or `lastUserText`, and a test checks this. |
| 20. Don't promise a return | **Confirmed.** The check at `live.ts:393-394` also needs idle status and no `nextSource`. | The "Now" card mentions a return only when `nextBilling` is absent. |

## Judging the proposals

| Proposal | Best ideas | Weaknesses |
|---|---|---|
| **Mobile-first** | Short step cards with the editor one tap away. "Add step" picks a source in one tap. Remove only inside the editor. Stable keys. Warnings before Save. | Three screens, a bottom sheet and nested preset dialogs is a lot to build. It relies on `DropdownMenu presentation="bottom-sheet"`, which Tether has never used. Its status data comes only from `fallbackSetup`, so the chip can't use it. |
| **Consistency** | Reuses only existing components. Accordion inside one dialog. Presets in `<details>`. Readable labels for missing sources. Smallest set of PRs. | Leaves "Enable" ticked by default. The chip doesn't name the account. No status data, so nothing in the dialog shows what is happening. |
| **Clarity** | Live run state in `LiveState`, so the chip and dialog show it with no call. A shared `fallbackPlan()` so the screen can't disagree with the runner. A "Now" card. | Biggest scope. Refactoring `advanceFallback` is risky. "Claude plan 2" numbering needs a new field plus a backfill. |

**What the plan takes from each:**
- Structure from Consistency: accordion cards in one dialog, `<details>` for presets, existing components only.
- Interactions from Mobile-first: "Add step" picks the source first, Remove sits inside the editor, warnings before Save.
- Data from Clarity: `fallbackRun` in live state and a shared `fallbackPlan()`, pinned by tests rather than a refactor, plus its "Now" summary.
- Labels from the existing owner-only `useAccountLabel`, with no new op.

## Summary

You can already chain "Claude plan X, then plan Y". The runner treats each extra account as its own source (`account:<uuid>`). A hop restarts Claude under that account's folder (`CLAUDE_CONFIG_DIR`) and resumes the same conversation.

Five problems remain:
1. **The dialog can't tell accounts apart.** It shows `billing.label`: "Claude plan" or "Claude plan · 3f2a9c1e". The same hex label appears in the "Next:" chip, the model menu, Move and the source menu.
2. **The runner wastes or breaks hops.**
   - It never checks usage before moving to a Claude account.
   - Backoff applies to one step, not to the account.
   - A signed-out account stops the chain.
   - Background work stops a same-harness hop.
   - Bedrock steps with a model that doesn't map are skipped silently.
3. **Hops leak into other settings.** A hop changes the default account for new sessions.
4. **The editor is a long form of native selects.** It shows no live state, its presets are easy to trigger by mistake, and its footer looks like nothing else in the app.
5. **Viewers can open a dialog that can't load.**

The plan is five PRs: runner correctness, account labels, live status, the editor redesign, then the chip and viewer access.

## Problems found

**Runner, `runner/src/core/live.ts`** (all verified)
1. `:2090`: the usage check runs only when `step.source === "subscription" && step.harness !== "claude"`. Claude steps and account steps are never checked. `plans` is keyed by harness (`:2077`).
2. `:2069`: `retryAt` is set only on the step that hit the limit.
3. `:1680`: every hop to a Claude subscription calls `setLastSubscription`.
4. `:1664`: `confirmed` compares labels only. Low risk while labels carry the hex suffix.
5. `:1600-1605` and `:2108`: a same-harness hop goes straight to `setSource`, and `assertSourceSwitchIdle` throws if background work is running.
6. `:1968`: `fallbackExhausted` prints the raw `step.source`.
7. Per-account plan windows live only in memory (`sessions.ts:509-516`). Claude saves only the main login's plan (`claude/stream.ts:216`, `if (!extraAccount) keepPlan`). They are lost on restart.
8. `:1537-1538`: extra accounts are listed whether or not they are signed in. (Inferred: the failure then shows up only on the resend, and stops the chain.)
9. `:2105-2106`: a Bedrock step whose model doesn't resolve is skipped with no backoff and no message. `fallbackStepProblem` passes it (`shared/fallbackChain.ts:50-53`).

**Labels and identity**
10. `claude/credentials.ts:40`: extra accounts are labelled `Claude plan · <first 8 hex>`.
11. `FallbackChainDialog.tsx:112`: options use `billing.label` only.
12. `FallbackChainDialog.tsx:14`: a missing source shows its raw id plus "(unavailable)".
13. `SessionHeader.tsx:153` ("Next:" chip) and `:160` (model menu "on …"), `MoveDialog.tsx:174`, `sourceMenu.ts:30`: all use `billing.label`.
14. `web/src/accountLabel.ts:17`: names load only for manage access, and only `BillingChip` and `NewSessionDialog` use them.
15. `accountLabel.ts:9-11`: `labelOf` prefers the org over the email, and gives an empty string when signed out.
16. `adapters/claude/accounts.ts:67`: accounts are sorted by directory name (UUID).

**Editor** (`FallbackChainDialog.tsx`, `app.css`; line numbers from the research, re-checked for `:8-29,47`)
17. Native selects (`Field`, `:8-17`), without `t-select` or `t-field-label`.
18. `key={index}` (`:102`).
19. Changing the source resets the model (`newStep`, `:27-29`).
20. "Enable" is ticked when nothing is saved: `result.chain.enabled || !result.saved` (`:47`).
21. Presets: "Load" needs a separate button, and Load and Delete run without confirmation (`:80-93`).
22. Save checks only for a missing model (`:71,128`).
23. Bedrock offers every harness model (`modelsFor`, `:20-25`), including ones the runner will skip (see 9).
24. The editor has its own scroll area inside the form's (`app.css:3095` and `:844-852`).
25. 36px buttons in `.t-fallback-actions` (`app.css:2874-2888`) instead of `.t-dialog-actions`.
26. Live run state never reaches the web. Only `fallbackChain` and `fallbackWaiting` do (`shared/transcript.ts:386-387`).
27. The chip shows only the harness (`SessionHeader.tsx:189-191`).

**Access**
28. The chip is shown to viewers, but `fallbackSetup` is not in `VIEW_OPS` (`shared/access.ts:18-33`).
29. Drive users can edit or delete the runner-wide presets. This is current policy, not a bug (open question 5).

## Label design for accounts

**One pure helper**: `accountDisplayLabel(status, fallback) → { name, detail? }` in `shared/harnessLogin.ts`.
- **name**, first match wins:
  1. `displayName`;
  2. `email`;
  3. `organization`;
  4. `fallback`.
- **detail:**
  - the plan, title-cased ("Max", "Pro"), left out when it is the generic "Claude plan";
  - then the org, only when it isn't the personal default "`<email>`'s Organization".
  - Move `normalizedOrganization` (`claude/credentials.ts:61-64`) into `shared/` so the runner and web compare the same way.
- **Callers:**
  - It replaces `labelOf` (`accountLabel.ts:9-11`) and the status text in `HarnessLogin.tsx`.
  - `useAccountLabel` returns `{ name, detail }` per source as well as the joined string, so existing callers keep working.

**Owners (manage access)**
- The dialog calls `useAccountLabel(runnerId, "claude", open)`. This is today's op pair, with no new argument.
- It renders right away with `billing.label`, then swaps in the names. This takes about one `claude auth status` run, because the account checks run in parallel (`harnessLogin.ts:217`).
- The same hook feeds the "Next:" chip, the model menu text, `MoveDialog:174` and `sourceMenu.ts:30`, for owners only.
- Cards show the name in bold and the detail muted: "Work · Max".
- The listing's `available: false` marks an account as signed out in the editor (owners only).

**Drive and view users**
- They keep the runner label. Identity stays owner-only, as #123 and #181 decided.
- A note under the source field: "Account names are shown to the runner owner."

**Missing sources** (never show a raw id):

| Case | Shown as |
|---|---|
| Account still listed but signed out (owner) | "`<name>` · signed out" |
| Account removed | "Removed Claude account" |
| Azure not set up | "Azure (not set up)" |
| Bedrock not set up | "Bedrock (not set up)" |
| Key not set | "Anthropic key (not set)" |
| Any other unknown source | "`<Harness>` login unavailable" |

**Keys:** always the API pill (`.t-move-api`).

**Runner notices** keep the opaque `labelOf()` and gain the step number, for example "Step 1 hit its limit. Switched to step 2 · Claude plan · 3f2a9c1e." Owners match the number to the card.

## UI redesign

### Header chip (`SessionHeader.tsx:189-191`)

- Key/value layout like `ChoiceMenu.tsx:53-54`: `<span class="t-chip-key">Fallback</span>` followed by the value.
- Values:
  - `Off`
  - `On · 3 steps`
  - `2 of 3 · Work`: the account name for owners, otherwise the runner label. The harness name is used for a step on another harness.
  - `Waiting · 3:41 PM` when every step is used up and `fallbackResumeAt` is set. Without a resume time it reads `Waiting`. Coloured like `.t-chip-info`.
  - `Switching…` while `fallbackWaiting` is true.
- `.t-next-api` colouring when the active step bills a key.
- Truncate with an ellipsis. The full sentence from `fallbackPlan()` goes in `title`.
- 44px tall on coarse pointers (`app.css:2599-2604` pattern). Stays inside `.t-chip-options`.
- Viewers open a read-only panel built from `state.fallbackChain` and `state.fallbackRun`, with no RPC.

### Dialog shell

- Astryx `Dialog` (`width={520}`, `purpose="form"`) with a `DialogHeader`:
  - title "Fallback chain";
  - subtitle "When this session hits a usage limit, it moves to the next step."
- The body is `<div className="t-form" style={{padding:16}}>` and is the only scroll area. Delete `.t-fallback-editor` and its `justify-items:start` rule (`app.css:3095-3101`).
- Footer: `.t-dialog-actions` outside the scroll area, with Astryx `Button` Cancel (secondary) and Save (primary, "Saving…" while busy). Delete `.t-fallback-actions*` (`app.css:2874-2888`).
- Loading: `.t-css-spinner` with "Loading logins and models…". On failure: `.t-form-error` plus "Try again".

### Body, top to bottom

**1. "Now" card** (`.t-fallback-now`, styled like `.t-usage-summary > div`). Shown only when the chain is saved and enabled. Its lines come from `fallbackPlan()`:
- "**Running step 2** · Claude Code · Personal · Opus 4.5"
- "If this runs out: step 3 · Codex · ChatGPT plan"
- "Back to step 1 (Work) at your next message after 3:40 PM". Only shown when `nextBilling` is absent, matching `live.ts:393-394`.

Other states:
- While `fallbackWaiting`: "Waiting for background work before switching to step 3. Stop to cancel."
- All steps used up: "**Every step is waiting.** Step 1 frees up at 3:40 PM." Then either "Tether sends “continue” at 3:41 PM." (when `fallbackResumeAt` is set) or "Send a message after then."
- Unsaved edits: "Unsaved changes" replaces the lines.

**2. Two `.t-check` toggles** (pattern `AgentSettings.tsx:26-33`), each with a muted `.t-inline-status` note:
- "Use for this session". **Starts off** when nothing is saved. The steps are still prefilled from `lastFallbackOrder`, so turning it on is one tap (open question 4).
- "Continue when a limit resets". Note: "If every step is waiting, Tether sends “continue” a minute after the first one frees up." Disabled while the chain is off.

**3. Order:** `<span class="t-field-label">Order</span>`, then `<ol class="t-fallback-steps">` of cards (`.t-fallback-step`, styled like `.t-azure-row`). Each step gets a stable client id as its key.

*Collapsed card* (a button with `aria-expanded`):
- Line 1: number and **name**, plan muted ("1 · Work · Max"), or the API pill for a key.
- Line 2, muted: "Claude Code · Opus 4.5 · High effort · Ask before edits".
- Status token on the right, from `fallbackRun`, shown only while the steps are unchanged:
  - `Running`: accent, plus an accent left border on the card;
  - `Waiting until 3:40 PM`;
  - `Retry after 3:22 PM`: the 10-minute backoff;
  - `Can't run`: when `fallbackStepProblem` returns something, or for owners when the account is signed out.
- Warning line (`aria-describedby`):
  - "Same as step 1. This step would never be used." This blocks Save and has a "Remove duplicate" button.
  - "Same Claude account as step 1. It shares that step's limit." (`sameAccountAs`; rare, see edge cases)
  - The specific problem, for example "Personal is signed out. Sign in under Settings → Accounts.", or "Not set up on Bedrock."
- Reorder: Astryx ghost `IconButton`s up and down (`ChangesPane.tsx:325-332`), `size="sm"`, 44px on coarse pointers.
  - Labels: "Move step 2 up/down".
  - Disabled at the ends.
  - Focus follows the moved card.

*Expanded card* (one open at a time; a new step opens expanded). Fields follow `MoveDialog.tsx:145-166` and `NewSessionDialog.tsx:240-266,362-387`:
- `.t-seg` harness radio group.
- "Source": `SourcePicker` with `accountLabels`.
- Model:
  - **Azure**: `DeploymentPicker` (the stored value is the deployment name, as `fallbackStepProblem` expects).
  - **Bedrock**: a `t-select` of harness models filtered to those that `resolveSourceModel(option.deployments, id)` resolves. The stored value stays the harness model id.
  - **Other sources**: a `t-select` of the harness models, with the description underneath.
  - Delete `modelsFor`.
- "Effort" and "Permissions" side by side, one column under 360px. The mode description goes in `.t-inline-status`. "Default" reads "Default (matches this session, never higher)".
- Field names carry the step: "Step 2 model".
- Bottom row: "Move to top" and "Remove step" (secondary, red text). Removing leaves an inline "Step 2 removed. Undo" row.
- Changing the source on the same harness keeps the model, effort and mode while they stay valid (`retarget()` replaces `newStep`). Changing the harness resets them and says "Model and mode reset for Codex."

**4. Foot row** (`.t-azure-foot` pattern)
- Secondary "Add step" opens a plain `DropdownMenu`. It picks the source first, grouped by harness:
  - Claude Code: "Work · Max", "Personal · Pro", then "Anthropic key" (pill, listed last); Codex: …
  - Sources already in the chain stay selectable, with the description "In step 1".
- Picking a source appends a step:
  - model: the session's model if valid for that source, otherwise the first valid one;
  - effort: default;
  - mode: default.
- "Plan X, then plan Y" takes two taps.
- At 50 steps: "You can add up to 50 steps."
- **Empty state:** "No steps yet. Each step is a login or key to try, in order." Then a primary "Start from this session (Claude Code · Work)" button, which uses `setup.current`.

**5. Presets:** `<details class="t-credential-rates">` with summary "Presets on this runner (2)".
- Each row: name, a muted summary ("Work → Personal → Codex") and a "Use" button. "Use" replaces the steps and shows "Loaded “X”. Undo". Nothing is saved until Save.
- "Save as preset…", "Rename…" and "Delete…" open a nested name or confirm `Dialog` (pattern `ChoiceMenu.tsx:63-70`). Delete asks "Delete “X” for everyone on this runner?"
- Preset errors appear inside the section.
- Who sees these actions depends on open question 5. Default: unchanged, so drive users keep them.

**6. Notes above the footer** (`.t-inline-status`; errors use `.t-form-error` with `role="alert"`):
- "Saving a new order starts again from step 1 and clears waiting times." Shown when the order changed and the chain is active (`live.ts:1785,1793`).
- "Step 3 bills your Anthropic key per token." (`--t-api-ink`)
- "Step 2 will be skipped until Personal is signed in."

**Save is blocked when:**
- a step has no model;
- two steps are exact duplicates (including ones loaded from old saves or presets);
- the chain is enabled with no steps.

Steps that can't run right now can still be saved.

### CSS

- New rules next to `app.css:3095`, one rule per line:
  - `.t-fallback-now`;
  - `.t-fallback-steps`;
  - `.t-fallback-step`, with `.on` for the running step;
  - `.t-fallback-state`, with `.wait` and `.bad` variants.
- `@media (pointer: coarse)`: icon buttons at least 44px.

## Backend and shared changes

**Runner correctness (`live.ts`)**
1. **Usage check before a hop.**
   - At `:2090`, use `isSubscriptionSource(step.source)` for every harness.
   - Key `plans` by `harness\0source`.
   - For the main login on harnesses other than Claude, keep `refreshPlan`. For Claude and for accounts, read `this.core.planFor(harness, source)` with no refresh.
   - Skip a step whose window is at 100% with a future `resetsAt` (the existing filter at `:2093-2094`), and give it that reset time.
2. **Shared backoff, narrow.**
   - On a plan-limit hit (not when rate-limit retries run out), copy `retryAt` to every other step with the same harness, source **and model**.
   - Steps on the same account with other models are caught by B1 when the 5-hour or weekly window is full.
3. **Default account.** `setSource` gets a `fallback` argument already (`:1607`). Skip `setLastSubscription` (`:1680`) when `fallback` is set.
4. **Confirmation by source** (low priority). At `:1664`: `confirmed = (s.state.billing?.source ?? "subscription") === asked && s.state.billing?.label === next.label`.
   - Account billings carry `source` (`claude/credentials.ts:87`); the main login has none.
   - Apply the same `?? "subscription"` rule wherever `sourceMenu.ts:28` falls back to label matching, if touched.
5. **Wait for background work.**
   - At `:2108`, also call `waitForFallbackHandoff` before a same-harness `setSource` when `sourceSwitchBlocker(s.state)`, `s.shellsRunning` or `backgroundSubagents` is set.
   - Add a 30-minute cap to `waitForFallbackHandoff` (`:1987-2001`). When the cap is reached: say "Background work is still running. Stop it, or send a message to try again.", then `waiting()`.
   - Stop still cancels at once.
6. **Readable notices.** `:1968` uses `labelOf()`. Hop notices name the step: "Step 2 hit its limit. Switched to step 3 · …".
7. **Keep account plan windows.** Save each account's windows on the runner (prefs, keyed by source) when `notePlan` runs with an account source. Load them into `plans` at startup. `planReset` needs no change, because it already reads `s.state.plan` (`:2196`).
8. **Signed-out accounts** (new). Before hopping to an `account:` step, run that account's status check once.
   - Today this is the `accountStatus` closure in `harnessLogin.ts:208-214`. Expose it through `claudeAccounts` or a core hook.
   - Signed out: treat it like `fallbackStepProblem`, with a 10-minute backoff, then continue.
   - Also: if the resent turn fails to start with the `confirmClaudeBilling` account error, mark the step with a backoff and advance instead of stopping. (Inferred path; cover it with a test first.)
9. **Bedrock check** (new). `fallbackStepProblem` returns "Not set up on Bedrock." when `step.source === "bedrock"` and `resolveSourceModel(source.deployments, step.model)` is undefined. Then `:2106` is never reached silently, and the editor shows the problem.
10. **Mode race** (narrow). Wrap the mode check in `setSource` (`:1627-1628`) so a fallback hop that fails it backs off that step and continues, instead of ending the chain. Mapping a step's default mode at hop time already happens (`:2079,2104`).

**Status the web can show**

11. Add `LiveState.fallbackRun?: { steps: Record<number, { retryAt?: number; why?: "limit" | "backoff" }>; resumeAt?: number }`.
    - Write it through one helper, `saveFallbackProgress(s, progress)`, which replaces the direct `prefs.set({fallbackProgress})` calls (`:1907,1971,2019,2070,2097,2134,2156,1793`).
    - `resumeAt` mirrors `prefs.fallbackResumeAt`, set in `scheduleFallbackTimer` and `cancelFallbackTimer` (`:1924-1932`).
    - Strip `sessionId`, `after` and `lastUserText`.
    - Derive it on open in `sessions.ts:343`, next to `fallbackChain`, and for successors via `keptPrefs` (`live.ts:1853-1858`).
12. Add `fallbackPlan(chain, run, now, opts) → { current?, next?, returnTo?, allWaiting? }` to `shared/fallbackChain.ts`.
    - It uses `fallbackOrder` (`:69-72`) and the `waking`/`returning` filter from `live.ts:2074-2075`.
    - No refactor of `advanceFallback` in this plan.
13. `FallbackSetup` gains:
    - `current: { harness, source, model, effort?, permissionMode? }`, from the session;
    - `SourceOption.sameAccountAs?: BillingSource`, set in `fallbackCatalog` by comparing `accountId`s of the main login (cached) and the extras. No identity goes on the wire.

**Labels**

14. `accountDisplayLabel` and `normalizedOrganization` move to `shared/`.
15. `ClaudeAccounts.save` writes `createdAt`. `list()` sorts by `createdAt`, falling back to the `.tether-account.json` file's mtime, then by name.

**Access (`shared/access.ts`)**

16. Viewers use `state.fallbackChain` plus `fallbackRun` only. No op changes.
17. Moving `editFallbackPreset` to `MANAGE_OPS` waits on open question 5.

## Edge cases and rules

| Case | Rule |
|---|---|
| Account signed out | Owners: the card shows "Can't run · `<name>` is signed out". Everyone: the runner checks at hop time and skips with a 10-minute backoff (B8). It can still be saved. |
| Account removed (in the chain or a preset) | "Removed Claude account". The step is kept, and the preset still loads with the warning. Never remapped silently. |
| Exact duplicate, including old saves and presets | Marked on load with "Remove duplicate". Save is blocked until it is fixed. |
| Same account, different model | Allowed. Backoff is not shared; B1 catches full 5-hour or weekly windows. |
| Main login later changed to an account that is already an extra | The only way to get the same account twice (adding is blocked, `harnessLogin.ts:300-301`). `sameAccountAs` warning. |
| Same email, different orgs | The detail shows the org. |
| Bedrock model not configured | "Not set up on Bedrock." on the card. The runner backs off instead of skipping silently. |
| API-key steps | Always the pill plus the footer note. Never chosen as a default: keys are listed last in Add. Saving the chain is the opt-in (SPEC.md:1170). |
| Session currently on a key | "Start from this session" makes step 1 that key, with the pill. |
| Order edited while the chain is active | Saving resets `active` and progress (`live.ts:1785,1793`). The note warns first. |
| Background work during a same-harness hop | Waits up to 30 minutes. The chip shows `Switching…`, the "Now" card explains, and Stop cancels. |
| A source change is already pending (`nextBilling`) | The "Now" card doesn't promise a return. |
| Session mode lowered after saving | Steps with no mode are re-mapped at hop time. Steps with an explicit, too-high mode are skipped with a backoff. |
| Viewer | Read-only chip and panel built from state. |
| Drive user | Edits the chain and sees opaque labels plus the owner note. Presets depend on open question 5. |
| Codex → `account:Y` | Goes through `moveFallback` (`live.ts:2124-2138`). Not traced; covered by a test. |

## Tests

**Shared**
- `accountDisplayLabel`:
  - name beats email, email beats org;
  - a personal-default org is left out, a team org is shown;
  - the plan is title-cased, and "Claude plan" is dropped.
- `fallbackStepProblem`: a Bedrock model that doesn't resolve gives "Not set up on Bedrock."
- `fallbackPlan` table tests:
  - nothing started;
  - partway down the chain;
  - a return pending;
  - a return suppressed by `nextBilling`;
  - every step waiting, with and without `resumeAt`.
- A pinning test against `advanceFallback`'s chosen index for:
  - waking;
  - returning;
  - a problem step backed off for 10 minutes;
  - the identical-step skip (`live.ts:2101-2102`).

**`runner/src/core/fallbackSwitch.test.ts`**
- `subscription` → `account:X` → `account:Y`:
  - `prefs.source` changes;
  - Y's `CLAUDE_CONFIG_DIR` is in the driver's environment;
  - the same native id is resumed;
  - the message is resent when no tools ran;
  - `lastSubscription` is unchanged;
  - the notice has the step number and no `account:`.
- Y → X at the next message after `retryAt`.
- Y full according to `planFor`: skipped with no restart, and given its reset time.
- A plan limit on X backs off X's other step on the same model, but not X's step on another model.
- Rate-limit retries running out don't share backoff.
- A signed-out Y is skipped with a backoff and the chain continues. A failed start on Y advances instead of stopping.
- A background shell makes the hop wait, and the hop goes through when the shell ends. The 30-minute cap gives the message plus `waiting()`. Stop cancels.
- The main login is still confirmed after B4: a `billing` with no `source` counts as `"subscription"`.
- The mode is lowered between the catalog fetch and `setSource`: the step is backed off and the chain goes on.
- `fallbackRun`:
  - it is emitted without `sessionId`, `after` or `lastUserText`;
  - `resumeAt` follows `fallbackResumeAt`;
  - it survives reopening (`sessions.ts:343`) and a move (`keptPrefs`).
- The exhausted notice contains no `account:`.
- Codex → `account:Y` through the move module.
- Account plan windows survive a runner restart.

**`runner/src/core/fallbackEditor.test.ts`**
- Account sources appear in the order they were added (`createdAt`, then mtime).
- `sameAccountAs` is set when the main login's `accountId` matches an extra.
- `current` is filled in.
- A step on a removed account survives `cleanFallbackSteps` and reports its problem.

**Web: new `FallbackChainDialog.test.tsx`** (same style as `SessionHeader.test.tsx`)
- Owner sees names; drive user sees opaque labels plus the note.
- A removed account never renders `account:`.
- The API pill and the footer note appear.
- `sameAccountAs` warning. An exact duplicate blocks Save and offers "Remove duplicate".
- Moving a card keeps the step (stable keys). Up on the first card and down on the last are disabled.
- Changing the source keeps a model that is still valid.
- Bedrock lists only models that resolve.
- Add step puts the session's model on the new step.
- "Use" on a preset, then Undo.
- The empty state shows "Start from this session".
- "Use for this session" starts off when nothing is saved.
- Save sits in `.t-dialog-actions`.
- Status tokens render from `fallbackRun`.

**Web: `SessionHeader.test.tsx`**
- The chip text in each state, including `Switching…`.
- The chip is read-only for view access.
- An owner's "Next:" chip shows the account name instead of the hex label.

**Acceptance**
- Add a manual run to `docs/acceptance/KEYS.md:99-108`, done in phone Chromium:
  - two real Claude accounts, X then Y;
  - force X to its limit;
  - check the hop, the notice text, the chip's "2 of 2 · Y", and the return to X at the next message after the reset.
- Update SPEC.md:1207-1240.
- Fix the outdated `docs/acceptance/RETRIES.md:16`.

## PR breakdown, in order

1. **Account hops behave correctly.** Runner only:
   - B1-B10, `sameAccountAs`, and `createdAt` ordering;
   - the runner tests.
   - Can land alone.
2. **Account labels.** Independent of PR 1. Fixes the reported bug before the redesign.
   - `accountDisplayLabel` and `normalizedOrganization` in shared;
   - the `useAccountLabel` update and `HarnessLogin`;
   - owner labels on the "Next:" chip, the model menu, `MoveDialog:174` and `sourceMenu.ts:30`;
   - a quick fix to the current dialog: `:112` uses account labels and `:14` gets readable missing-source labels.
3. **Fallback run status.** No UI.
   - `fallbackRun`, `saveFallbackProgress`, `resumeAt`;
   - derived on open and in `keptPrefs`;
   - `fallbackPlan()` with its pinning tests;
   - `FallbackSetup.current`.
4. **Editor redesign.** Depends on PRs 2 and 3; uses PR 1's `sameAccountAs` if it has landed, otherwise ignores it.
   - Cards and accordion, the Add-step menu, presets in `<details>`, notes, footer, CSS cleanup, web tests.
   - Extracting a shared `RunSetupFields` from NewSession and Move can be its own first commit, with no behaviour change.
5. **Chip and viewer access.** Depends on PR 3.
   - The key/value chip with the account name;
   - the read-only viewer panel;
   - the acceptance checklist and SPEC updates;
   - the preset access change only if question 5 says yes.

## Open questions for you

1. **Nicknames for shared users.** Should the names you give accounts (never emails) be shown to people the runner is shared with?
   - If yes, the runner label and notices use the nickname. That loosens #181's owner-only rule, and the name ends up in session state and transcripts.
   - If no, they keep "Claude plan · 3f2a9c1e", and owners match notices to cards by step number.
2. **Going back to plan X.** When X resets while the session is idle on a lower step, should the chain switch back on its own, or only at your next message, as it does today?
3. **Background work during a hop.** When background shells or subagents are running, should a same-harness hop (X to Y) wait up to 30 minutes (proposed), or stop and ask you, as the billing chip does?
4. **Default for a new chain.** Is it OK for "Use for this session" to start off when nothing is saved? The steps are still prefilled, so turning it on is one tap.
5. **Presets and shared users.** Today, anyone with drive access can save, rename and delete the runner-wide presets. Should those three actions be owner-only? Loading a preset would stay open to drive users.
## Default answers until the owner says otherwise

1. No: shared users keep the runner label. Owner-only identity (#123/#181) stays.
2. Keep today's behaviour: go back to an earlier step only at the next message.
3. Wait up to 30 minutes with a visible "Waiting…" state. Stop is the way out.
4. Yes: "Use for this session" starts off when nothing is saved.
5. No change to who can run the preset ops.
