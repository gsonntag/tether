// The session ops browsers call (shared/protocol.ts Ops), wired to the core. Arguments come off
// the wire: each handler checks what it reads.

import type { HarnessId } from "../../../shared/transcript";
import type { LiveControl } from "./live";
import type { OpRegistry } from "./ops";
import type { SessionCore } from "./sessions";

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`${what} is required.`);
  return v;
};
const optStr = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const optNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const harness = (v: unknown): HarnessId => (v === "codex" ? "codex" : v === "claude" || v === undefined ? "claude" : (str(undefined, "A known harness") as never));

export function registerSessionOps(ops: OpRegistry, core: SessionCore, live: LiveControl) {
  ops.register("listProjects", async () => ({ projects: await core.listProjects() }));
  ops.register("listSessions", (a) =>
    core.listSessions({ projectPath: optStr(a.projectPath), parentSessionId: optStr(a.parentSessionId), query: optStr(a.query), limit: optNum(a.limit) }),
  );
  ops.register("subscribe", (a) => core.subscribe(str(a.sessionId, "sessionId"), optNum(a.limit)));
  ops.register("history", async (a) => core.history(await core.open(str(a.sessionId, "sessionId")), str(a.before, "before"), optNum(a.limit)));
  ops.register("fullPart", async (a) => core.fullPart(await core.open(str(a.sessionId, "sessionId")), str(a.msgId, "msgId"), optNum(a.part) ?? -1, optNum(a.offset)));
  ops.register("listModels", (a) => live.listModels(harness(a.harness), optStr(a.sessionId)));
  ops.register("newSession", (a) =>
    live.newSession({ harness: harness(a.harness), projectPath: str(a.projectPath, "A folder"), model: optStr(a.model), effort: optStr(a.effort), permissionMode: optStr(a.permissionMode) }),
  );
  ops.register("send", async (a) => (await live.send(str(a.sessionId, "sessionId"), typeof a.text === "string" ? a.text : ""), null));
  ops.register("interrupt", async (a) => (await live.interrupt(str(a.sessionId, "sessionId")), null));
  ops.register("setModel", async (a) => (await live.setModel(str(a.sessionId, "sessionId"), str(a.model, "model")), null));
  ops.register("setEffort", async (a) => (await live.setEffort(str(a.sessionId, "sessionId"), str(a.effort, "effort")), null));
  ops.register("setPermissionMode", async (a) => (await live.setPermissionMode(str(a.sessionId, "sessionId"), str(a.mode, "mode")), null));
  ops.register("answerRequest", async (args) => {
    const a = args as Record<string, unknown>;
    const reason = typeof a.reason === "string" ? a.reason.slice(0, 8000) : undefined;
    const answers = Array.isArray(a.answers) ? (a.answers as unknown[]).slice(0, 20).map((x) => (typeof x === "string" ? x.slice(0, 8000) : "")) : undefined;
    const answer = a.allow === true ? { allow: true as const, ...(answers ? { answers } : {}), ...(optStr(a.mode) ? { mode: optStr(a.mode) } : {}) } : { allow: false as const, ...(reason ? { reason } : {}) };
    await live.answerRequest(str(a.sessionId, "sessionId"), str(a.requestId, "requestId"), answer);
    return null;
  });
}
