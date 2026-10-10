// Codex activity, derived from app-server notifications:
//  - subagents are threads of their own (thread/started with a parentThreadId, subAgentActivity and
//    spawnAgent items on the main thread); their item/* and token events arrive with the child's
//    threadId and become the item's steps, latest action and token count;
//  - background terminals are commandExecution items that end with the process still running
//    (a processId and no exit code); later unifiedExecInteraction items poll them;
//  - sleep items are the agent waiting on purpose.

import type { ActivityItem } from "../../../web/src/shared/protocol";
import { ActivityBook, describeTool, tail } from "./activity";
import { unwrapShell } from "./codex";

const firstLine = (s: string, n = 160) => s.trim().split("\n")[0]!.slice(0, n);
/** "/bin/bash -lc 'wc -l x'" -> "wc -l x" (also the unquoted "/bin/bash -lc ls") */
const shellCommand = (cmd: string) => unwrapShell(cmd ?? "").replace(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(?=[^'"\s])/, "");

/** A child thread's item as a step: what tool, and a one-line label. */
function step(item: any): { tool: string; label: string } | undefined {
  switch (item.type) {
    case "commandExecution":
      return { tool: "bash", label: describeTool("bash", { command: shellCommand(item.command) }) };
    case "fileChange": {
      const files = (item.changes ?? []).map((c: any) => String(c.path ?? "").split("/").pop()).filter(Boolean);
      return { tool: "apply_patch", label: files.length ? `Editing ${files.slice(0, 2).join(", ")}${files.length > 2 ? ` +${files.length - 2}` : ""}` : "Editing" };
    }
    case "mcpToolCall":
      return { tool: `mcp__${item.server}__${item.tool}`, label: `${item.server}: ${item.tool}` };
    case "dynamicToolCall":
      return { tool: item.tool, label: describeTool(item.tool, item.arguments) };
    case "webSearch":
      return { tool: "web_search", label: describeTool("web_search", { query: item.query }) };
    case "collabAgentToolCall":
      return { tool: "Agent", label: `Agents: ${item.tool}` };
    default:
      return undefined;
  }
}

const done = (status: string | undefined, exitCode?: number | null) =>
  status === "failed" || status === "declined" || (exitCode != null && exitCode !== 0) ? ("error" as const) : ("done" as const);

export class CodexActivity extends ActivityBook {
  /** child thread id -> its running turn (to interrupt it) */
  turns = new Map<string, string>();

  /** Feeds one notification (any thread); returns the items that changed. */
  onNotify(method: string, p: any, mainThread: string): ActivityItem[] {
    if (method === "thread/started") this.onThread(p.thread, mainThread);
    else if (p?.threadId && p.threadId !== mainThread) this.onChild(method, p);
    else if (method === "item/started" || method === "item/completed") this.onMainItem(p.item, method === "item/completed");
    else if (method === "item/commandExecution/terminalInteraction") this.touchProcess(p.processId);
    return this.take();
  }

  private ensureAgent(id: string, p: Partial<ActivityItem>) {
    const cur = this.get(id);
    if (cur) return this.patch(id, Object.fromEntries(Object.entries(p).filter(([, v]) => v != null)));
    return this.put({ id, kind: "subagent", title: "Subagent", status: "running", startedAt: this.now(), background: true, stoppable: true, ...p });
  }

  private onThread(t: any, mainThread: string) {
    const spawn = t?.source?.subAgent?.thread_spawn;
    const parent = t?.parentThreadId ?? spawn?.parent_thread_id;
    if (!t?.id || !parent) return;
    this.ensureAgent(t.id, {
      title: t.agentNickname ?? spawn?.agent_nickname ?? t.agentRole ?? spawn?.agent_role ?? "Subagent",
      agentType: t.agentRole ?? spawn?.agent_role ?? undefined,
      model: t.model ?? undefined,
      parentId: parent !== mainThread ? parent : undefined,
    });
  }

  /** The main thread's own items: spawns, background terminals, sleeps. */
  private onMainItem(item: any, completed: boolean) {
    if (!item) return;
    switch (item.type) {
      case "collabAgentToolCall":
        if (item.tool === "spawnAgent")
          for (const id of item.receiverThreadIds ?? [])
            this.ensureAgent(id, {
              ...(this.get(id) && this.get(id)!.title !== "Subagent" ? {} : item.prompt ? { title: firstLine(item.prompt, 80) } : {}),
              description: item.prompt ?? undefined,
              model: item.model || undefined,
              toolId: item.id,
            });
        for (const [id, st] of Object.entries<any>(item.agentsStates ?? {})) {
          if (!this.get(id) || !st) continue;
          if (st.status === "completed" || st.status === "shutdown") this.end(id, "done", st.message ? { summary: st.message } : {});
          else if (st.status === "errored") this.end(id, "failed", st.message ? { summary: st.message } : {});
          else if (st.status === "interrupted") this.end(id, "stopped");
        }
        return;
      case "subAgentActivity": {
        const id = item.agentThreadId;
        if (!id) return;
        const name = String(item.agentPath ?? "").split("/").filter(Boolean).pop();
        if (item.kind === "started") this.ensureAgent(id, { title: this.get(id)?.title !== "Subagent" ? this.get(id)?.title : name, model: item.model ?? undefined });
        else if (item.kind === "completed") this.end(id, "done");
        else if (item.kind === "interrupted") this.end(id, "stopped");
        return;
      }
      case "commandExecution": {
        const pid = item.processId;
        if (!pid) return;
        const id = `proc:${pid}`;
        const output = item.aggregatedOutput ? tail(item.aggregatedOutput) : undefined;
        if (item.source === "unifiedExecInteraction") {
          if (!this.get(id)) return;
          if (output) this.patch(id, { output });
          if (completed && item.exitCode != null) this.end(id, item.exitCode === 0 ? "done" : "failed", { summary: `exit code ${item.exitCode}` });
          return;
        }
        // A command that returned while its process keeps running is a background terminal.
        if (completed && item.exitCode == null && item.status !== "failed" && item.status !== "declined")
          this.put({
            id,
            kind: "shell",
            title: firstLine(shellCommand(item.command) || "command", 120),
            command: shellCommand(item.command),
            output,
            status: "running",
            startedAt: this.get(id)?.startedAt ?? this.now() - (item.durationMs ?? 0),
            toolId: item.id,
            background: true,
          });
        else if (completed && this.get(id)) this.end(id, item.exitCode === 0 ? "done" : "failed", { output });
        return;
      }
      case "sleep":
        if (!completed)
          this.put({ id: `sleep:${item.id}`, kind: "schedule", title: "Waiting", status: "waiting", startedAt: this.now(), nextAt: this.now() + (item.durationMs ?? 0), toolId: item.id });
        else this.end(`sleep:${item.id}`, "done");
        return;
    }
  }

  private touchProcess(pid: string | undefined) {
    if (pid && this.get(`proc:${pid}`)) this.patch(`proc:${pid}`, { latest: "Reading its output" });
  }

  /** A subagent's own thread. */
  private onChild(method: string, p: any) {
    const id = p.threadId;
    if (!this.get(id)) {
      // Events from a child we never saw start (e.g. after a reconnect): still worth a row.
      if (method !== "turn/started" && method !== "item/started") return;
      this.ensureAgent(id, {});
    }
    switch (method) {
      case "turn/started": {
        this.turns.set(id, p.turn?.id);
        const cur = this.get(id)!;
        // A finished subagent that's given more work runs again.
        if (cur.endedAt) this.put({ ...cur, status: "running", endedAt: undefined });
        return;
      }
      case "turn/completed": {
        this.turns.delete(id);
        const st = p.turn?.status;
        this.end(id, st === "failed" ? "failed" : st === "interrupted" ? "stopped" : "done", st === "failed" && p.turn?.error?.message ? { summary: p.turn.error.message } : {});
        return;
      }
      case "item/started": {
        const s = step(p.item);
        if (s) this.step(id, { id: p.item.id, ...s, status: "running" });
        return;
      }
      case "item/completed": {
        const item = p.item;
        if (item?.type === "agentMessage" && item.text?.trim()) this.patch(id, { latest: firstLine(item.text), summary: item.text.trim() });
        else if (step(item)) this.stepDone(id, item.id, done(item.status, item.exitCode));
        return;
      }
      case "thread/tokenUsage/updated": {
        const total = p.tokenUsage?.total?.totalTokens;
        if (total) this.patch(id, { tokens: total });
        return;
      }
      case "thread/status/changed":
        if (p.status?.type === "systemError") this.end(id, "failed");
        return;
      case "thread/closed":
        if (this.get(id)?.status === "running") this.end(id, "done");
        return;
    }
  }
}
