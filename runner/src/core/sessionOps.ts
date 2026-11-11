// The session ops browsers call (shared/protocol.ts Ops), wired to the core. Arguments come off
// the wire: each handler checks what it reads.

import { defang } from "../../../shared/fromTether";
import { MESSAGE_TEXT_MAX } from "../../../shared/limits";
import type { HarnessId } from "../../../shared/transcript";
import type { LiveControl } from "./live";
import type { OpRegistry } from "./ops";
import { CloneJobs, listFolders } from "./addProject";
import { checkFolder, type SessionCore } from "./sessions";

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`${what} is required.`);
  return v;
};
const optStr = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const optNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const harness = (v: unknown): HarnessId => (v === "codex" ? "codex" : v === "claude" || v === undefined ? "claude" : (str(undefined, "A known harness") as never));

export function registerSessionOps(ops: OpRegistry, core: SessionCore, live: LiveControl) {
  ops.register("renameSession", async (a) => {
    const s = await core.open(str(a.sessionId, "sessionId"));
    const title = str(a.title, "A title").trim();
    if (!title || title.length > 200 || /[\x00-\x1f\x7f]/.test(title)) throw new Error("Use a title of 1–200 characters.");
    core.o.prefs.set(s.id, { title });
    core.o.prefs.flush();
    core.touch(s, { title });
    return null;
  });
  ops.register("setSessionArchived", async (a) => {
    if (typeof a.archived !== "boolean") throw new Error("archived must be true or false.");
    const s = await core.open(str(a.sessionId, "sessionId"));
    await core.setArchived(s, a.archived);
    return null;
  });
  ops.register("listProjects", async () => ({ projects: await core.listProjects() }));
  ops.register("listSessions", (a) =>
    core.listSessions({ projectPath: optStr(a.projectPath), parentSessionId: optStr(a.parentSessionId), query: optStr(a.query), limit: optNum(a.limit) }),
  );
  ops.register("subscribe", (a) => core.subscribe(str(a.sessionId, "sessionId"), optNum(a.limit)));
  ops.register("history", async (a) => core.history(await core.open(str(a.sessionId, "sessionId")), str(a.before, "before"), optNum(a.limit)));
  ops.register("fullPart", async (a) => core.fullPart(await core.open(str(a.sessionId, "sessionId")), str(a.msgId, "msgId"), optNum(a.part) ?? -1, optNum(a.offset)));
  ops.register("listModels", (a) => live.listModels(harness(a.harness), optStr(a.sessionId)));
  ops.register("listCommands", async (a) => ({ commands: await live.commands.list(str(a.sessionId, "sessionId")) }));
  ops.register("newSession", (a) =>
    live.newSession({ harness: harness(a.harness), projectPath: str(a.projectPath, "A folder"), model: optStr(a.model), effort: optStr(a.effort), permissionMode: optStr(a.permissionMode), terminal: a.terminal === true, createFolder: a.createFolder === true, source: a.source }),
  );
  ops.register("checkFolder", (a) => checkFolder(str(a.projectPath, "A folder")));
  ops.register("listFolders", (a) => listFolders(str(a.path, "A folder")));
  const clones = new CloneJobs();
  ops.register("cloneRepo", (a) => clones.start(str(a.repo, "A repo"), str(a.path, "A folder")));
  ops.register("cloneStatus", (a) => clones.status(str(a.cloneId, "cloneId")));
  ops.register("activeClones", () => ({ clones: clones.active() }));
  ops.register("cancelClone", (a) => (clones.cancel(str(a.cloneId, "cloneId")), null));
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  // What a person types never passes for one of Tether's own messages (shared/fromTether.ts).
  const typed = (v: unknown) => defang(text(v));
  /** Attachments a message names, checked against the session's own folder (a subagent's: its main session's too). */
  const files = async (sessionId: string, list: unknown) => {
    if (list === undefined) return [];
    const s = await core.open(sessionId);
    return live.attachments.check([sessionId, ...(s.summary.parentSessionId ? [s.summary.parentSessionId] : [])], list);
  };
  ops.register("send", async (a) => {
    const id = str(a.sessionId, "sessionId");
    const list = await files(id, a.attachments);
    await live.send(id, typed(a.text), list, { stop: a.stop === true });
    live.attachments.markUsed(list);
    return null;
  });
  ops.register("steer", async (a) => {
    const id = str(a.sessionId, "sessionId");
    const list = await files(id, a.attachments);
    await live.steer(id, typed(a.text), list);
    live.attachments.markUsed(list);
    return null;
  });
  ops.register("queue", async (a) => {
    const id = str(a.sessionId, "sessionId");
    const list = await files(id, a.attachments);
    const r = await live.queue.add(id, typed(a.text), list);
    live.attachments.markUsed(list);
    return r;
  });
  ops.register("editQueued", async (a) => (await live.queue.edit(str(a.sessionId, "sessionId"), str(a.id, "id"), typed(a.text)), null));
  ops.register("cancelQueued", async (a) => (await live.queue.cancel(str(a.sessionId, "sessionId"), str(a.id, "id")), null));
  ops.register("moveQueued", async (a) => (await live.queue.move(str(a.sessionId, "sessionId"), str(a.id, "id"), optNum(a.to) ?? 0), null));
  ops.register("resumeQueue", async (a) => (await live.queue.resume(str(a.sessionId, "sessionId")), null));
  ops.register("uploadAttachment", async (a) => {
    const id = str(a.sessionId, "sessionId");
    // The session must exist: nothing is written for a made-up id.
    await core.open(id);
    return live.attachments.receive({ sessionId: id, uploadId: str(a.uploadId, "uploadId"), name: text(a.name), mimeType: text(a.mimeType), size: optNum(a.size) ?? 0, offset: optNum(a.offset) ?? -1, data: text(a.data) });
  });
  ops.register("setRead", async (a) => (live.read.set(str(a.sessionId, "sessionId"), a.read === false), null));
  ops.register("interrupt", async (a) => (await live.interrupt(str(a.sessionId, "sessionId")), null));
  ops.register("retryNow", async (a) => (await live.retryNow(str(a.sessionId, "sessionId")), null));
  ops.register("cancelRetry", async (a) => (await live.cancelRetry(str(a.sessionId, "sessionId")), null));
  ops.register("backgroundSubagent", async (a) => (await live.backgroundSubagent(str(a.sessionId, "sessionId"), str(a.toolId, "toolId")), null));
  ops.register("stopBackground", async (a) => (await live.stopBackground(str(a.sessionId, "sessionId")), null));
  ops.register("setModel", async (a) => (await live.setModel(str(a.sessionId, "sessionId"), str(a.model, "model")), null));
  ops.register("setEffort", async (a) => (await live.setEffort(str(a.sessionId, "sessionId"), str(a.effort, "effort")), null));
  ops.register("setPermissionMode", async (a) => (await live.setPermissionMode(str(a.sessionId, "sessionId"), str(a.mode, "mode")), null));
  ops.register("answerRequest", async (args) => {
    const a = args as Record<string, unknown>;
    // A plan's feedback (a reason) and notes can be long: as long as a message.
    const long = (v: unknown) => (typeof v === "string" ? defang(v.slice(0, MESSAGE_TEXT_MAX)) : undefined);
    const reason = long(a.reason);
    const notes = long(a.notes);
    const answers = Array.isArray(a.answers) ? (a.answers as unknown[]).slice(0, 20).map((x) => (typeof x === "string" ? x.slice(0, 8000) : "")) : undefined;
    const answer = a.allow === true ? { allow: true as const, ...(answers ? { answers } : {}), ...(optStr(a.mode) ? { mode: optStr(a.mode) } : {}), ...(notes?.trim() ? { notes } : {}) } : { allow: false as const, ...(reason ? { reason } : {}) };
    await live.answerRequest(str(a.sessionId, "sessionId"), str(a.requestId, "requestId"), answer);
    return null;
  });
}
