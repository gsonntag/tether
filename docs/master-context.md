# Master context: shared memory and skills across harnesses

Status: scoped with the user on 2026-10-10. Not built yet.

## Goal

Every agent Tether runs (claude-code, codex, pi, opencode, kiro, antigravity) works from the same memory
about the user and their projects, and can call the same skills. Memory that any harness learns flows
into one master store automatically and back out to all the others. CLI sessions started outside
Tether benefit too.

## Decisions

| Topic | Decision |
|---|---|
| Source of truth | A git-tracked folder on the runner: `~/.config/tether/context/` (`TETHER_CONFIG_DIR/context`). Every change is a commit, so any merge can be inspected and reverted. |
| Delivery | **Both**: native sync into each harness's own files *and* a Tether MCP server (`tether-context`) for search and write-back. |
| Scope | Two layers: **global** (the user, their preferences, cross-project facts) and **per-repo** (keyed by the repo's canonical path / git remote). |
| Import | **Ongoing, auto-merge.** Watch each harness's memory sources; new entries are merged automatically by an LLM pass. |
| Conflicts | **Newest wins**, and the contradiction is surfaced: a card inline in the live session that produced it (old vs new, "Keep new" preselected, "Keep old" one click) **and** an item in the Needs-you inbox until dismissed. Routine merges go to a quiet activity feed on the Memory page. |
| Native file ownership | **Managed block + symlinks.** Tether owns only a marked block in each global memory file (or an `@import` line where supported) and never edits the user's text outside it. Skills are symlinked. |
| Per-repo delivery | **Out of repo.** Nothing is written into tracked repo files. Tether sessions get repo memory through system-prompt injection and MCP; native CLI sessions get it through out-of-repo channels (below). |
| Skills | **Unified registry.** Import skills from every harness into one library; install every skill into every harness. |
| Existing duplicate skills | **Back up, then symlink.** Originals move to `context/backup/<date>/…`; drifted copies keep the newest version and record the drift in the activity feed. |
| Merge model | One shared **background model** setting, used by both the safety judge and the memory merge. Same harness+model picker as sessions (Haiku via Claude login by default; Codex mini via ChatGPT login, any pi provider, …). |

## Store layout

```
~/.config/tether/context/            git repo
  memory/
    global/<slug>.md                 one fact per file
    repos/<repo-key>/<slug>.md
  skills/<name>/SKILL.md             (+ any supporting files)
  sources.json                       watermark per import source (path → mtime/hash/sqlite rowid)
  activity.jsonl                     merge/import/conflict feed
  backup/<date>/…                    originals replaced by symlinks
```

Memory file format: Claude's auto-memory format (the richest one in use, ~71 entries today) plus scope
and provenance:

```markdown
---
name: kebab-slug
description: one line, used for relevance
type: user | feedback | project | reference
scope: global | repo:<repo-key>
sources: [claude:~/.claude/projects/-home-ubuntu-foliation/memory/x.md, codex:memories#42]
updated: 2026-10-10T12:00:00Z
---
body; `[[other-slug]]` links
```

`repo-key`: normalized git remote URL if present, else the absolute repo root path. Worktrees of the same
repo (e.g. `foliation-wt/*`) map to the same key.

## Import sources (watched)

| Harness | Source | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/*/memory/*.md` (+ `MEMORY.md` index), `~/.claude/CLAUDE.md` outside the managed block | Project dir name → repo-key. `-home-ubuntu` → global. |
| Codex | `~/.codex/memories/`, `~/.codex/memories_1.sqlite`, `~/.codex/AGENTS.md` outside block | Read sqlite read-only. |
| pi | `~/.pi/agent/AGENTS.md` outside block | |
| opencode | `~/.config/opencode/AGENTS.md` outside block | |
| Kiro | `~/.kiro/steering/*.md` (not Tether's) | |
| Antigravity/Gemini | `~/.gemini/GEMINI.md` outside block, `~/.gemini/antigravity/knowledge/` | |
| Tether MCP | `memory_write` calls from any agent | Goes through the same merge pass. |

Per-repo `CLAUDE.md`/`AGENTS.md` files are **read** as repo context for search but not imported as
memory (they are the repo's own docs, not agent memory).

Skill sources: `~/.claude/skills/*` (skip `synced/`: claude.ai-owned, index read-only), `~/.codex/skills/*`
(skip `.system/`), `~/.pi/agent/skills`, `~/.gemini/skills`, `~/.gemini/antigravity/skills` (skip builtins),
`~/.config/opencode/skills`, repo `.claude/skills` / `.agents/skills` (as repo-scoped skills, left in place).

## Merge pass

Triggered by a watcher (debounced) or an MCP write. For each new/changed source entry:
1. Retrieve candidate existing memories in the same scope (by name/description similarity).
2. Background model returns one of: `new`, `duplicate-of <slug>`, `update <slug>` (rewritten body),
   `contradicts <slug>` (newest wins → rewritten body + both claims recorded), and the scope
   (global vs repo) if the source was ambiguous.
3. Write files, commit with a descriptive message, append to `activity.jsonl`.
4. On `contradicts`: emit a conflict event (session id if the source was a Tether session) → inline card +
   Needs-you inbox item. "Keep old" reverts that entry's commit.
5. Re-export to all harnesses (below). Exports are tagged so the watcher ignores Tether's own writes
   (no loops).

## Export (native sync)

Global memory digest (compact: user/feedback entries in full, project/reference as one-line index):
- Claude: managed block in `~/.claude/CLAUDE.md` containing `@~/.config/tether/context/exports/global.md`.
- Gemini/Antigravity: same with `@import` in `~/.gemini/GEMINI.md`.
- Codex, pi, opencode: managed block in their global `AGENTS.md` with the digest inlined (no imports).
- Kiro: `~/.kiro/steering/tether.md` (Tether-owned file, `inclusion: always`).

Managed block markers: `<!-- tether:begin (managed, edits here are overwritten) -->` … `<!-- tether:end -->`.

Per-repo memory, out of repo:
- Tether sessions: appended to the system prompt at session start (claude `systemPrompt.append`,
  pi `--append-system-prompt`, codex `developerInstructions`, ACP/agy via first-message preamble), plus MCP.
- Native Claude CLI: written into Claude's own per-project memory dir as a Tether-owned file
  (`~/.claude/projects/<dir>/memory/tether.md` + index line), which Claude loads automatically.
- Other native CLIs: MCP only (registered globally in each harness's MCP config).

Skills: canonical copy in `context/skills/`; symlinked into `~/.claude/skills/`, `~/.agents/skills/`
(covers Codex, pi, opencode), `~/.gemini/antigravity/skills/`, `~/.gemini/skills/`. Name collisions with
harness builtins: the builtin wins, and the registry copy is exposed as `<name>-tether`.

## Handoffs (runner/src/context/handoff.ts)

When a fallback chain moves a conversation to another harness, and the context is enabled:
- **Capture**: the background model extracts 0-3 durable facts from the outgoing transcript since
  the last capture (watermark `handoff-capture:<session>` in `sources.json`, debounced 2 min). The
  handoff waits at most 8 s; a late answer is still filed. Facts become inbox notes
  (`via: handoff`, provenance `handoff:<session>#<hash>`) for the normal merge pass, filed only
  after the new session has started so its injection can't already contain them.
  `context.handoffCapture: false` in runner.json turns this off.
  Runner-wide, one extraction runs at a time and a failure or timeout pauses capturing for 5 min, so
  a usage-limit storm costs at most one background call (and one 8 s wait). An earlier handoff's
  brief (shown as a user message by some harnesses) is never sent again or used for relevance.
  Credentials: the transcript is redacted before it's sent (keys, tokens, `NAME=secret`, URLs with
  passwords, private keys), the prompt forbids them and any fact that still matches is dropped. The
  transcript goes in a `<transcript>` data block the prompt says not to take instructions from, and
  only user/feedback facts can be global.
- **Carry**: the brief gets a `## Memory` section: captured facts, memories relevant to the last user
  messages and the pending prompt, global user/feedback entries, then this repo's entries, within
  ~1500 tokens (overflow becomes index lines). Anything the new harness's native injection already
  shows in full is left out.
- The new session's handoff notice lists what was carried (collapsed).

## MCP server `tether-context`

Served by the runner (stdio launcher script so any harness can spawn it, talking to the runner's local
socket). Registered for Tether sessions per adapter (Claude SDK `mcpServers`, ACP `newSession.mcpServers`,
codex config override, pi via `pi-mcp-adapter`) and globally in each harness's MCP config for native
CLI use.

`~/.claude.json` and opencode's `opencode.json(c)` are registered only by the user's Import (never by
a background re-export) and are edited in place with jsonc-parser: only the `tether-context` key
changes, comments and formatting stay. `~/.claude.json` is rewritten constantly by every running
Claude Code process, so the edit (runner/src/context/globalMcp.ts) takes Claude's own lock
(`~/.claude.json.lock`, proper-lockfile style, stale after 10s), re-reads and compares the file right
before the atomic rename, reads it back afterwards, and redoes the edit on the new text if anything
moved. Residual risk: a writer that ignores the lock and lands in the microseconds between the final
compare and the rename loses that one write (nothing can detect it afterwards). This happens once,
on Import or Turn off, never in the background. Turning off removes the entry in place (never a
snapshot restore, which would roll back Claude's own state).

Tools: `memory_search(query, scope?)`, `memory_get(slug)`, `memory_write(text, type?, scope?)`,
`skill_list()`, `skill_get(name)`. All `mcp__tether-context__*` calls auto-allow in the guard
(read/write limited to the context store).

## UI

- **Memory & Skills page** (sidebar entry), one page: a status line ("Shared memory is off" with a
  plain explanation, "Turn on shared memory" and a "See exactly what will change" disclosure with
  the import's dry run; a progress bar while turning on; "Shared memory is on · N memories · N
  skills" + "Turn off"), open conflicts at the top (old vs new, Keep new / Keep old), one
  searchable memory list grouped Global / per repo (a row opens view/edit/delete and a History
  disclosure in a side panel, full screen on phones), and the skills with on/off switches, source
  harness badges and drift as a tooltip. The activity log stays on the runner (`activity.jsonl`)
  but isn't shown.
- **Inline conflict card** in session transcript; **Needs-you** inbox item for conflicts.
- **Push notification** (kind `memory`, runner/src/notify.ts) for the conflicts a sync pass leaves
  open, batched per pass and throttled to one a minute; deep link `#/r/<runner>/memory?conflict=<id>`.
- **Settings → Background model** (shared with the safety judge).

## Open risks

- Claude auto-memory dirs are keyed by cwd. Mapping worktree dirs to one repo-key needs `git rev-parse
  --git-common-dir`; dirs that no longer exist fall back to the path.
- Codex memories sqlite schema is undocumented; importer must be defensive and read-only.
- Digest size: keep the global export under ~4 KB; the rest is reachable via MCP search.
- The background model spends the user's plan quota; merges are batched and debounced.
