#!/bin/sh
# Checks that a new Codex session makes the app-server write no folder trust into config.toml
# (P4.md, Folder trust): a PRIVATE app-server of the user's daemon version, with its own CODEX_HOME
# and socket. The user's daemon and config are never touched. Needs no sign-in: nothing runs a turn.
set -e
HOME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tether-codex-trust-XXXXXX")
SOCK="$HOME_DIR/app-server.sock"
BIN="$HOME/.codex/packages/app-server-daemon/current/bin/codex"
[ -x "$BIN" ] || BIN=$(command -v codex)
cd "$(dirname "$0")/../runner"
PID=
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  [ -n "$PID" ] && wait "$PID" 2>/dev/null || true
  rm -rf "${HOME_DIR:?}" 2>/dev/null || true
}
trap cleanup EXIT
: > "$HOME_DIR/config.toml"
CODEX_HOME="$HOME_DIR" "$BIN" app-server --listen "unix://$SOCK" > "$HOME_DIR/server.log" 2>&1 &
PID=$!
for i in $(seq 1 120); do [ -S "$SOCK" ] && break; sleep 0.25; done
[ -S "$SOCK" ] || { echo "FAIL: the private app-server never opened its socket"; tail -5 "$HOME_DIR/server.log"; exit 1; }
CODEX_HOME="$HOME_DIR" CODEX_DAEMON_SOCKET="$SOCK" TETHER_CONFIG_DIR="$HOME_DIR/tether" NODE_ENV=test bun scripts/codex-trust-probe.ts "$HOME_DIR"
