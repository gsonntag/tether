#!/bin/sh
# Checks that a Codex daemon the runner starts survives stopping the runner under systemd with
# KillMode=mixed (the production unit): adapters/codex/daemon.ts must start it outside the runner's
# cgroup. Uses a THROWAWAY daemon (its own CODEX_HOME and socket) and a transient unit; the user's
# own daemon is never touched. NO_SCOPE=1 runs the negative check (no scope: the daemon must die).
set -e
HOME_DIR=$(mktemp -d "${HOME}/.cache/tether-codex-scope-XXXXXX")
UNIT=tether-codex-scope-check-$$
cd "$(dirname "$0")/../runner"
cleanup() {
  CODEX_HOME="$HOME_DIR" codex app-server daemon stop >/dev/null 2>&1 || true
  pkill -f "$HOME_DIR/packages/app-server-daemon" 2>/dev/null || true
  systemctl --user stop $UNIT 2>/dev/null || true
  rm -rf "${HOME_DIR:?}"
}
trap cleanup EXIT
systemd-run --user --quiet --unit=$UNIT -p KillMode=mixed -p WorkingDirectory="$PWD" \
  --setenv=PATH="$PATH" --setenv=HOME="$HOME" --setenv=CODEX_HOME="$HOME_DIR" "$(command -v bun)" scripts/codex-daemon-scope-probe.ts ${NO_SCOPE:+--no-scope}
SOCK="$HOME_DIR/app-server-control/app-server-control.sock"
for i in $(seq 1 240); do [ -S "$SOCK" ] && break; sleep 0.25; done
[ -S "$SOCK" ] || { echo "FAIL: the probe never started a daemon"; journalctl --user -u $UNIT --no-pager | tail; exit 1; }
sleep 2
systemctl --user stop $UNIT
sleep 2
if CODEX_HOME="$HOME_DIR" codex app-server daemon version 2>/dev/null | grep -q '"status":"running"'; then
  [ -n "$NO_SCOPE" ] && { echo "FAIL (negative check): without the scope the daemon still survived, so this check proves nothing"; exit 1; }
  echo "ok  the daemon the runner started survived stopping a KillMode=mixed unit"
else
  [ -n "$NO_SCOPE" ] && { echo "ok  (negative check) started without the scope, the daemon died with the unit"; exit 0; }
  echo "FAIL: stopping the unit killed the daemon"; exit 1
fi
