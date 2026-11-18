# Features from T3 Code: scope

Written 2026-11-18. T3 Code (pingdotgg/t3code, v0.1.9) is a GUI for coding agents that covers some ground
Tether doesn't. This file scopes the parts worth adopting, one PR each, in build order. Each keeps
SPEC §2: the core stays small and a feature is a module (`runner/src/modules/`) with its own ops.
The harness's store stays the transcript's only source.

| # | Feature | Branch | Base |
|---|---|---|---|
| 1 | Pinned sessions | `pin-sessions` | main |
| 2 | Diff pane with line comments | `diff-pane` | main |
| 3 | Turn checkpoints: per-turn diff and restore | `checkpoints` | `diff-pane` |
| 4 | A worktree per session, with a setup script | `session-worktrees` | main |
| 5 | Git actions: commit, push, open a PR, checks | `git-actions` | `diff-pane` |
| 6 | Fork a session (from the end or from a message) | `fork-session` | main |
| 7 | Side chats (`/btw`) | `side-chats` | `fork-session` |
| 8 | Scheduled sends | `scheduled-sends` | main |
| 9 | Usage dashboard | `usage-dashboard` | main |
| 10 | File browser | `file-browser` | `diff-pane` |

## 1. Pinned sessions

Pin a session from its sidebar row menu. Pinned sessions sit in their own group at the top of the
sidebar (above Recent), in the order you pinned them, on every device. The pin is runner state
(`runner.json`, beside names and archive), set by a `pinSession { id, pinned }` op and carried
on the session summary as `pinned`. Archiving a session unpins it. Out of scope: reordering by drag.

## 2. Diff pane with line comments

A **Changes** button in the session header opens a pane beside the transcript (a full-screen sheet
on a phone). It shows the session folder's git changes in two scopes:

- **Uncommitted:** working tree and index against `HEAD`, untracked files included.
- **Branch:** everything since the merge base with the default branch (`origin/HEAD`, else `main`
  or `master`), committed or not.

The runner's `git` module serves `gitDiff { sessionId, scope }`, which returns files (path, status, added and
removed line counts) and unified hunks, capped per file and overall (a large file shows "too large"
and its counts). Binary files show as binary. A folder that isn't a git repo says so. The pane
refreshes when a turn ends and on demand.

**Line comments:** tap a line (or drag over a range) to add a comment. Comments collect in a
review tray. **Send to agent** puts one message in the composer, which you can edit before
sending: each comment quoted with `path:line` and its lines. Comments are browser drafts
(kept in local storage per session) until sent.

## 3. Turn checkpoints

At each turn start the `checkpoints` module snapshots the session folder's working tree (tracked
and untracked, not ignored) into a commit under a hidden ref, `refs/tether/checkpoints/<session>/<n>`,
without touching the index, `HEAD` or the stash (a temporary index file and `git commit-tree`). At
the turn's end it takes another. That gives the diff pane a **Turn** scope: pick a turn and see what
it changed. **Restore files to before this turn** puts the working tree back to that snapshot (files
the turn created are removed, files it deleted come back), after first checkpointing the current state
so the restore can itself be undone. It refuses while the session is running. Refs older than 14 days,
or past the newest 200 per session, are pruned. Outside a git repo nothing is taken and the scope is
absent. Conversation rewind is #6 (fork from a message).

## 4. A worktree per session

New session gets a **Workspace** choice: *This folder* (as now) or *New worktree*. A new worktree
is made at `<repo>/../<repo>-worktrees/<slug>` on a new branch `tether/<slug>` from the default
branch. The session's folder is the worktree. If the project has `.tether/setup` (an executable) or
a `setup` command in `.tether/config.json`, the runner runs it in the worktree before the first
turn, and its output shows as a shell card. A failing setup is shown and doesn't start the turn.
Archive done (Home) already removes merged worktrees a session made. It now knows these by
recording them as the session's own.

## 5. Git actions

In the Changes pane header: the branch, its ahead/behind against its upstream, and actions:

- **Commit:** a message box, prefilled with a generated message (asked of the session's own harness
  as a one-shot side query, so no turn in the session's transcript). It refuses to commit on the
  default branch unless you confirm in the box.
- **Push:** `git push -u origin <branch>`.
- **Open PR:** `gh pr create` with a generated title and body you can edit, base the default branch.
  Needs `gh` signed in, and says so if it isn't.

Once a session has a PR, the header shows a PR chip (number, state, checks: passing, failing,
pending) that links to it. The link from session to PR is runner state, also found by branch
(`gh pr view --json`). Checks refresh every 2 minutes while the pane is open, and when a turn ends.
Out of scope: replying to review comments from Tether, GitLab or Bitbucket.

## 6. Fork a session

**Fork** in the session menu makes a new session with the same conversation, in the same folder and
on the same harness and source. Claude: the Agent SDK's resume with `forkSession`. Codex:
`thread/fork`. A message's menu gets **Fork from here**: the new session's conversation ends at that
message (Claude: `resumeSessionAt`; Codex: fork, then roll back the turns after it). The original is
never changed. This is the conversation half of T3's "edit from here"; combined with #3's restore
it gives both halves. The fork's summary records `forkedFrom` and shows it in the header.

## 7. Side chats

`/btw <question>` (or **Side chat** in the session menu) opens a side panel with a fork of the
session (#6) that runs read-only, so the main session keeps working undisturbed. It shows as a child
of the session, not in the main lists. **Bring back** sends a summary of the side chat into the main
session's queue. Closing the panel archives the side chat.

## 8. Scheduled sends

The composer's send menu gets **Send later…** with presets (in 1 hour, tonight at 9pm, tomorrow 9am)
and a custom time. A scheduled message waits in the queue with its time showing and can be edited,
sent now or cancelled like any queued message. At its time the runner sends it (or queues it behind a
running turn). It's runner state, so it survives restarts. A time that passed while the runner was
down sends on start, marked late.

## 9. Usage dashboard

**Settings → Usage**: tokens (input, output, cache read, cache write) and dollar estimates per
day, per harness and model, and per project, for the last 30 days, read from the harness stores
(Claude's JSONL `usage`, Codex's rollout `token_count`). Plan sessions show what the API would cost
(estimated) next to it, and cache savings. The runner computes it in the background and caches per
file by size and mtime, so it's cheap to open. Plan limits (5-hour and week) show at the top, from
the latest report.

## 10. File browser

A **Files** tab in the Changes pane: the session folder as a tree (respecting `.gitignore`, hidden
files behind a toggle), a filter by name, and a viewer with syntax-light text, Markdown preview and
images. Reads only, and only inside the session's folder (the runner resolves real paths and refuses
anything outside). Files over 1 MB show their size and aren't loaded. **Mention** puts `@path` in
the composer.

## Future scope (not now)

- **Desktop app** (Tauri or Electron), for the machine that also runs the runner. One download that
  installs and supervises the runner (no Bun or `runner.env` to set up), keeps the computer awake
  while agents work, native notifications and a tray showing what's running, global shortcuts, an
  in-app preview of the project's dev server, and opening files in your editor. It should be a thin
  shell around the existing web UI, not a separate client. A phone gains nothing from it.
- From T3, not planned: an in-app browser preview, replying to PR reviews, GitLab/Bitbucket/Azure
  DevOps, managed admin policy, 1Password, multiple accounts per provider.
