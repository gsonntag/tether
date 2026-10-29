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
