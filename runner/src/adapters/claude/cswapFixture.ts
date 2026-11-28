// A fake `cswap` for tests: `list --json` prints a fixture; `run <n> --share-history -- <args>`
// makes a private profile under the fixture root (its `projects` linked to the shared Claude dir
// unless FAKE_CSWAP_NO_SHARE is set) and runs `claude` from PATH in it, like the real one.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeRow {
  number: number; email: string; organizationName?: string; organizationUuid?: string;
  active?: boolean; usageStatus?: string; alias?: string;
}

export function fakeCswap(base = "/tmp/claude-1001/cswap/unit") {
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "fixture-"));
  const shared = join(root, "dot-claude");
  mkdirSync(join(shared, "projects"), { recursive: true, mode: 0o700 });
  const bin = join(root, "cswap");
  const list = join(root, "list.json");
  const log = join(root, "calls.log");
  const profiles = join(root, "sessions");
  writeFileSync(bin, `#!/bin/sh
echo "$*" >> '${log}'
[ -n "$FAKE_CSWAP_BROKEN" ] && { echo "$FAKE_CSWAP_BROKEN"; exit "\${FAKE_CSWAP_CODE:-0}"; }
if [ "$1" = list ]; then cat '${list}'; exit 0; fi
if [ "$1" = run ]; then
  n="$2"; shift 2
  [ "$1" = --share-history ] || exit 9
  shift; [ "$1" = -- ] && shift
  active=$(grep -o "\\"number\\": *$n,[^}]*\\"active\\": *true" '${list}')
  if [ -n "$active" ]; then unset CLAUDE_CONFIG_DIR; exec claude "$@"; fi
  dir='${profiles}'/"$n-profile"
  mkdir -p "$dir"; chmod 700 '${profiles}' "$dir"
  [ -n "$FAKE_CSWAP_NO_SHARE" ] || [ -e "$dir/projects" ] || ln -s '${shared}/projects' "$dir/projects"
  CLAUDE_CONFIG_DIR="$dir" exec claude "$@"
fi
exit 2
`);
  chmodSync(bin, 0o700);
  const write = (rows: FakeRow[]) => writeFileSync(list, JSON.stringify({
    schemaVersion: 1, activeAccountNumber: rows.find((r) => r.active)?.number ?? null,
    accounts: rows.map((r) => ({ organizationName: `${r.email}'s Organization`, organizationUuid: `org-${r.email}`, active: false, usageStatus: "ok", usage: null, ...r })),
  }, null, 1));
  write([]);
  return { root, bin, shared, log, profiles, write, profile: (n: number) => join(profiles, `${n}-profile`) };
}
