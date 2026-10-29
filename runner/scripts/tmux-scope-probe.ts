// Starts tmux sessions the way the runner does (terminal/tmux.ts, with the systemd scope wrap).
// scripts/check-tmux-scope.sh runs it inside a KillMode=mixed unit:
//   bun scripts/tmux-scope-probe.ts <socket>          one session, then stays up (the unit is stopped)
//   bun scripts/tmux-scope-probe.ts <socket> race N   the race from P3 review 2: the last session
//     ends while the next one starts, N times; prints how often the server landed in this unit's cgroup
import { readFileSync } from "node:fs";
import { systemdScopeWrap, Tmux } from "../src/terminal/tmux";

const socket = process.argv[2] ?? "tether-scope-check";
const wrap = systemdScopeWrap(socket);
console.log(wrap ? "under systemd: the tmux server starts in its own scope" : "not under systemd: plain tmux");
const shell = (n: number) => ({ name: `sh-check-${n}`, cwd: process.env.HOME ?? "/", argv: ["sleep", "600"], tags: { kind: "shell", project: "/", n: String(n) } });

if (process.argv[3] === "race") {
  const mine = readFileSync("/proc/self/cgroup", "utf8").trim();
  let bad = 0;
  const n = Number(process.argv[4] ?? 30);
  for (let i = 0; i < n; i++) {
    const t = new Tmux({ socket, wrapStart: wrap });
    await t.killServer();
    await t.create(shell(1));
    const next = t.create(shell(2));
    await Bun.sleep(i % 15);
    Bun.spawnSync(t.argv("kill-session", "-t", "=sh-check-1"));
    await next;
    const pid = Bun.spawnSync(t.argv("display", "-p", "#{pid}")).stdout.toString().trim();
    const cg = pid ? readFileSync(`/proc/${pid}/cgroup`, "utf8").trim() : "no server";
    if (cg === mine) bad++;
  }
  await new Tmux({ socket }).killServer();
  console.log(`race: ${bad} of ${n} servers in the runner's own cgroup`);
  process.exit(bad ? 1 : 0);
}

await new Tmux({ socket, wrapStart: wrap }).create(shell(1));
console.log("tmux session started");
setInterval(() => {}, 60_000);
