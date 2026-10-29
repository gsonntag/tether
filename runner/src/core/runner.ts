// The runner's core, assembled: its event bus, ops, harness facts and connection to the app.
// index.ts adds modules and process handling; tests build one against a fake server.

import { hostname } from "node:os";
import { PROTOCOL_VERSION, type HarnessInfo, type RunnerInfo } from "../../../shared/protocol";
import type { Adapter } from "./adapter";
import { RequestBroker, type PolicyStep } from "./broker";
import { EventBus } from "./bus";
import { Connection, type ConnectionOptions } from "./connection";
import type { CoreEvents } from "./events";
import { LiveControl } from "./live";
import { OpRegistry } from "./ops";
import { NoticeStore } from "./notices";
import { Prefs } from "./prefs";
import { registerSessionOps } from "./sessionOps";
import { SessionCore } from "./sessions";

export interface RunnerOptions {
  url: string;
  token: string;
  runnerId: string;
  name: string;
  version: string;
  detectHarnesses: () => Promise<HarnessInfo[]>;
  /** how often to look for installed or removed harnesses */
  harnessCheckMs?: number;
  log?: (line: string) => void;
  /** connection tuning, for tests */
  connection?: Partial<ConnectionOptions>;
  /** the harnesses this runner can drive (SPEC §6) */
  adapters?: Adapter[];
  /** where per-session settings are kept (runner.json); tests pass a temp file */
  prefsFile?: string;
  /** where Tether's own notices are kept (CONFIG_DIR/notices.json); in memory when absent */
  noticesFile?: string;
  /** the request broker's policy steps (SPEC §7); none in the core */
  policy?: PolicyStep[];
  /** session core tuning, for tests */
  core?: { discoverMs?: number; evictMs?: number; idleMs?: number };
}

export function createRunner(o: RunnerOptions) {
  const bus = new EventBus<CoreEvents>();
  const ops = new OpRegistry();
  /** this process's summary epoch (protocol.ts SummaryUpdate): a restart starts browsers' lists over */
  const epoch = crypto.randomUUID();

  ops.register("ping", () => ({ runnerId: o.runnerId, at: Date.now() }));

  let harnesses = o.detectHarnesses();
  const helloInfo = async (): Promise<Omit<RunnerInfo, "connectedAt">> => ({
    id: o.runnerId,
    name: o.name,
    hostname: hostname(),
    version: o.version,
    protocol: PROTOCOL_VERSION,
    harnesses: await harnesses,
  });

  const conn = new Connection({
    url: o.url,
    token: o.token,
    log: o.log,
    hello: helloInfo,
    onRpc: (op, args) => ops.handle(op, args),
    onDetach: () => {}, // terminals arrive in P3
    onUnwatched: (sessionIds) => bus.emit("unwatched", { sessionIds }),
    // The server forgot every route with the old connection, so after a reconnect nobody watches
    // anything until browsers subscribe again: the core stops tails on `disconnected`.
    onState: (connected) => bus.emit(connected ? "connected" : "disconnected", {}),
    ...o.connection,
  });

  const prefs = new Prefs(o.prefsFile);
  const core = new SessionCore({
    adapters: o.adapters ?? [],
    bus,
    send: (m) => conn.send(m),
    epoch,
    prefs,
    notices: o.noticesFile ? new NoticeStore(o.noticesFile) : undefined,
    log: o.log,
    discoverMs: o.core?.discoverMs,
    evictMs: o.core?.evictMs,
  });
  // Open requests are kept in runner.json, so they survive a restart (SPEC §7).
  const broker = new RequestBroker(o.policy, { saved: prefs.requests(), closed: prefs.closedRequests(), persist: (open, closed) => prefs.setRequests(open, closed), log: o.log });
  const live = new LiveControl(core, broker, { idleMs: o.core?.idleMs });
  registerSessionOps(ops, core, live);

  const timer = setInterval(async () => {
    const before = JSON.stringify(await harnesses);
    harnesses = o.detectHarnesses();
    // A repeated hello on the same connection just updates what the browsers see.
    if (JSON.stringify(await harnesses) !== before) conn.send({ t: "hello", runner: await helloInfo() });
  }, o.harnessCheckMs ?? 5 * 60_000);
  timer.unref?.();

  return {
    bus,
    ops,
    conn,
    epoch,
    core,
    live,
    harnesses: () => harnesses,
    start: () => {
      core.startDiscovery();
      void live.desk.restore();
      conn.start();
    },
    /** Closes live sessions (their harnesses flush), then the connection. */
    stop: async () => {
      clearInterval(timer);
      core.stop();
      await live.closeAll().catch(() => {});
      core.o.prefs.flush();
      conn.stop();
    },
  };
}
