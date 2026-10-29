// How much a runaway `!` command costs the runner: `yes` for 5 s through ShellRuns (fake harness),
// with a subscriber watching. Prints the runner's CPU time, event-loop lag and what went out.
//   bun scripts/bench-shell.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { RequestBroker } from "../src/core/broker";
import { EventBus } from "../src/core/bus";
import type { CoreEvents } from "../src/core/events";
import { FakeAdapter } from "../src/core/fakeAdapter";
import { LiveControl } from "../src/core/live";
import { Prefs } from "../src/core/prefs";
import { SessionCore } from "../src/core/sessions";
import { ShellRuns } from "../src/core/shellRuns";

const dir = mkdtempSync(join(tmpdir(), "tether-bench-"));
saveConfig({ runnerId: "bench" }, join(dir, "runner.json"));
const adapter = new FakeAdapter();
adapter.addStored("s1", [], { projectPath: dir });
let frames = 0;
let bytes = 0;
const core = new SessionCore({ adapters: [adapter], bus: new EventBus<CoreEvents>(), send: (m) => (frames++, (bytes += JSON.stringify(m).length), true), epoch: "e", prefs: new Prefs(join(dir, "runner.json"), 0), log: () => {} });
const live = new LiveControl(core, new RequestBroker(), {});
const runs = new ShellRuns(core, live, { shell: "/bin/sh" });
await core.subscribe("claude:s1");
let lag = 0;
let last = performance.now();
const tick = setInterval(() => {
  const now = performance.now();
  lag = Math.max(lag, now - last - 50);
  last = now;
}, 50);
const cpu0 = process.cpuUsage();
const { id } = await runs.run("claude:s1", "yes RUNAWAY-LINE");
await Bun.sleep(5000);
const cpu = process.cpuUsage(cpu0);
const total = (runs as any).runs.get(id)?.buf.total;
runs.stop("claude:s1", id);
console.log(`read ${(total / 1048576).toFixed(0)} MB`);
clearInterval(tick);
console.log(`cpu ${((cpu.user + cpu.system) / 1000 / 5000 * 100).toFixed(0)}% of a core, worst event-loop lag ${lag.toFixed(0)} ms, ${frames} frames, ${(bytes / 1024).toFixed(0)} KB sent`);
await Bun.sleep(3000);
process.exit(0);
