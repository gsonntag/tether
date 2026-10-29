// Starts a tmux session the way the runner does (terminal/tmux.ts, with the systemd scope wrap)
// and stays up. scripts/check-tmux-scope.sh runs it inside a KillMode=mixed unit and stops the unit.
import { systemdScopeWrap, Tmux } from "../src/terminal/tmux";

const socket = process.argv[2] ?? "tether-scope-check";
const wrap = systemdScopeWrap(socket);
console.log(wrap ? "under systemd: the tmux server starts in its own scope" : "not under systemd: plain tmux");
await new Tmux({ socket, wrapStart: wrap }).create({ name: "sh-check-1", cwd: process.env.HOME ?? "/", argv: ["sleep", "600"], tags: { kind: "shell", project: "/", n: "1" } });
console.log("tmux session started");
setInterval(() => {}, 60_000);
