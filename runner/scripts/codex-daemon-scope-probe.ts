// Starts a Codex daemon the way the runner does when none runs (adapters/codex/daemon.ts, with the
// systemd scope wrap) and stays up. scripts/check-codex-daemon-scope.sh runs it inside a
// KillMode=mixed unit, with CODEX_HOME pointing at a throwaway folder, and stops the unit.
import { connect } from "../src/adapters/codex/daemon";
import { DAEMON_SOCKET } from "../src/adapters/codex/rpc";

// The negative check (NO_SCOPE=1 in the script): started plainly, it must die with the unit.
if (process.argv.includes("--no-scope")) delete process.env.INVOCATION_ID;
if (!process.env.CODEX_HOME) throw new Error("set CODEX_HOME to a throwaway folder: never the user's own");
console.log(`connecting to ${DAEMON_SOCKET} (starting the daemon if needed)`);
const rpc = await connect("tether-scope-probe");
console.log("connected");
await rpc.call("model/list", {}).catch(() => {});
setInterval(() => {}, 60_000);
