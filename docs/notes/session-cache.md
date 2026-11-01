# Session cache: opening sessions without "Opening…"

Proposal, 2026-11-01, at `fc90990`. Nothing here is built yet.

Goal: a session this device has seen opens from local storage at once. An inactive one looks done
straight away; an active one shows its cached rows with an inline "Loading recent messages…" until
live sync catches up. The cache is bounded and safe to throw away.

Numbers marked **(measured)** come from this machine: dev stack (server :8790, runner
`tether-dev`, vite :5180, production build on :5181), real session stores read-only, Chromium and
WebKit from Playwright. Numbers marked **(est.)** are not measured. Scripts are listed at the end.

## 1. Why opening is slow today

### The open path

1. `App.tsx` mounts `SessionView` keyed by `runner\0session`. `SessionView` shows the spinner
   (`SessionView.tsx:137`) until `view.window`, `view.state` and a summary all exist.
2. `openView` (`store.ts:180`) makes a **new, empty** `SessionModel` and `subscriptions.watch` sends
   the `subscribe` rpc. When the view closes, the model is deleted (`store.ts:198-206`). Nothing about
   a session survives leaving it, so going back to the session you just left costs a full open.
3. The relay (`server/src/relay.ts`) records the route and forwards the rpc to the runner.
4. The runner (`sessions.ts:382 subscribe`): `open()` → `make()` (summary, `adapter.defaults()`, which
   for Claude runs the SDK's `resolveSettings` and reads the store's settings) → `load()` →
   `readHistory()` parses the whole JSONL (`jsonl.ts`, incremental and cached, but only 4 unwatched
   files stay parsed) → `storedContext()` → `snapshot(50)`, capped to 2 MB (`newestPage`).
   A session nobody watches leaves runner memory after 60 s (`scheduleEvict`).
5. The snapshot goes back through the relay as one uncompressed JSON frame (the server's
   `Bun.serve` websocket has no `perMessageDeflate`).
6. `SessionModel.onSnapshot` → `publish` → React renders up to 50 rows (Markdown, tool cards).

### Where the time goes

| Stage | Cost | |
|---|---|---|
| Runner, cold (not in memory, file not cached) | Claude 54-250 ms, Codex 8-356 ms | measured, `subscribe` rpc on loopback |
| Runner, warm (opened < 60 s ago) | 2-6 ms (one Codex: 63 ms) | measured |
| JSONL parse alone | 30 MB file: 191 ms parse + 28 ms to messages; 9 MB: 63 + 12 ms; 1.6 MB: 20 + 4 ms | measured |
| Snapshot size (last 50), Claude sessions with ≥ 20 messages, last 14 days (46) | p50 103 KB, p90 185 KB, p99 433 KB | measured |
| Snapshot size, worst seen | 1.77 MB (a Codex thread, 36 messages; 1.57 MB of it shell output, ~64 KB per call) | measured |
| Same windows gzipped | p50 29 KB, p90 44 KB (≈ 3.5x smaller) | measured |
| Render 50 rows after the data lands (desktop Chromium, prod build) | ≈ 80-120 ms | derived: prod-build open time minus data arrival timed in the dev build |
| Whole open, loopback, prod build | switch 113-208 ms, cold page load 346 ms | measured |
| Whole open, throttled to 150 ms latency / 1.6 Mbit/s | switch 1.07-1.43 s, cold page load 1.49 s, reload 2.32 s | measured (Chromium network emulation) |
| Whole open, a phone on cellular to the hosted app | 1-3 s per open | est. (not measured against prod) |

So the time is mostly **network**, not the runner: every open, including going back to the session
you just left, is a relay round trip carrying ~100 KB uncompressed, followed by a full render.
On loopback it's ~0.2 s; with phone-like latency and bandwidth it's over a second, and a 1.7 MB
snapshot would take ~9 s at 1.6 Mbit/s (est.). The runner adds up to a quarter second on a cold
open of a very large session.

### Smaller problems found on the way

