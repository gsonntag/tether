// Connections to Codex's shared app-server daemon (SPEC §6). Each live thread gets a connection of
// its own (its notifications and requests are its own); discovery and history share one more,
// made on first use and made again after it drops. If the daemon isn't running, Tether starts it
// (`codex app-server daemon start`) once and tries again; it never stops or restarts it.

import { existsSync } from "node:fs";
import { HARNESS_BINS } from "../detect";
import { CodexRpc, DAEMON_SOCKET } from "./rpc";

const NOT_RUNNING = /isn't running/;

let starting: Promise<void> | undefined;

/** Starts the daemon when its socket isn't there (at most one start at a time). */
async function startDaemon(): Promise<void> {
  starting ??= (async () => {
    try {
      const p = Bun.spawn([HARNESS_BINS.codex, "app-server", "daemon", "start"], { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
      const timer = setTimeout(() => p.kill(), 30_000);
      const code = await p.exited;
      clearTimeout(timer);
      if (code !== 0) throw new Error(`\`codex app-server daemon start\` failed: ${(await new Response(p.stderr).text()).trim().split("\n").slice(-2).join(" ")}`);
    } finally {
      setTimeout(() => (starting = undefined), 10_000).unref?.();
    }
  })();
  return starting;
}

/** Tests replace how connections are made (a scripted daemon instead of the real one). */
let connector: ((name: string) => Promise<CodexRpc>) | undefined;
export function setConnector(f: ((name: string) => Promise<CodexRpc>) | undefined) {
  connector = f;
  resetShared();
}

/** A new connection to the daemon, starting it first if it isn't running. */
export async function connect(name = "tether"): Promise<CodexRpc> {
  if (connector) return connector(name);
  try {
    return await CodexRpc.connect(name);
  } catch (e: any) {
    if (!NOT_RUNNING.test(String(e?.message)) || process.env.CODEX_DAEMON_SOCKET) throw e;
    await startDaemon();
    for (let i = 0; i < 20 && !existsSync(DAEMON_SOCKET); i++) await Bun.sleep(250);
    return CodexRpc.connect(name);
  }
}

let shared: Promise<CodexRpc> | undefined;

/** The connection discovery and history share. */
export function sharedRpc(): Promise<CodexRpc> {
  if (!shared) {
    const p = connect("tether-catalog");
    shared = p;
    p.then(
      (rpc) => rpc.onClose(() => shared === p && (shared = undefined)),
      () => shared === p && (shared = undefined),
    );
  }
  return shared;
}

/** A call on the shared connection (once more on a fresh connection if it had dropped). */
export async function call<T = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
  const rpc = await sharedRpc();
  try {
    return await rpc.call<T>(method, params, timeoutMs);
  } catch (e) {
    if (!rpc.closed) throw e;
    return (await sharedRpc()).call<T>(method, params, timeoutMs);
  }
}

/** Tests: drop the shared connection. */
export function resetShared() {
  void shared?.then((r) => r.close(), () => {});
  shared = undefined;
}
