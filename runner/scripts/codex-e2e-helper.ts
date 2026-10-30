// For scripts/e2e-p4.mjs: talks to the Codex daemon directly, as another client would.
//   bun scripts/codex-e2e-helper.ts make <folder> <model>   a thread with one short turn, read-only sandbox, Low; prints its id
//   bun scripts/codex-e2e-helper.ts settings <thread id>     its settings as its rollout last recorded them (JSON)
//   bun scripts/codex-e2e-helper.ts hold <thread id> <ms>    keeps the thread loaded from another client (as Codex's TUI would)
//   bun scripts/codex-e2e-helper.ts set <thread id> <json>     changes its settings from another client
//   bun scripts/codex-e2e-helper.ts turn <thread id> <prompt>  starts a turn from another client (as Codex's TUI would) and waits for it
// `make` takes a sandbox as a 4th argument (default read-only).
import { connect, resetShared } from "../src/adapters/codex/daemon";
import { readThread, rolloutSettings } from "../src/adapters/codex/discovery";

const [cmd, a, b] = process.argv.slice(2);
if (cmd === "make") {
  const rpc = await connect("tether-e2e-helper");
  const st = await rpc.call("thread/start", { cwd: a, model: b, approvalPolicy: "on-request", sandbox: process.argv[5] ?? "read-only", approvalsReviewer: "user" });
  const id = st.thread.id;
  let done = false;
  rpc.onNotify((m, p) => m === "turn/completed" && p.threadId === id && (done = true));
  await rpc.call("turn/start", { threadId: id, effort: "low", input: [{ type: "text", text: "Reply with just: MADE-ELSEWHERE", text_elements: [] }] });
  for (let i = 0; i < 240 && !done; i++) await Bun.sleep(250);
  rpc.close();
  console.log(id);
} else if (cmd === "turn") {
  const rpc = await connect("tether-e2e-other");
  let done = false;
  rpc.onNotify((m, p) => m === "turn/completed" && p.threadId === a && (done = true));
  await rpc.call("thread/resume", { threadId: a, excludeTurns: true });
  await rpc.call("turn/start", { threadId: a, input: [{ type: "text", text: b, text_elements: [] }] });
  console.log("started");
  for (let i = 0; i < 720 && !done; i++) await Bun.sleep(250);
  await Bun.sleep(1500);
  rpc.close();
} else if (cmd === "set") {
  // thread/settings/update from another client (as Codex's TUI would): `set <thread id> <json>`
  const rpc = await connect("tether-e2e-other");
  await rpc.call("thread/resume", { threadId: a, excludeTurns: true });
  await rpc.call("thread/settings/update", { threadId: a, ...JSON.parse(b!) });
  await Bun.sleep(1500);
  rpc.close();
} else if (cmd === "hold") {
  const rpc = await connect("tether-e2e-holder");
  await rpc.call("thread/resume", { threadId: a, excludeTurns: true });
  console.log("holding");
  await Bun.sleep(Number(b ?? 60_000));
  rpc.close();
} else if (cmd === "settings") {
  const t = await readThread(a!);
  console.log(JSON.stringify(rolloutSettings(await Bun.file(t.path).text())));
}
resetShared();
process.exit(0);