- **"Can't open this session" flashes on a cold page load.** `subscribe` goes out before the socket is
  open, `link.rpc` rejects with "Not connected.", `SessionModel.onError` sets `view.error`, and the
  view shows the error until `hello` resubscribes. Measured: spinner at 238 ms, "Can't open this
  session / Not connected." at 286 ms, transcript at 523 ms (loopback, prod build).
- **Phone wake.** A socket that looks open but is dead waits `probeMs` (5 s) before redialling
  (`link.ts wake`); a session opened in that window shows "Opening…" for 5 s or more (est., from code).
- **No asset caching.** The 1.26 MB JS and 250 KB CSS have no service-worker cache, so a phone
  that killed the PWA downloads them again before anything shows (est.; depends on Foliation's
  cache headers, not checked).

## 2. Storage: IndexedDB

| | localStorage | IndexedDB | Cache API | OPFS |
|---|---|---|---|---|
| Size | ~5 MB per origin, shared with Tether's other keys | hundreds of MB to GB (Chromium reported 4.3-5.4 GB here, WebKit 1.05 GB) | same quota as IDB | same quota |
| API | sync, strings only | async, structured clone, indexes, transactions | Request/Response pairs | files; sync access only in workers |
| Main thread | blocks on every read and write | clone on write only | | |
| Fit | a full cache is ~3-8 MB: doesn't fit, and a quota error would also break the device id, runners list and queue edits stored there | records keyed by session, an index for LRU | awkward for structured records | overkill |

Measured with a real 120 KB window (Chromium / WebKit): IDB open 11-17 ms (≈ 100 ms the first time,
when the database is created), put 3-7 ms, get 1.4-2 ms. A 1.77 MB record: put 23-29 ms, get
6-13 ms. localStorage is a little faster per call but can't hold the budget.

**Recommendation: IndexedDB**, one database `tether-cache`, one object store `sessions`
(keyPath `key`), an index on `openedAt`. Records are stored as structured clones (no JSON, no
compression: compression would save ~3.5x of a budget that's already small and costs CPU on
phones). No dependency; a ~100-line wrapper.

**Phone Safari.** Script-writable storage (IDB included) of a site is deleted after 7 days of
Safari use without a visit; a web app added to the Home Screen is exempt (its own storage, no
7-day rule). Storage can also go under disk pressure. Ask `navigator.storage.persist()` once (a
no-op where not granted). Either way the design treats the cache as disposable: a missing record
just means today's behavior.

## 3. What to store

One record per session:

```ts
interface CachedSession {
  key: string;            // `${userKey}\0${runnerId}\0${sessionId}`
  v: number;              // CACHE_SCHEMA (bump on any shape change) …
  protocol: number;       // … and PROTOCOL_VERSION; either mismatch: ignore and delete
  runnerId: string;
  sessionId: string;
  session: SessionSummary;           // title, harness, projectPath, updatedAt, status
  capabilities: HarnessCapabilities; // so the view renders the same chips
  window: TranscriptWindow;          // newest messages, trimmed (below); hasOlder kept
  state: CachedState;                // display-only fields, below
  activityAt: number;     // session.updatedAt when saved: the cache's "as of"
  openedAt: number;       // last opened on this device (the LRU key)
  savedAt: number;
  bytes: number;          // JSON length estimate, for the budget
}
```

**State kept:** `mode`, `status`, `model`, `effort`, `permissionMode`, `context`, `billing`, `cost`.
**Never kept:** `requests` (approvals and questions), `queue`, `queueHeld*`, `terminal`, `plan`,
`error`, `restartWait`, `continuedIn`, `carried`, `nextBilling`, `autoKey`, `lastKey`, and local
notices (`n-local-*`). Anything actionable or account-wide comes only from a live snapshot.

**Trim on write** (a pure function, `cacheWindow()`, unit-tested):
- the newest messages, at most **50** (the snapshot page), and at most **256 KB** (JSON length);
  always at least the newest message, cut if it alone is bigger;
