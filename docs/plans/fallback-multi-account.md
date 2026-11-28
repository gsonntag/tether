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

## Fixes after outside review (GPT-6.2 Sol). Where this section disagrees with anything above, this section wins.

**R1. Failed account start (replaces B8's "treat a failed account start as a failed step").**
- The hop sets `source` and `fallbackChain.active` before it resends (`live.ts:1678`).
- `send()` releases the fallback reservation before startup (`live.ts:400,450`).
- So a plain catch-and-continue would carry on with the wrong source, chain and reservation.
- Instead:
  - check the account's sign-in (`confirmClaudeBilling` / status probe) **before** committing the hop;
  - if the start still fails with a typed auth or pre-turn error, restore the previous `source`, `active` and reservation, and only then move on;
  - resend only if the turn never reached the harness;
  - Stop, shutdown or a chain edit during the probe still cancel the hop.
- Tests:
  - Stop during the probe;
  - a chain edit during the probe;
  - an auth failure after commit restores the previous state.

**R2. Permission race and cancellation (refines B10 and critic point 16).**
- The guard at `live.ts:1627` returns false for Stop, shutdown, a replaced chain **and** permission rejection.
- Split them:
  - cancellation ends the hop with no backoff;
  - only a permission rejection counts as a step problem with backoff.
- Before pinning the identical-step skip (`live.ts:2102`) in tests, fix it to compare `step.harness` too. Today a step on another harness with the same source and model ID is skipped.

**R3. Who decides "Now" and "Next" (replaces the web-side `fallbackPlan()` prediction in PR 3).**
- `fallbackOrder` (`shared/fallbackChain.ts:69`) knows only the index and the backoff.
- The runner also:
  - derives the starting step when `active` is absent (`live.ts:2037`);
  - checks availability, permissions, usage and whether a step matches the current one (`live.ts:2086`).
- Viewers have no catalog.
- So `fallbackRun` is **computed on the runner** and published in live state:
  - the current step;
  - the next eligible candidate;
  - per-step state (ready, cooling down until T, can't run + reason).
- The web only renders it.
- Copy says "Next if this hits a limit: …" (a candidate), never a promise.
- The return-to-earlier-step line appears only when the runner reports that every guard passes: idle status, no `nextSource`, not cancelled, no deferred "continue" (`live.ts:393,1952`).
- `fallbackPlan()` becomes runner-internal with pinning tests.

**R4. Removed or unavailable source in the editor.**
- `SourcePicker` shows `options[0]` when the saved value is missing (`SourcePicker.tsx:7`), so a broken step can look fixed.
- Add an explicit unavailable option that renders the saved value with its missing-source label (see the Label design table).
- Keep the draft's value until the user deliberately picks a replacement.
- Save stays blocked while the step is broken.
- Add a test for this.

**R5. Cached Claude usage across identity changes (refines B1 and B7).**
- The main login's plan is cached by harness (`sessions.ts:504,523`).
- After switching the main login to another identity, a stale "full until T" could wrongly skip the new login.
- Invalidate the cached plan when the identity (accountId/email) behind a source changes.
- Persist the cache together with that identity.
- Apply a known-full window across two source IDs only when their identities match.

**Non-blocking, also adopt:**
- **Probe state is not sign-out.**
  - `listHarnessAccounts` returns the stored identity with `signedIn` even when the probe fails, and `available:false` also covers "unknown" (`harnessLogin.ts:219`, `accountLabel.ts:31`).
  - Keep the stored name, and expose the probe state separately: signed in / signed out / unknown.
  - Say "signed out" only on a confirmed sign-out.
  - When two accounts end up with the same name and detail, add the email's local part, or the short id as a last resort.
- **B1-B2 reset rules.**
  - Keep the existing `exhausted || percent >= 100` check (`live.ts:2093,2184`).
  - Use the latest reset among the full windows.
  - Persist the cause of a backoff (`limit` / `limit-unknown-reset` / `error`), so the UI can tell a limit apart from a short-lived failure.
- **Older runners.**
  - PR 4's web code must handle `FallbackSetup.current` and `fallbackRun` being absent: show cards with no status and no "Now" card.
  - Add a web test for this.
- **More tests:**
  - the only higher-priority account is unavailable when it's time to go back;
  - phone keyboard and focus during reorder and in the preset dialogs.

## Fixes after re-review, round 2. These replace R1, R3, R4 and R5 where they differ. R2 stands, extended below.

**R1′. A hop is staged and committed only once startup succeeds (same-harness path, `setSource`).**
- Snapshot every piece of state the hop owns before changing anything:
  - `source`, `model`, `effort`, `permissionMode`, deployment;
  - the billing fields (`billing`, `nextBilling`, `nextModel`, `nextDeployment`, `sourceSwitchFailed`);
  - `fallbackChain.active`, `fallbackProgress` and the reservation.
- Tag the hop with a token, for example `hopId` on the session.
- If startup fails with a typed pre-turn error, roll back **only** the fields that still carry this hop's token. Rollback never undoes a Stop, a chain edit or a manual source change made meanwhile: those change the token, so rollback is skipped and the hop counts as cancelled.
- **The driver signals the enqueue.**
  - `d.send()` resolves or emits `enqueued` once the harness actually accepted the turn. For Claude that is after its final auth check (`claude/driver.ts:271-276`).
  - `s.sentOut` (`live.ts:450`) stays as is for change tracking. The fallback path uses the driver's `enqueued` signal to decide whether a resend is safe: resend only when `enqueued` never fired.
- The "Switched to step N" notice and the `fallbackStatus` / `fallbackRun` updates are published only after `enqueued` (they move from `live.ts:2150-2165`).
- Tests:
  - startup auth failure restores model, effort, mode, billing and active;
  - Stop during startup: no rollback over the Stop, no backoff;
  - a chain edit during startup: no rollback over the edit;
  - failure after `enqueued`: no resend.

**R1″. Cross-harness hops (`moveFallback`, `live.ts:2004-2026`).**
- Today the successor replaces the original (`replaceWith`) before the send.
- Change the order:
  1. open the successor;
  2. send on it while the original stays in place but hidden from new sends;
  3. call `replaceWith` only after the successor reports `enqueued`.
- On a typed pre-turn failure, close and discard the successor with the existing discard path (`:2011-2013`). The original stays active and the step gets a backoff.
- **R2 also applies here.** The check at `:2008-2009` splits cancellation (`retrySuppressed` / `stopping` / chain replaced → `SendCancelled`, no backoff) from a permission rejection (`!fallbackModeAllowed` → step problem with backoff).
- Tests:
  - Codex → Claude-account hop where the account start fails: the original session survives and the successor is discarded;
  - a permission rejection on the move path backs off that step;
  - Stop on the move path does not.

**R3′. When the runner recomputes `fallbackRun`.**
- One function, `fallbackEligibility(s, chain, catalog, now)`, holds the checks that actual hop selection uses today (`live.ts:2086-2109`): availability, permission, usage window, backoff, identical step. `advanceFallback` and the status snapshot both call it, so they cannot drift.
- Recompute (debounced, about 250 ms) on:
  - chain save;
  - hop start, commit or rollback;
  - `notePlan` usage reports (`:2409-2412`);
  - a permission-mode change;
  - catalog and source changes (account added, removed or signed out; key set or cleared);
  - session open (`sessions.ts:343`) and `keptPrefs` handoff;
  - a timer at the earliest future `retryAt` or usage reset, so backoff expiry shows up without other events.
- The "return to earlier step" line follows the **manual-send** path (`live.ts:393-398`): idle, no `nextSource`, not cancelled, and the earlier step is eligible.
- The automatic continue-on-reset timer (`:1952-1958`) is shown separately ("Will continue at T") only when `continueOnReset` is on.
- PR 3 drops the shared web predictor and its tests. It tests `fallbackEligibility` and the recompute triggers instead.

**R4′. Unavailable sources: show and warn, don't block.**
- This keeps the existing rule that unavailable steps can be kept (`setFallbackChain`, `live.ts:1780-1796`, and the runner skips them at hop time).
- The editor keeps the unavailable value: an explicit option with its missing-source label, plus a warning.
- Save is **allowed** with unavailable steps, including when turning the chain off.
- Save is still blocked for:
  - an exact duplicate;
  - a missing model on an available source;
  - an empty chain when it's turned on.
- Update the "Save is blocked when" list, the edge-case table and the web tests to match. Add a test that one removed account doesn't stop the user from turning the chain off or saving an unrelated edit.

**R5′. Usage windows tied to identity.**
- Every saved or live usage window carries the identity that produced it: `{ accountId, email, organization }`.
  - **Reads:** `refreshPlan()` loads Claude's saved plan (`sessions.ts:523-526`) only when its identity matches the source's current confirmed identity.
  - **Live reports:** `notePlan` from a process (`claude/index.ts:199`, `claude/context.ts:144-150`) is accepted only when the process's identity (confirmed at its start) matches the source's current identity. A late report from a process started under the old identity is dropped.
  - Windows with no identity (older data) are ignored for skip decisions.
  - Two source IDs share a "full" window only when accountId, email and the org (normalized) all match.
- Tests:
  - an identity change followed by `refreshPlan` doesn't skip the new login;
  - a late report from the old process is ignored;
  - an identity-less window is ignored.

**Plan bookkeeping:**
- PR 3 is now "runner-owned status": `fallbackEligibility`, `fallbackRun` and the recompute triggers, with no web predictor.
- PR 1 now includes R1′, R1″ and R2, and the driver's `enqueued` signal.
- PR 5 depends on PR 2 (owner labels) and PR 3.
- Chip and dialog copy use only `fallbackRun` fields: `current`, `next` (a candidate), per-step `state` / `until` / `reason`, `returnsOnNextMessage` and `continueAt`.

## Fixes after re-review, round 3. These replace R1′, R1″ and R3′ where they differ.

**R1‴. A hop is a provisional record. Nothing is written to the session until commit.**
- `setSource` gains a staged mode. The hop builds `pending = { hopId, source, model, effort, permissionMode, deployment, billing fields, active, progress }` and starts the driver from `pending`. It does **not** write `s.state` or prefs.
  - **Commit** (the only write) happens when either:
    - the driver reports `enqueued`, for hops with a message to resend; or
    - the driver reports **startup ready**, for hops with nothing to resend (no message, or the turn already acted). Startup ready means the process is up, auth is confirmed, and the prompt is accepting input.
  - **Discard:** on Stop, a chain edit, a manual source change, shutdown or a pre-turn failure, close the provisional driver and drop `pending`.
  - Because nothing was written, there is no rollback and no per-field ownership check. Cancellation can never strand provisional state (fixes `live.ts:1678-1682,2158-2165`).
  - `interrupt` (`live.ts:843-863`) and `setFallbackChain` (`:1780-1796`) discard any `pending` on the session.
  - A permission rejection discards and backs off that step. Cancellation discards with no backoff (R2).
- Tests:
  - Stop during startup leaves state byte-identical to before the hop;
  - a chain edit during startup keeps the edit and leaves no trace of the hop;
  - an acted turn hops with startup-ready commit and no resend;
  - an auth failure discards and backs off.

**R1⁗. Provisional successors (`moveFallback` and `returnToFallback`) use the same record.**
- The successor or old session is provisional until commit. Rules:
  - **Enqueue gate:** just before the driver enqueues, it re-checks the *original* hop's state: `retrySuppressed`, `stopping`, the chain unchanged, the hop id still current, and `fallbackModeAllowed`. If any check fails, it doesn't enqueue and the successor is discarded.
  - **Stop routing:** while a provisional successor exists, `interrupt(original)` also discards it. The original's `fallingBack` entry points at the successor (`live.ts:847`).
  - **Turn-end deferral:** turn-end, limit and `fallbackStatus` handling for a provisional successor are queued, then replayed after `replaceWith` commits. A fast successor turn that ends before handoff still inherits the chain and progress first (`live.ts:576-596,2483-2486`).
  - **`returnToFallback`** (`live.ts:1893-1909,2111-2119`) moves to the same order as `moveFallback`: resend on the provisional old session first, `replaceWith` only after commit.
  - **R2 split on every path:** cancellation → `SendCancelled`, no backoff; `!fallbackModeAllowed` → a step problem with backoff. This includes the check at `:1894-1895`, which today treats a permission rejection as cancellation.
- Tests:
  - Stop while the successor is starting discards it and no turn runs;
  - the successor's turn ends before handoff and its limit is processed after commit with the chain intact;
  - `returnToFallback` with a permission rejection backs off that step;
  - `returnToFallback` with Stop does not back off.

**R3″. Return status is derived when publishing, not from a trigger list.**
- `returnsOnNextMessage` and `next` are computed from the live inputs each time `fallbackRun` is published: status, `nextSource` / pending source, sending, the provisional hop, and `fallbackEligibility` of earlier steps.
- Publishing is debounced and runs on:
  - every `setState` that touches `status`, `source`, `nextSource`, `nextBilling` or `fallbackChain`;
  - send start and finish;
  - turn end (`live.ts:393-398,1659-1661,2403-2404`);
  - everything in R3′;
  - the expiry timer.
- A test drives send → turn end → pending source → cleared, and checks the flag at each step.

**R5′ addendum:** the process identity used by R5′ comes from the driver's confirmed account info for **every** login, including the main `subscription` login, not only for extra accounts.

## Fixes after re-review, round 4. One startup primitive for every hop.

**R6. `provisionalStart(target, pending)` is the only way any hop starts a driver.** Same-session `setSource` hops, `moveFallback` and `returnToFallback` all use it.

1. **Buffered sink.** The driver starts against a buffering event sink, not the session's live sink (`live.ts:1393-1411,2222-2255`). Nothing reaches the session's transcript, state or bus before commit. On commit the buffer is replayed in order into the live sink. On discard it is dropped.
2. **Driver not installed until commit.** `s.driver` keeps pointing at the old driver (or none) until commit. The provisional driver lives on `pending.driver`.
3. **Exclusive native session.** A lock keyed by the native session id (the thread/conversation id) is taken before startup and released on discard or commit. While it is held, the old driver must not write to the same native session. Same-session hops close the old driver before taking the lock, as today.
4. **Enqueue gate inside the driver.**
   - `d.send(..., { beforeEnqueue })` calls `beforeEnqueue()` at the last moment before handing the turn to the harness. For Claude, that is **after** its final auth check (`claude/driver.ts:271-276`).
   - The callback re-checks: hop id still current, not `retrySuppressed`, not `stopping`, chain unchanged, and `fallbackModeAllowed`.
   - If the callback returns false, the driver doesn't enqueue and the hop is discarded, with R2's split between cancellation and permission rejection.
   - All three adapters implement the hook. Antigravity and Codex call it just before writing the prompt.
5. **Commit.** On `enqueued`, or **startup ready** when there is nothing to resend:
   - apply `pending` to state and prefs;
   - install `pending.driver`;
   - replay the buffer;
   - release the lock;
   - run `replaceWith` for move and return;
   - then run any deferred turn-end handling (R1⁗).

**R6a. `returnToFallback` (`live.ts:1882-1909,2111-2119`).**
- The settings (model, effort, mode, deployment) and transcript changes it makes to the historical session are prepared on `pending`, never written before commit.
- On abort, the historical session is left exactly as it was: prefs, `fresh` / `rebuilt` flags, transcript and state.
- Returns with no resend use the startup-ready commit.
- Tests:
  - abort leaves the historical session byte-identical;
  - a return with no resend commits on startup ready.

**R6b. Codex source carry (`live.ts:404-405,1654-1662`, `codex/index.ts:59`).**
- `pending` is built by the same start-planning code that `send()` uses today, including `nextSource` → `carry`. A same-harness Codex source change therefore still starts a **new thread** carrying the context, never the original native id.
- The lock in R6.3 is then taken on the new thread id.
- Test: a Codex subscription → Azure same-harness hop starts a new thread with carry, and the original thread is untouched on discard.

**PR 1 scope** now centres on `provisionalStart`. Suggested commit order:
1. the buffered sink and the driver `beforeEnqueue` / `enqueued` / startup-ready hooks in all adapters, with no behaviour change;
2. same-session hops moved onto `provisionalStart`;
3. `moveFallback` and `returnToFallback` moved onto it;
4. account-specific rules (B1-B10, R5′).

## Fixes after re-review, round 5. These amend R6.3 and R6b.

**R6.3′. The session reservation comes before teardown.**
- Take a per-session `hopReservation` (keyed by session id and native id) **before** closing the old driver.
- Hold it through teardown, provisional startup, and commit (driver installed) or abort cleanup (provisional driver closed, old state restored), whichever ends the hop.
- Ordinary startup (`ensureDriver` / start paths at `live.ts:1393-1416`, which check `s.driver` and `s.starting`) and terminal handoff (`:2249-2250`) both honour the reservation:
  - they wait for it to release; or
  - for a user send, they queue behind it, as sends already queue while `s.sending`.
- Tests:
  - a user send racing old-driver teardown waits and then runs on the committed driver;
  - a terminal open during a hop waits;
  - abort cleanup releases the reservation and a queued send then runs on the original.

**R6b′. Codex carry keeps its current answer-gated semantics. It is not moved onto enqueue-commit.**
- Hops that need `carry` keep today's path unchanged (`live.ts:501-531`): the successor's commit point is `answered()`, as now. A prompt that is accepted and then fails is discarded, and the original stays.
  - This means a same-harness Codex source change, plus any harness where `nextSource` triggers carry.
- `provisionalStart` adds only the R2 cancellation / permission split and R6.4's `beforeEnqueue` gate to carry's inner `send`. It doesn't change carry's replace rule.
- **Hops with no resend** on a carry harness keep today's pending-source behaviour (`:1654-1662`): set `nextSource` / `nextFallbackSettings` and carry on the next message. They do not commit a new thread on startup.
- **R6.5's enqueue / startup-ready commit** therefore applies only to non-carry hops:
  - Claude same-session account or source hops;
  - `moveFallback`;
  - `returnToFallback`.
- Tests:
  - a Codex carry where the prompt is accepted and the turn then errors before answering: the original is kept and the successor discarded;
  - a Codex no-resend hop sets `nextSource` and creates no thread.

## Fixes after re-review, round 6. Amends R6b′.

**R6b″. Fallback carry stays cancellable until replacement.**
- When `carry()` runs **as part of a fallback hop**, it is registered as the hop's provisional successor (R1⁗) from `carrier()` until `replaceWith()`, including the whole `answered()` wait. The R6.3′ reservation is held for that whole span.
- **Stop** (`interrupt`, `live.ts:843-876`) or a **chain edit** (`setFallbackChain`, `:1780-1796`) during the wait:
  - interrupts the successor's turn;
  - closes and discards it with the existing catch-path cleanup (`:523-526`);
  - throws `SendCancelled`, so there is no backoff.
- **Just before `replaceWith()`** (`:531`), revalidate: hop id still current, not `retrySuppressed`, not `stopping`, chain unchanged, and `fallbackModeAllowed`. On failure, discard as above.
- **Ordinary manual carry** (a user-picked source change, no hop) is unchanged: no hop registration and no extra revalidation beyond today's.
- Tests:
  - Stop between enqueue and answer: the successor is discarded and the original stays;
  - a chain edit between enqueue and answer: same;
  - permission lowered between enqueue and answer: discard and back off;
  - ordinary manual carry still completes, with no regression.

## Fixes after Gemini review (round 7). These override anything earlier that conflicts.

Gemini reviewed the plan before rounds 2-6 landed. Its R1 rollback, R3 staleness, R4 Save-blocking and R2 move/return findings are already resolved by R1‴/R1⁗/R6, R3′/R3″, R4′ and R1⁗ respectively. The items below are new.

**G1. B4 is withdrawn.**
- Keep today's confirmation check, `s.state.billing?.label === next.label` (`live.ts:1664`), and strengthen it only with `&& s.state.billing?.source === next.source`.
- `billing.label(asked)` sets `source` only for `account:*` (`claude/index.ts:161`), so both sides are `undefined` for subscription, anthropic and bedrock.
- Test: a same-source hop on anthropic leaves `nextBilling` undefined; the same for bedrock.

**G2. `fallbackRun` is computed synchronously, and reasons are opaque.**
- `computeFallbackRun(s)` lives in LiveControl and reads only synchronous, cached data:
  - prefs and `s.state`;
  - `planFor`;
  - a **cached** catalog snapshot (`lastFallbackCatalog[sessionId]`), refreshed asynchronously after each `fallbackCatalog()` call and on credential or login changes;
  - presence of credentials and accounts.
- It is never called from `SessionCore.make` or the synchronous `keptPrefs`. LiveControl publishes it on open (an `opened` hook) and on successor handoff, after those finish.
- **Expiry:** the runner arms one timer at the earliest future `retryAt` or reset (R3′). The web also treats `until <= now` as "ready" for display.
- **Opaque reasons** in `LiveState`: the reason is an enum (`signedOut | unavailable | permission | limit | error`), never account names, emails or probe text. Owners map it to names on the web with `useAccountLabel`.
- Remove every remaining mention of a web-side `fallbackPlan()`. PR 3 and PR 5 follow R3′/R3″ and G2 only.

**G3. A failed provisional start is silent (amends R1‴).**
- During `provisionalStart`, a typed pre-turn auth failure must **not**:
  - emit "Couldn't start…" or the `send()` error notice;
  - call `read.set(failure)` or `markSourceSwitchFailed`;
  - set `s.state.error`;
  - reach `status(idle)` / `turnEnded` (no "Failed" push, no held queue).
- `startDriver` and `send` take a `provisional` flag that turns these into a returned typed error.
- "Switched to…" / "Resending…" notices are emitted only at commit (already in R1′).
- Test: no push, no inbox failure, no held queue and no notice, and state is unchanged.

**G4. One identity-tagged Claude usage store (concrete form of R5′).**
- Replace `claude-windows.json`'s untagged plan (`claude/context.ts:28,145-150`, written from `stream.ts:216`) with `{ [source]: { identity: { accountId, email, organization }, plan } }` for the main login and every extra account.
- `planUsage` / `keptPlan` (`claude/index.ts:199`) return the plan only when the identity matches the source's current confirmed identity. The refresh after a login change (in the runner's `harnessLoginChanged` path) therefore can't revive the old account's plan.
- All entries are loaded into `SessionCore.plans` at startup, so B1 works before any Claude session is opened.
- Untagged legacy data is ignored for skips.
- `claudeLoggedIn` (`claude/credentials.ts:168-176`) caches the parsed status, including `accountId`, not just a boolean. `sameAccountAs` uses it.
- Test: log out of the main login, sign in to another account, refresh, and restart: the old limit is not applied.

**G5. Bedrock (replaces critic point 5 and B9's model filter).**
- Bedrock steps use `DeploymentPicker`, as `NewSessionDialog.tsx:363` and `MoveDialog.tsx:143` do.
- For `source === "bedrock"`, `fallbackStepProblem` checks `!!resolveSourceModel(source.deployments ?? [], step.model)`. It does not require a match in `catalog.models.models`, and accepts both Bedrock IDs and aliases (`alias` is optional, `shared/credentials.ts:16`).
- "Start from this session" on a live Bedrock session (where `s.state.model` is the Bedrock ID) therefore validates.
- **Older runner:** if `fallbackSetup` comes from a runner without this check, the web keeps its Bedrock step model as a harness alias when one resolves. Otherwise it warns "Update the runner to use this Bedrock model".
- Tests:
  - an alias-less Bedrock model in the editor;
  - "Start from this session" on Bedrock.

**G6. Save rules (final).**
- Save is **never** blocked when `enabled` is false.
- When enabled, Save is blocked only for an empty chain, an exact duplicate (compared by effective values: an empty effort or mode equals the step's resolved default), or a missing model on an available source.
- Unavailable sources stay saveable (R4′).
- `SourcePicker` renders the explicit unavailable option even when `options.length === 0` (`SourcePicker.tsx:8`).
- "Save as preset" follows the same rules.

**G7. Chip CSS.**
- Change `app.css:2639` to `.t-chips .t-chip.t-next-api`, so it matches inside `.t-chip-options`.
- `.t-fallback-chip` keeps `cursor: pointer` even when it has `.t-chip-info`.

**G8. Corrected label inventory (PR 2).**
- `MoveDialog.tsx:142` passes `accountLabels`. `:174` is the legacy path and also gets them.
- `BillingChip.tsx:42,47,48,70` (chip body, title, aria-label) and the `CURRENT_SOURCE` entry (`sourceMenu.ts:32`) use account labels.
- `HarnessLogin.tsx` status span leaves out `displayName`, which `:171` already shows.
- The `SessionHeader` model menu string is at `:166`.
- Add a shared `sourceLabel(harness, source)` in `shared/credentials.ts` for runner-style labels without `fallbackSetup`, used by the chip and the viewer panel.
- `useAccountLabel` gets a module-level cache keyed by runner and harness, like `useSources`, so `SessionHeader` and `BillingChip` don't each spawn `claude auth status`.
- The dialog calls it for every harness used in the chain, not only Claude.
- Copy uses Tether's mode labels (`shared/labels.ts:41`, "Ask first").

**G9. `accountDisplayLabel` details.**
- When the name already came from the organization, `detail` leaves the org out.
- `normalizedOrganization` must handle an undefined email.
- Plan names are shown as given, not title-cased.
- Name collisions are resolved in a list-level pass in `useAccountLabel`.
- The copy moved to `shared/` must stay self-contained, because `claude/credentials.ts:202` embeds `normalizedOrganization.toString()` into the launcher script.
- `harnessLogin.ts:212` compares organizations through `normalizedOrganization`.

**G10. Runner edge cases folded into PR 1.**
- **B5 / handoff wait:**
  - `waitForFallbackHandoff` also waits on `sourceSwitchBlocker(s.state)` (`shared/sourceSwitch.ts:7-16`) and ignores queue entries added by a waited-on `!` shell (`shellRuns.ts:454`);
  - Stop during a returning wait (`live.ts:398`) cancels the user's send too, instead of falling through to the old source;
  - the early return at `:2108` calls `waiting()` the way `:2060,2083` do.
- **Notices:** `returnToFallback` and `fallbackExhausted` pass `step.harness`, not `harness`, to `labelOf` (`live.ts:2115,1969`).
- **Returning to an unavailable step:** it gets a `retryAt` backoff even when `returning` is true (`live.ts:2087`), so probes don't run on every message.
- **B2 shared backoff:**
  - match sibling steps against the current (harness, source, model) even when `start === -1`;
  - merge `{ ...progress.steps[i], retryAt }`.
- **"Unknown" probe** (`harnessLogin.ts:60,73`): go ahead and start (the provisional start then confirms or fails silently per G3). Show "unknown", never "signed out".
- **B6 notices:** update the `fallbackSwitch.test.ts:78,104` assertions. When `start === -1`, the copy is "Hit its limit. Switched to step M · …".
- **A manual billing-chip switch** while `fallbackChain.active` is set clears `active`. The next message then doesn't "return" over your pick.
- **"Start from this session"** with an unset or `"default"` model uses the source's first valid model.

**G11. PR bookkeeping.**
- PR 1 touches `shared/` too (`fallbackChain.ts`, `credentials.ts`). Drop "Runner only".
- Probe state (`HarnessAccount.probe`) goes in PR 2. On older runners, `available:false` with no `probe` reads as "Sign-in required", never "signed out".
- PR 5 depends on PRs 2, 3 and 4, and reuses PR 4's step-card rendering.
- **Older runners:**
  - no `FallbackSetup.current` → hide "Start from this session";
  - no `fallbackRun` → chip and viewer fall back to `state.fallbackChain` and `fallbackWaiting`.
- **Tests:** every test Gemini listed under "Missing tests" is added to the relevant PR.

## Fixes after re-review, round 8. These amend G2, G3, G4, G6, G10 and G11.

**G2′. Status inputs cache: a contract.**
- Cache **raw** inputs per (session, harness): the sources list, models, and permission modes **before** filtering by the session ceiling. Don't cache `fallbackCatalog`'s filtered output (`live.ts:1747`).
- **Seed** on session open and on successor handoff: kick off an async refresh for each harness in the chain. Until it lands, `computeFallbackRun` marks steps on that harness as `state: "checking"`; it never treats them as ready or unavailable.
- **Permissions are always recomputed from live state** (current mode ceiling and driver) at compute time, never cached.
- Each refresh carries a generation number. A refresh that resolves after a newer one started, or after the session closed or was replaced, is discarded.
- **Invalidate (and refresh)** on:
  - credential set or cleared;
  - account added, removed or signed out;
  - harness login changes;
  - catalog-affecting settings changes.
- Tests:
  - publishing on open before the first refresh shows "checking";
  - a mode change re-derives permissions with no refresh;
  - a stale in-flight refresh is discarded.

**G3′. Fallback carry: private answer detection and silent failure.**
- Fallback carry (R6b″) does **not** buffer the successor's output behind commit. The successor is a separate, not-yet-visible session (pinned, not linked in the sidebar, not replacing the original), so its transcript stays live, and `answered(n, seen)` (`live.ts:519-521`) keeps working unchanged.
  - R6.1's buffered sink applies only to same-session hops and to `returnToFallback`, where the target session is visible.
  - `moveFallback`'s successor is also an unlinked session, so it needs no buffer either: the successor stays unlinked until `replaceWith`.
- `carry()` takes a `fallback` option. With it:
  - the outer catch doesn't mark the original's source switch failed and emits no notice;
  - it returns a typed outcome (`cancelled | permission | authFailed | failed`) to `advanceFallback`;
  - cleanup (close, discard, `dropFresh`) runs on every outcome except success;
  - answer-gated replacement and the final revalidation before `replaceWith` stay (R6b″).
- Manual carry is unchanged.
- Test: an auth failure during fallback carry leaves the original with no `sourceSwitchFailed` and no notice, and the chain moves on with a backoff.

**G4′. In-memory eviction on identity change.**
- When the identity behind a source changes or is lost (login change, account removed, or the probe reports a different accountId), evict that source's entry from `SessionCore.plans` and clear the published `state.plan` on sessions using that source, **before** any refresh.
  - The concern: `refreshPlan` keeps the old entry when the adapter returns nothing, and `notePlan` merges into it (`sessions.ts:508-526`).
- Identity is validated **before**:
  - hydrating startup entries;
  - merging a live report in `notePlan`;
  - persisting.
- Tests, in order:
  1. a same-process account change, with no restart, shows no stale window;
  2. the restart case.

**G6′. Saving with incomplete steps.**
- The runner's `cleanFallbackSteps` (`live.ts:1815`) requires a model on every step. The editor serializes only **complete** steps: harness, source and a nonempty model.
  - A step with an **unavailable source** but a saved model is complete, and is sent as is.
  - A step with **no model** (a fresh draft) is incomplete.
- Saving while `enabled` is false: incomplete drafts are dropped from the payload, after the inline note "1 unfinished step won't be saved". Complete steps, including unavailable ones, are kept.
- Saving while `enabled` is true: blocked while there are incomplete steps (G6's "missing model" rule).
- **Presets** follow the same rules.
- **Older runner:** same payload, since only complete steps are ever sent, so it's compatible.
- Tests:
  - turning the chain off with one draft step saves the other steps;
  - same for a preset save.

**G10′. The unknown-probe contract lives in PR 1.**
- The runner's source catalog (`sources()`, `live.ts:1532-1539`) lists every **configured** extra account, except one mid sign-in, with a `probe: "signedIn" | "signedOut" | "unknown"` field on the source option.
  - Today `harnessLogin.ts:216` folds "unknown" into `available:false`, which is used only for the owner listing. That stays as it is for older webs.
- `fallbackStepProblem` (`shared/fallbackChain.ts:45`):
  - "Login or key unavailable." stays for sources missing from the catalog (removed or never configured);
  - a new problem, "Signed out", applies to `probe === "signedOut"`;
  - `"unknown"` is **eligible**.
- Credential lookup for an unknown-probe account uses the stored identity. The provisional start then confirms the account or fails silently (G3).
- PR 2 only surfaces `probe` in the UI.
- **Returning exit:** when every candidate on a returning pass is skipped, the new `retryAt` values are persisted (`prefs.set fallbackProgress` and `flush`) before the returning exit at `live.ts:2168`, which bypasses `fallbackExhausted`.
- **Queue exception:** the waited-on `!` shell queue exception is applied inside `sourceSwitchBlocker`'s queue check too, via an `ignoreQueueIds` parameter.

**G11′. Missing-tests list, written out.** These are assigned to PRs 1, 2 and 4.
- **PR 1:**
  - B4/G1: same-source hops on anthropic and bedrock leave `nextBilling` undefined;
  - G4/G4′: main-login logout and new sign-in, same process then restart, applies no old limit;
  - G3/G3′: an auth failure after a provisional start causes no push, no inbox failure, no held queue, no notice, and leaves state unchanged; the same for fallback carry;
  - R2: a permission rejection in `moveFallback` and in `returnToFallback` backs off; Stop during a returning wait doesn't send on the old source;
  - cross-harness return notices name `step.harness` (Codex → Claude account, and back);
  - a returning pass with every candidate skipped persists `retryAt`;
  - unknown probe → start is attempted; signed out → skipped.
- **PR 2:**
  - the `HarnessLogin` status line doesn't repeat `displayName`;
  - a list-level collision pass;
  - an undefined email in `normalizedOrganization`;
  - the `useAccountLabel` cache doesn't double-probe.
- **PR 4:**
  - an alias-less Bedrock model;
  - "Start from this session" on Bedrock;
  - turning off a chain that has a removed account, a duplicate step or a draft step;
  - `SourcePicker` with zero options shows the unavailable value.

## Fixes after re-review, round 9. These amend G3′, G2′ and G6′.

**G3″. Successors (move and fallback carry) are quiet until replacement.**
- A provisional successor session gets a `provisional` flag. While it is set:
  - Its events go to the session's **own** transcript and state, so `answered(n, seen)` keeps working.
  - Global side effects are held in a per-session queue:
    - bus emits (`turnEnded` at `live.ts:2484`, `fallbackStatus`, inbox `read.set`, push);
    - queue hold or release;
    - sidebar summary publication.
- **On replacement commit:**
  - the flag is cleared;
  - held side effects that still apply are replayed, for example the successor's own `turnEnded` after its answer;
  - effects superseded by the handoff are dropped. A `turnEnded` that the hop itself handles counts as handled.
- **On discard,** the held queue is dropped, so no push, inbox entry or notification ever fires for a discarded successor.
- Test: a successor whose turn ends before commit fires no push; after commit, exactly one `turnEnded` is published.

**G2‴. Cache seeding and invalidation (adds to G2′).**
- Chain save (`setFallbackChain`) seeds a refresh for every harness in the new chain that has no cache entry.
- Driver install or replace on the session invalidates the cache entries for that harness, because `listModels` depends on the driver, and kicks off a refresh.
- Test: adding a Codex step to a Claude-only chain moves that step from "checking" to a real state without opening the catalog elsewhere.

**G6″. Draft rows (final rule).**
- **Complete row:** harness, source and a nonempty model. It's always serialized, even when its source is unavailable.
- **Draft row (no model), when saving:**
  - its source is available → Save is blocked while enabled, with "Pick a model for step N";
  - its source is unavailable (it can't be completed), or the chain is off → the draft is left out, with the inline note "N unfinished step(s) won't be saved".
- After this, the serialized chain is validated (non-empty when enabled, no exact duplicates) before sending.
- Presets follow the same rules.
- Test: a draft whose source becomes unavailable while the editor is open is left out on Save with the note, and complete unavailable rows are kept.

## Round 10. A one-line correction to G6″.

The checks on the serialized chain (non-empty, no exact duplicates) run **only when `enabled` is true**. Turning the chain off always saves: complete rows are kept, including duplicates and unavailable ones, and draft rows are left out with the note.

## Round 11: fixes after the Claude Opus review. These override everything above.

**O1. The hop token is `fallingBack`, with one lifecycle.**
- `hopId` **is** the `fallingBack` entry: `fallingBack: Map<Session, { hopId, pending?, successor? }>`.
- **Lifecycle:**
  - set when a hop starts (as today);
  - **not** released in `send()` (remove the delete at `live.ts:400-402`);
  - released **synchronously inside commit**, as the first step, before the live sink is installed, the buffer replayed or deferred turn-end run. A turn that ends after commit (Y is full too) therefore sees no reservation, and `fallbackPending` / `canAdvanceFallback` work as they do today;
  - on discard, released after cleanup.
- `interrupt` looks up `fallingBack.get(s)` (or the successor's original through a `successorOf` map) and sets `retrySuppressed` on the original. It also discards `pending` or the successor. This covers carry's `answered()` wait (R6b″).
- **User sends during a hop:** keep today's rejection in `sendNow` (`live.ts:330-331`), but word it "Switching accounts… your message will be sent when it's done" **and queue the message** instead of dropping it. It goes into the session queue, held with `queueHeldBy: "fallback"`, and is released on commit or discard. This replaces R6.3′'s "queue behind".
- Tests:
  - Y is full right after commit → the next hop happens;
  - Stop during carry's `answered()` → `retrySuppressed` is set and the successor is discarded;
  - a user send during a hop is queued and sent after commit.

**O2. Carry hops are the one exception to "nothing written until commit", and they restore on failure.**
- On a carry harness, `setSource` writes `active`, `nextSource`, `nextFallbackSettings`, `nextModel`, `nextBilling` and `nextDeployment` before carry runs (`live.ts:1650-1656`). That stays.
- The hop snapshots those fields plus `sourceSwitchFailed` first.
- **Every non-success outcome** of a fallback carry (`cancelled | permission | authFailed | failed`) restores the snapshot, guarded by the hop token (a newer manual change wins).
- Only after the restore does `advanceFallback` continue to the next candidate, or reach `fallbackExhausted`.
- `fallbackRun` reports the restored current step.
- Test: carry auth failure → the next candidate is cross-harness and also fails → exhausted. `nextSource` is cleared, and the next message stays on X.

**O3. Identity matching (replaces the accountId parts of R5′, G4 and G4′).**
- **Process identity meets stored identity:** compare lowercased email plus `normalizedOrganization`. This applies to live `notePlan` reports, G4 store reads and eviction checks. It is what `sameClaudeIdentity` does today (`claude/credentials.ts:66-72`). The SDK's `AccountInfo` has no orgId, so `accountId` can't be computed on the process side.
- **`accountId`** (`sha256([email, orgId||orgName])`) is compared only between two records derived from `auth status` (`sameAccountAs`, cross-source window sharing).
- G4's store tag is `{ email, organization, accountId? }`.
- Test: a live report from an extra account's process is accepted and stored; a report from a process for a different email is dropped.

**O4. Adapter-side writes during a provisional start.**
- The driver start takes `{ provisional: true }`. While it's set, `keepBilling` (`claude/driver.ts:205-209`) and any plan or claude-windows write are held in the driver and flushed on commit (`driver.commit()`), or dropped on discard.
- **Allowed during a provisional start:**
  - Claude's own writes into its config dir (the session file, credentials refresh);
  - Tether's in-memory state on `pending`.
- **Nothing else.**
- R6a's byte-identical test covers stored billing (`keptBilling`).

**O5. Under-specified items, now specified.**
- **Commit 1 of PR 1** threads an explicit `StartConfig` (source, model, effort, mode, deployment, credential, sink) through:
  - `startDriver`, `startOpts` / `chosen`, `sourceOf`, `deploymentOf`, `credentialFor`, `subscriptionRevisions`;
  - `sink(s, source)` (`live.ts:2219-2250`).
  
  Today's callers pass the config built from the session. `provisionalStart` passes `pending`.
- **What the session shows during a provisional start:** status stays as it was (idle). A `switching: { step }` live-state field drives the chip's `Switching…` and the "Now" card.
- The provisional resend does **not** go through `send()`'s `status(running)`. It uses a dedicated `provisionalSend` that sets `running` only at commit.
- `beforeEnqueue` also checks `s.cancelSend !== me`.
- **Commit runs synchronously inside the driver's `enqueued` callback.** There is no `await` between enqueue and `s.driver = pending.driver`.
- **Deferred turn-end** captures the whole idle branch's inputs at the moment it happens: `limitHit`, `rateHit`, `lastSend`, `turnActed`, `retry` state and the status transition. It replays them after commit. Deferring only the bus emit is not enough.
- **G10′ probe cost:** probe results are cached per source for 60 s, and invalidated on login or account changes. `sources()` reads the cache and refreshes it in the background when stale. "unknown" is used until the first result.

**O6. Non-blocking, adopted:**
- **Toggle default:** the first deliberate step edit (add, remove, reorder or change) on a new chain turns "Use for this session" on, with the note "Turned on. Untick to save without using it".
- **One shared `sameStep(a, b, resolved)`** in `shared/fallbackChain.ts` is used by both the editor's duplicate check and the runner's identical-step skip (`live.ts:2101`). An empty effort or mode equals the resolved default.
- **SPEC:** note that under R1‴ a Claude hop with no resend starts a process in order to commit.

**O7. Superseded body text. Implementers: ignore these.**
- B4 (replaced by G1).
- B8's catch-and-continue (replaced by R1‴, G3 and O2).
- B9's Bedrock `<select>` (replaced by G5).
- The "Save is blocked when" list and R4 (replaced by G6, G6″ and round 10).
- Every web-side `fallbackPlan()` mention in the Tests and PR lists (replaced by R3′, R3″ and G2).
- Backend 11's "derive in `keptPrefs` / `sessions.ts:343`" (replaced by G2: publish after open and handoff).
- The label table's "signed out" row for unconfirmed probes (replaced by the G10′ probe states).
- R5′'s accountId matching (replaced by O3).
- R6.3′'s "queue behind" (replaced by O1).

## Round 12. These amend O1, O2, O3 and O5.

**O1′. Queue-hold release order.**
- Commit releases the hop **token** synchronously, as its first step (O1).
- The hop-owned `queueHeldBy: "fallback"` hold is released **on the surviving session after `replaceWith` / `queue.handOver` finishes** (`live.ts:576`). For a same-session hop, that is the same session, right after commit.
- Release clears only a hold this hop set. If the queue was held for another reason before the hop (`stopped`, `terminal`, …), that reason is kept.
- On discard, the hold is released on the original after cleanup, also keeping any earlier reason.
- Test: a cross-harness hop with a queued user message. It is sent on the successor exactly once, and the successor isn't left held.

**O2′. One discard path, with restore inside it.**
- Every way a hop can end without success (Stop, a chain edit, a permission rejection, an auth failure, any other failure, or carry unwinding from `answered()`) goes through a single `discardHop(s, hopId, outcome)`. It runs, in order:
  1. close and discard the provisional driver or successor, dropping held adapter writes (O4), including writes from confirmations still in flight;
  2. **restore** the hop-owned fields from the snapshot: `active`, `nextSource`, `nextFallbackSettings`, `nextModel`, `nextBilling` (state and prefs), `nextDeployment` and `sourceSwitchFailed`. Restore only fields whose current value still equals what the hop wrote. A chain edit or a manual change made meanwhile wins;
  3. release the queue hold (O1′);
  4. release the token.
- Stop calls `discardHop` for the current token; it doesn't release the token itself.
- **No-resend carry:** the snapshot lives until the deferred carry on the next message succeeds (it is then dropped) or fails (then `discardHop` runs). A new hop or a manual source change also drops it.

**O3′. Identity: accept by email and org, tag with the ID, check the ID when both sides have one.**
- **Live reports:** accept when lowercased email plus `normalizedOrganization` match the source's confirmed identity (O3). Then store the report tagged with that source's **confirmed auth-status `accountId`**, which the runner already has.
- **Store reads, eviction and cross-source sharing:** require email and normalized org to match, **and** `accountId` to match whenever both sides have one. Two accounts with the same email and org name but different org IDs therefore never share windows.
- Test: same email and org name with different `orgId` → no sharing, and no stale read after a switch.

**O5′. Probe results are published.**
- When a background probe settles (G10′) with a different result than before, it invalidates the raw catalog cache for that harness (G2′) and triggers a refresh plus a `fallbackRun` republish for every session whose chain uses that source.
- Each probe carries the login/account generation it started under. A completion from an older generation (a login or account change happened since) is dropped.
- Test: "unknown" → a background probe confirms the sign-out → the step becomes "Signed out" and isn't eligible, with no other event needed.

**Clarification:** O5's "commit synchronously in the `enqueued` callback" applies to non-carry hops only. Fallback carry keeps its answer-gated commit (R6b′, R6b″): the replacement happens after `answered()` plus revalidation.

## Round 13. These replace O1's queueing, O1′, and O3′'s report tagging.

**Q1. Gate the queue drain, with no "fallback" hold.**
- The queue's `paused` host hook (`live.ts:161`) returns true while `fallingBack.has(s)`, or while `s` is a provisional successor. `drain()` (`queue.ts:407`) therefore never sends during a hop. Queued messages and scheduled messages that come due mid-hop simply wait.
- During a hop, a user send from `sendNow` goes to `queue.add(s, …)` **unheld**, and the user sees "Switching accounts… queued". Queued sends never reach the `fallingBack` reject path, because drain is gated.
- `queueHeldBy: "fallback"` is **dropped**: no new union value, nothing persisted, and nothing stuck after a restart. Any hold reason that existed before the hop is untouched.
- **Commit:**
  1. clear the successor's `provisional` flag;
  2. `replaceWith` / `handOver`;
  3. `queue.later(survivor)`;
  4. replay the deferred turn-end.
- `discardHop` calls `queue.later(original)` after cleanup.
- The queue's `turnEnded` listener skips `hold("failed")` when that turn ended with `fallbackPending` (`queue.ts:86`).
- Tests:
  - a message already queued at hop start is sent exactly once on the successor, and the queue isn't held "failed";
  - a scheduled message that comes due mid-hop waits and isn't marked held;
  - a restart mid-hop leaves no stuck hold;
  - a limit turn that also carries an error doesn't hold the queue while a hop follows.

**Q2. A live report is tagged with its process's start-time identity.**
- Each Claude process records the identity confirmed at its start, including `accountId`:
  - extra accounts: from `expected` (`credentials.ts:236`);
  - the main login: from `confirmClaudeBilling`'s status.
  
  It also records the login/account generation at that moment (O5′).
- `notePlan` from that process is stored **tagged with that start-time identity**, never the source's current one. A report is dropped when its generation is older than the source's current generation.
- Test: switch to an account with the same email and org name but a different `orgId`, then deliver a late report from the old process. It is dropped, and no window is stored under the new ID.

**Notes adopted:**
- The successor's `provisional` flag clears before `replaceWith` (order in Q1).
- `discardHop` for a failed no-resend carry (on the next message) also puts a 10-minute backoff on that step, so the next limit doesn't retry it right away.
- O2′'s restore list includes `lastKey`.

## Round 14. These amend Q1 and Q2.

**Q1′. A queue gate that lives through handoff, and a defer outcome.**
- The `paused` hook keeps its existing `heldWhy` check and adds: `fallingBack.has(s) || s.provisional || s.handoffGate`.
- **`handoffGate`** is an in-memory flag, independent of the hop token. It is set on **both** the original and the successor when commit begins, and cleared only after `replaceWith` / `handOver` has transferred the queue. Commit order:
  1. set `handoffGate` on both;
  2. release the token (O1);
  3. clear the successor's `provisional` flag;
  4. `replaceWith` / `handOver`;
  5. clear `handoffGate` on both;
  6. `queue.later(survivor)`;
  7. replay the deferred turn-end.
- On discard: O2′ restore, then release the token, then `queue.later(original)`. No gate is needed there, because nothing is handed over.
- **Defer outcome for a drain already in flight:** when `sendNow` is reached with `o.queued` and finds `fallingBack`, `provisional` or `handoffGate` set after admission, it throws a typed `QueueDeferred`. `drain()` treats `QueueDeferred` as "not sent, not failed". It puts the **original item** back at its position with its id, schedule and hold state unchanged, and doesn't hold the queue. The user-send branch (`queue.add` unheld) applies only to non-queued sends.
- Tests:
  - a drain admitted just before a hop starts → `QueueDeferred` → the item is restored unchanged and sent once after commit;
  - a drain that wakes during `handOver` doesn't claim work on the original.

**Q2′. When identity is captured.**
- Startup captures the login/account generation **before** the async auth-status lookup. If the generation changed by the time the lookup returns, the start fails as stale (O5′ rule).
- **Main login:** `accountId` is derived from the raw `auth status` in `expectedClaudeIdentity` (`credentials.ts:151`). It doesn't come from `confirmClaudeBilling`, which only sees the SDK's `accountInfo()` (no orgId).
- The captured tag `{ identity, generation }` travels through O4's buffered adapter writes. Its generation is checked again when the writes are published at commit.

## Approved (Claude Opus, round 14). Implementation notes

1. Put the `QueueDeferred` check, and the matching user-send queueing, **also** at the claim point, in the same synchronous step as `s.sending = me` (`live.ts:415-417`), not only at `:330`. There are awaits in between (`terminal.settled` at `:351`, the returning branch at `:398`).
2. For same-session hops, R6.5's steps (apply `pending`, install the driver, replay the buffer) slot in after Q1′ step 2 or 3, all synchronous (O5). `handoffGate` then covers a single session.
3. While `handOver` runs, `queue.add` on the successor waits for `handoffGate`, so moved items keep their order ahead of new ones (`queue.ts:233`).
4. For extra accounts, Q2's start-time identity comes from `credential.claudeAccount` in `expectedClaudeIdentity` (`credentials.ts:151-155`), not from the launcher script at `:236`.
5. The defer check exempts sends that carry the hop's own `o.fallback` symbol, as `:330` already does.
