// Exercises Bun's PTY support end to end: a shell, input, output, resize (with SIGWINCH), Ctrl-C,
// throughput, a tmux attach on a private socket, and exit. `bun scripts/pty-probe.ts`
// Findings: docs/notes/pty.md.

import { spawnPty } from "../src/terminal/pty";

const dec = new TextDecoder();
let out = "";
const pty = spawnPty(["bash", "--norc", "--noprofile", "-i"], {
  cols: 80,
  rows: 24,
  env: { ...process.env, PS1: "$ " },
  onData: (b) => (out += dec.decode(b, { stream: true })),
});

async function until(pattern: RegExp, ms = 5000): Promise<number> {
  const t0 = performance.now();
  while (!pattern.test(out)) {
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${pattern}; got:\n${JSON.stringify(out.slice(-400))}`);
    await Bun.sleep(5);
  }
  return Math.round(performance.now() - t0);
}

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) process.exitCode = 1;
}

await until(/\$ $/);
pty.write("echo hello-$((40+2))\r");
check("input and output", (await until(/hello-42/)) >= 0);

pty.write("tty; stty size\r");
await until(/24 80/);
check("is a real tty at 80x24", /\/dev\/pts\/\d+/.test(out));

pty.write("trap 'echo WINCH:$COLUMNS' WINCH\r");
await Bun.sleep(100);
pty.resize(132, 40);
pty.write("stty size\r");
await until(/40 132/);
check("resize reaches the kernel", true);
check("resize sends SIGWINCH", /WINCH:132/.test(out));

out = "";
pty.write("sleep 30\r");
await Bun.sleep(200);
pty.write("\x03");
pty.write("echo after-ctrl-c\r");
check("Ctrl-C interrupts the foreground job", (await until(/after-ctrl-c\r?\n/)) < 2000);

out = "";
const t0 = performance.now();
pty.write("head -c 4000000 /dev/zero | base64 -w 100; echo DONE-$((1+1))BIG\r");
await until(/DONE-2BIG\r?\n/, 20000);
const ms = performance.now() - t0;
check("throughput", true, `${(out.length / 1e6).toFixed(1)} MB in ${Math.round(ms)} ms`);

// tmux on its own socket, so nothing touches a real tmux server.
const sock = `tether-pty-probe-${process.pid}`;
const tmux = (...a: string[]) => Bun.spawnSync(["tmux", "-L", sock, ...a]);
tmux("-f", "/dev/null", "new-session", "-d", "-s", "probe", "-x", "100", "-y", "30", "bash --norc --noprofile");
tmux("set-option", "-g", "window-size", "latest");
let tout = "";
const att = spawnPty(["tmux", "-L", sock, "attach", "-t", "probe"], { cols: 90, rows: 25, onData: (b) => (tout += dec.decode(b, { stream: true })) });
await Bun.sleep(500);
tmux("send-keys", "-t", "probe", "-l", "echo from-send-keys");
tmux("send-keys", "-t", "probe", "Enter");
const t1 = performance.now();
while (!/from-send-keys/.test(tout) && performance.now() - t1 < 5000) await Bun.sleep(10);
check("tmux attach inside the PTY mirrors the pane", /from-send-keys/.test(tout));
att.resize(70, 20);
await Bun.sleep(300);
const size = dec.decode(tmux("display", "-p", "-t", "probe", "#{window_width}x#{window_height}").stdout).trim();
check("resizing the attach resizes the tmux window", size === "70x19" || size === "70x20", size);
att.close();
const code = await att.exited;
const alive = tmux("has-session", "-t", "probe").exitCode === 0;
check("closing the attach leaves the tmux session running", alive, `attach exit ${code}`);
tmux("kill-server");

pty.write("exit 3\r");
const exit = await pty.exited;
check("exit code comes back", exit === 3, String(exit));

const killed = spawnPty(["sleep", "30"], { onData: () => {} });
killed.close();
check("close() ends the process", (await killed.exited) === null);
