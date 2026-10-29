#!/bin/sh
# Checks that terminals survive stopping a runner under systemd with KillMode=mixed (the production
# unit): the runner must start the tmux server outside its own cgroup (terminal/tmux.ts,
# systemdScopeWrap). Uses a transient user unit and a tmux socket of its own; touches nothing else.
set -e
SOCK=tether-scope-check-$$
UNIT=tether-scope-check-$$
cd "$(dirname "$0")/../runner"
systemd-run --user --quiet --unit=$UNIT -p KillMode=mixed -p WorkingDirectory="$PWD" \
  --setenv=PATH="$PATH" --setenv=HOME="$HOME" "$(command -v bun)" scripts/tmux-scope-probe.ts $SOCK
for i in $(seq 1 40); do tmux -L $SOCK has-session -t =sh-check-1 2>/dev/null && break; sleep 0.25; done
tmux -L $SOCK has-session -t =sh-check-1 || { echo "FAIL: the probe never started its tmux session"; journalctl --user -u $UNIT --no-pager | tail; exit 1; }
systemctl --user stop $UNIT
sleep 1
if tmux -L $SOCK has-session -t =sh-check-1 2>/dev/null; then
  echo "ok  the tmux session survived stopping a KillMode=mixed unit"
  tmux -L $SOCK kill-server
else
  echo "FAIL: stopping the unit killed the tmux server"; exit 1
fi

# The race from P3 review 2: the last session ends just as the next starts. The server must never
# be started by new-session (inside the unit) instead of by the scope-wrapped start-server.
RACE=tether-scope-race-$$
systemd-run --user --quiet --wait --unit=$RACE -p KillMode=mixed -p WorkingDirectory="$PWD" \
  --setenv=PATH="$PATH" --setenv=HOME="$HOME" "$(command -v bun)" scripts/tmux-scope-probe.ts $RACE race ${N:-30} >/dev/null 2>&1 \
  && echo "ok  ${N:-30} racing starts: every tmux server was outside the unit" \
  || { echo "FAIL: a tmux server started inside the unit:"; journalctl --user -u $RACE --no-pager -o cat | grep race; exit 1; }
