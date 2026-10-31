// For scripts/check-codex-folder-trust.sh: run against its private app-server, never the user's.
// New sessions in a git repository, Auto and Full access, leave config.toml as it was and hold their
// mode. Then the control: a thread/start asking for a writable sandbox must make the app-server write
// the trust, or this check proves nothing.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexDriver, createThread } from "../src/adapters/codex/driver";
import { connect, resetShared } from "../src/adapters/codex/daemon";
import { CODEX_HOME } from "../src/adapters/codex/rpc";
import { TestSink } from "../src/adapters/codex/testSink";

const home = process.argv[2]!;
if (CODEX_HOME !== home || !process.env.CODEX_DAEMON_SOCKET?.startsWith(home)) throw new Error("this runs against a private CODEX_HOME only");
const config = join(home, "config.toml");
const repo = (name: string) => {
  const d = join(home, name);
  mkdirSync(d);
  spawnSync("git", ["init", "-q"], { cwd: d });
  return d;
};
const fail = (m: string): never => {
  console.log(`FAIL: ${m}`);
  process.exit(1);
};
const before = readFileSync(config, "utf8");
for (const mode of ["auto", "full-access"]) {
  const dir = repo(`new-${mode}`);
  const opts = { permissionMode: mode };
  const id = await createThread(dir, opts);
  const sink = new TestSink();
  const d = await CodexDriver.open(id, dir, opts, sink, false);
  if (sink.states.at(-1)?.permissionMode !== mode && !sink.states.some((s) => s.permissionMode === mode)) fail(`a new ${mode} session doesn't hold its mode`);
  await d.close();
  if (readFileSync(config, "utf8") !== before) fail(`a new ${mode} session changed config.toml:\n${readFileSync(config, "utf8")}`);
}
console.log("ok  new sessions (Auto, Full access) in a git repository hold their mode and leave config.toml unchanged");
const control = repo("control");
const rpc = await connect("tether-trust-control");
await rpc.call("thread/start", { cwd: control, sandbox: "workspace-write", approvalPolicy: "on-request" });
await Bun.sleep(500);
rpc.close();
if (!readFileSync(config, "utf8").includes(control)) fail("the control: a writable thread/start didn't write the trust, so this check proves nothing on this Codex");
console.log("ok  the control: thread/start with a writable sandbox does write the trust");
resetShared();
process.exit(0);
