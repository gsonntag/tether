# Archive acceptance (SPEC §10 Archiving)

## Checklist

- [x] A Recent row's archive button archives it: the row leaves Recent; the same button on a found
      row unarchives it and it comes back.
- [x] ⋯ in the session header says Archive, then Unarchive, and does the same.
- [x] In a project view, an archived row leaves the list at once (not kept, marked Archived), search
      in that view finds it, and unarchiving brings it back to the project list.
- [x] Search finds an archived session, marked "· Archived".
- [x] Home still shows an archived session that needs you or is working (working: web unit test only).
- [ ] The flag survives a runner restart and the 90-day prefs pruning.
- [x] A runner that refuses the op: from the row, the error shows under it once and goes at the next
      click or key or after a few seconds; from ⋯, it is one error notice in the chat, nothing in the menu.
- [x] All of the above at 375 px (the archive button always visible on touch).

## Fake-runner check (2026-11-02)

Desktop (1280×800) and 375 px in Chromium on a private stack (server 8917, vite 5317, two fake runners:
`ASK=1 bun scripts/fake-runner.ts fake` and `NO_ARCHIVE=1 bun scripts/fake-runner.ts old`): every
item above passed except the runner restart, which the runner's unit tests cover
(`runner/src/core/archive.test.ts`: persisted and flushed at once, kept past 90 days). Without the
Sidebar fix, the project-view rows stayed listed after archiving from the row and from ⋯.