- tool output over **4 KB** and text over **16 KB** stored cut, with the existing `truncated` marker,
  so Show all fetches it whole through `fullPart` exactly as for parts cut today; image data over
  **64 KB** dropped the same way;
- `hasOlder` true whenever anything was left out.

**Scroll position: not stored.** Today a session opens at the latest message, and the cache keeps
that. (The in-memory step below could keep it for free on desktop switching; see open decisions.)

**No sync cursor.** A `seq` is per runner process and restarts with it, and the runner keeps no
event log, so "send me events since seq N" isn't possible without new runner state. Revalidation
is a normal subscribe (step 2) and later a content-hash diff (step 4).

## 4. Budget and eviction

Sizes behind the numbers (measured, §1): a 50-message window is p50 103 KB, p90 185 KB, p99 433 KB;
with the trim above, p50 99 KB, p90 171 KB (the 4 KB tool cap alone; the 256 KB cap bounds the rest).

| | Value | Why |
|---|---|---|
| Messages per session | 50 | the snapshot page: the cache shows exactly what a fresh open shows |
| Bytes per session | 256 KB | above p90; the p99 and Codex outliers get cut, not dropped |
| Sessions | 30 | more than the sidebar's 3-day list usually holds of sessions you actually open |
| Total | 8 MB | 30 × 256 KB = 7.7 MB worst case; typical 30 × ~100 KB ≈ 3 MB |
| Age | 14 days since last opened | a transcript shouldn't sit on a device forever |

**Eviction:** LRU by `openedAt` (last opened on this device), not by session activity: what you
reopen is what you looked at, and activity-based order would let a busy background session push
out the one you read every day. Never evicted: the session open now. After each write, delete
oldest-first until both the count and the byte cap hold; at startup, drop records past 14 days.
On a `QuotaExceededError`: evict the oldest half and retry once, else skip the write silently.
Children (subagent sessions) count like any session; they're small.

**What gets cached:** only sessions opened on this device. Prefetching the sidebar's top sessions
would make never-opened sessions instant too, at the cost of a snapshot per session over the
network and runner parses; left as an open decision (step 5).

## 5. Behavior

### Definitions

- **Synced:** the view has applied a live snapshot (`SessionModel.ready`).
- **Provisional:** rendered from the cache (or the in-memory copy), not yet synced.
- **Active:** by the freshest summary known (the live broadcast if there is one, else the cached one):
  `status` is `running` or `waiting`, or it has `requests`, `queued` or `backgroundSubagents`, or
  `mode` is `terminal`.
- **Behind:** a live summary's `updatedAt` is newer than the cache's `activityAt`.

### Inactive and not behind

Rows render at once from the cache, no spinner and no indicator. The subscribe goes out as today;
when the snapshot lands it joins the cached window (below). The usual result is that nothing
visibly changes.

### Active, or behind

Cached rows at once, and at the bottom of the transcript, where the working footer sits, one inline
line: **"Loading recent messages…"**. It goes when the view is synced; the live footer and events
take over as today. Nothing in the header or status bar.

### While provisional

Read-only:
- no request dock, no queue list, no Stop (they come only from live state);
- the composer takes typing, but Send waits for sync (it would go to a runner that hasn't confirmed
  the session yet);
- model, effort, mode and source chips, Terminal, Background, Show all, and paging older are
  disabled until synced (`history`/`fullPart` need the runner to have loaded the transcript);
- the `continuedIn` redirect effect (`SessionView.tsx:74`) keys on synced, not `loaded`, so a
  cached view never triggers navigation.

With no cache record the view behaves as today ("Opening…").

### Reconciling

`SessionModel.onSnapshot` already joins a snapshot onto a loaded window for reconnects
(`joinPage`): the page wins for the range it covers, and older loaded messages before where it meets
stay. A cached window is seeded as exactly such a loaded window, flagged provisional. Changes:

- **No meeting point** (compaction, rewind, a session replaced, a cache from long ago): replace
  the window with the snapshot instead of opening a gap and paging it in. Cached rows are only a
  placeholder; they're not worth ten `history` calls.
