// The runner's core, assembled: its event bus, ops, harness facts and connection to the app.
// index.ts adds modules and process handling; tests build one against a fake server.

import { hostname } from "node:os";
import { PROTOCOL_VERSION, type HarnessInfo, type RunnerInfo } from "../../../shared/protocol";
import { EventBus } from "./bus";
import { Connection, type ConnectionOptions } from "./connection";
import type { CoreEvents } from "./events";
import { OpRegistry } from "./ops";

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
    harnesses: () => harnesses,
    start: () => conn.start(),
    stop: () => {
      clearInterval(timer);
      conn.stop();
    },
  };
}