- **Equal rows keep their objects.** Before publishing, a row whose content is unchanged (same id
  and the same serialized content, or `partRev` for every part) keeps the cached object, so memoized
  rows don't re-render and nothing flickers.
- **Scroll:** a reader following the bottom keeps following (new rows append below, as with live
  events). A reader who scrolled up keeps their place, by the transcript's existing rules for rows
  added above and below.
- A cached tool card that was `running` becomes whatever the snapshot says; until then it shows as
  it was saved, without "Waiting for you" (that comes from `requests`, which aren't cached).

### When the cache is written

Never per event (streaming would clone hundreds of KB per delta; see the GC stall in ISSUES.md).
Written, trimmed, on:
- the first snapshot applied (so a session opened once is cached);
- the view closing (`openView`'s close);
- the page hiding (`visibilitychange` to hidden, `pagehide`): phones kill backgrounded tabs;
- a turn ending (`status` back to `idle`), debounced 2 s.

### When records are deleted

- `subscribe` fails with "That session isn't on this runner any more." (deleted, or its store gone);
- a move or carry: the old id's record goes when its snapshot says `continuedIn`/`carried`;
- Forget runner (`forgetRunner`): all of that runner's records;
- a different user in `hello` than the one the cache belongs to: the whole database;
- signed out or not an owner (`auth` becomes `signedOut`/`notOwner`): the whole database;
- schema or protocol mismatch: the record (or the store, on a database version bump).

A summary `remove` is **not** a deletion: it also means a session left the 3-day list.

## 6. Correctness risks

| Risk | Handling |
|---|---|
| Stale or edited rows (tool results, a message replaced, a compaction) | the snapshot wins for its range; no meeting point replaces everything |
| A cached request or permission prompt acted on | requests and queue are never stored; actions disabled until synced |
| A stale status ("running" from yesterday) | cached status is a hint only: it shows the inline indicator, nothing else |
| Session deleted, moved to another harness, carried | deletion rules above; redirect only after sync |
| Runner offline | cached rows stay, read-only, and the existing "The runner is offline." line shows; better than today's spinner |
| Two runners | keyed by runner; the same session id on two runners can't collide |
| Two runners sharing one id (a copied `runner.json`) | already unsupported (README); worst case a cached view replaced by the snapshot |
| Multiple tabs | one IDB for the origin; last write wins per record, each tab revalidates on open. No cross-tab messaging needed |
| Runner restart (seq starts over) | not an issue: no seq is cached |
| Codex message ids unstable across reads | the join finds no meeting point and replaces (a re-render, maybe a scroll reset). Verify in step 2 |
| Old runner / new web or the reverse | the record carries `PROTOCOL_VERSION`; step 4's hash diff is optional on the wire |
| Schema migration | bump `CACHE_SCHEMA` or the database version; `onupgradeneeded` drops and recreates the store. It's a cache: never migrate |
| Privacy: transcripts at rest on the device | today nothing of a transcript persists on the device. With the cache, up to 8 MB of recent conversation does, tool output included, which can hold secrets. Bounded by the caps and the 14-day age; wiped on sign-out and user change. Encrypting with a key stored in the same origin wouldn't protect against anyone holding the unlocked device, so it isn't proposed. See open decisions |

## 7. Rollout

Each step ships on its own and leaves the app working if the next never comes.

**Step 0: fixes that don't need a cache.**
- Don't subscribe while the link isn't open (or don't record "Not connected." as `view.error`); `hello`
  resubscribes anyway. Files: `subscriptions.ts` or `sessionModel.ts onError`, `store.ts`. Test:
  unit test; `flash.mjs` sees no "Can't open" on a cold load.
- `perMessageDeflate: true` on the server's websocket (`server/src/app.ts`), browser sockets first:
  snapshots ~3.5x smaller on the wire. Check that Foliation's edge negotiates the extension
  (`Sec-WebSocket-Extensions` in the browser) and the relay's CPU. Test: relay tests, measured
  bytes in DevTools.

**Step 1: keep recently closed sessions in memory.** On close, `openView` moves the model to a
small LRU (5 sessions, 10 minutes) instead of deleting it; reopening seeds the view from it
(provisional) and subscribes as usual. This builds the whole provisional path with no storage:
`SessionView` (no spinner when a window exists, the inline indicator, `continuedIn` on synced),
the read-only gating (`RequestDock`, `QueueList`, `Composer`, `SessionHeader` chips, `ToolCard`
Background, `useFullParts`, `loadOlder`), and `SessionModel` (provisional flag, replace on no
meeting point, keep equal rows, strip state). Test: `sessionModel.test.ts` for join, replace,
equal-row reuse and stripping; Playwright: A → B → A shows no "Opening…", an active session shows
"Loading recent messages…" then the live footer, no request dock before sync.

**Step 2: IndexedDB.** `web/src/sessionCache.ts`: open, get, put, delete, evict, wipe, all failing
quietly. `cacheWindow()` trim and the budget policy as pure functions (shared or web), unit-tested
without IDB. `store.ts`: on `openView`, read the record (async, ~2 ms) and seed the model if no
snapshot came first; write triggers; deletion rules; user key from `hello` (with the last user
kept in localStorage so a cold load can read before `hello`). Test: unit tests for trim and
eviction; Playwright on Chromium and WebKit: reload with the websocket blocked shows cached rows
read-only; reload with it open revalidates with no visible change; sign-out empties the database;
a deleted session's record goes.

**Step 3: tune with real numbers.** Log (dev only) cache hits, provisional duration, record sizes;
adjust the caps.

**Step 4: send only what changed.** `subscribe` takes an optional `have: { id, h }[]` (the cached
window's ids and a content hash, `hashString` of the capped message). The runner answers with
`{ id, same: true }` stubs for rows that match; the browser fills them from the cache. An
unchanged inactive session then costs ~3 KB instead of ~100 KB (est.). An older runner ignores
`have` and sends a full snapshot. Files: `shared/protocol.ts`, `runner/src/core/sessions.ts`,
`session.ts snapshot`, `sessionOps.ts`, `web/src/sessionModel.ts`. Test: unit tests both sides,
mixed-version check.

**Step 5 (optional, needs a decision): prefetch.** A `peek` op (snapshot without watching or
tailing) for the top few sidebar sessions not yet cached, on desktop or Wi-Fi only
(`navigator.connection`), staggered like resubscribes. Makes sessions never opened on this device
instant too.

**Step 6 (optional): lighter snapshots.** The runner caps closed-by-default tool output (shell,
read, search; not edits, todos or errors) at 4 KB in snapshots and pages, with `truncated`, as the
cache does. Cuts the Codex outlier from 1.77 MB to well under 200 KB (est.); small gain for Claude
(p50 103 → 99 KB, measured).

## 8. Open decisions

1. **Cache transcripts on the device at all, and on which devices.** Default on everywhere (proposed),
   or off on phones, or a setting. Proposed: on, no setting, wiped on sign-out.
2. **Wipe on every sign-out**, including a Foliation session that simply expired (the next open is
   slow once), or only when a different user signs in.
3. **Budget:** 30 sessions / 256 KB each / 8 MB / 14 days, or larger.
4. **Prefetch** never-opened sessions (step 5), and where.
5. **Typing while provisional:** Send waits for sync (proposed), or queue the send.
6. **Scroll position:** always open at the latest (proposed), or return to where you were.
7. **Inline wording:** "Loading recent messages…" (as asked) for both active and behind sessions.

## Scripts used

In `/tmp/sc-bench/` (not committed): `bench.ts` (parse and page costs per file), `dist.ts` (window
size distribution across real sessions), `e2e.ts` and `parts.ts` (`subscribe` timing and byte
breakdown through the dev relay), `ui.mjs` (time to transcript in the UI, with optional network
throttling), `flash.mjs` (what a cold load shows, in order), `idb.mjs` (IndexedDB vs localStorage
in Chromium and WebKit).
