// Claude Code activity: subagents, background shells, monitors, workflows, MCP tasks, cron jobs
// and wakeups, derived from the Agent SDK's message stream.
//
//  - task_started / task_progress / task_updated / task_notification are the edges of every task
//    (subagent, shell, Monitor, workflow, MCP task); background_tasks_changed is the level signal
//    and catches anything whose edges were missed.
//  - Messages with parent_tool_use_id are a subagent's own turns: its tool calls become the item's
//    steps and latest action instead of transcript entries.
//  - The spawning tool call (Agent, Bash, Monitor) and its structured result (tool_use_result) fill
//    in what the task events leave out: command, model, worktree, final usage.
//  - CronCreate / CronDelete / ScheduleWakeup results become schedule items.
//  - A main-thread tool that reports tool_progress for a while is a long tool call.

import type { ActivityItem, ActivityKind } from "../../../web/src/shared/protocol";
import { ActivityBook, describeTool } from "./activity";

/** A main-thread tool call shows as activity once it has run this long. */
export const LONG_TOOL_S = 15;

const TASK_TOOLS = new Set(["Agent", "Task", "Workflow", "Monitor"]);

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: any) => (b?.type === "text" ? b.text : "")).filter(Boolean).join("\n");
  return "";
}

function kindOf(taskType: string | undefined, tool: string | undefined): ActivityKind {
  if (tool === "Monitor" || taskType === "monitor_mcp" || taskType === "local_monitor") return "monitor";
  switch (taskType) {
    case "local_agent":
    case "remote_agent":
    case "in_process_teammate":
      return "subagent";
    case "local_bash":
      return "shell";
    case "local_workflow":
      return "workflow";
    case "mcp_task":
      return "tool";
    default:
      return tool === "Agent" || tool === "Task" ? "subagent" : "other";
  }
}

const taskStatus = (s: string | undefined): ActivityItem["status"] | undefined =>
  s === "completed" ? "done" : s === "failed" ? "failed" : s === "killed" || s === "stopped" ? "stopped" : s === "paused" ? "waiting" : s === "running" || s === "pending" ? "running" : undefined;

export class ClaudeActivity extends ActivityBook {
  /** main-thread tool calls by tool_use id */
  private calls = new Map<string, { name: string; input: any }>();
  /** spawning tool_use id -> item id */
  private byTool = new Map<string, string>();
  /** items task_progress reports counts for */
  private counted = new Set<string>();
  /** task ids in the last background_tasks_changed */
  private level = new Set<string>();

  /** Feeds one SDK message; returns the items that changed. */
  onMessage(m: any): ActivityItem[] {
    if (m.parent_tool_use_id) this.onSubagent(m);
    else if (m.type === "assistant") this.onAssistant(m.message);
    else if (m.type === "user") this.onUser(m);
    else if (m.type === "system") this.onSystem(m);
    else if (m.type === "tool_progress") this.onToolProgress(m);
    return this.tick();
  }

  /** Wakeups whose time has come have fired. Returns what changed. */
  tick(): ActivityItem[] {
    const now = this.now();
    for (const a of this.list()) if (a.kind === "schedule" && a.status === "waiting" && a.id.startsWith("wakeup:") && a.nextAt && a.nextAt <= now) this.end(a.id, "done");
    return this.take();
  }

  /** Items whose output can be read with getTaskOutput (running background shells and monitors). */
  readable(): ActivityItem[] {
    return this.list().filter((a) => a.status === "running" && (a.kind === "shell" || a.kind === "monitor") && a.stoppable);
  }

  private onAssistant(msg: any) {
    for (const b of msg?.content ?? []) if (b?.type === "tool_use") this.calls.set(b.id, { name: b.name, input: b.input ?? {} });
  }

  /** A subagent's own messages: steps, latest action, model. */
  private onSubagent(m: any) {
    const id = this.byTool.get(m.parent_tool_use_id);
    if (!id) return;
    const count = !this.counted.has(id);
    if (m.type === "assistant") {
      const msg = m.message;
      if (msg?.model && !msg.model.startsWith("<")) this.patch(id, { model: msg.model });
      for (const b of msg?.content ?? []) {
        if (b?.type === "tool_use") this.step(id, { id: b.id, tool: b.name, label: describeTool(b.name, b.input), status: "running" }, { count });
        else if (b?.type === "text" && b.text?.trim() && !this.get(id)?.steps?.some((s) => s.status === "running"))
          this.patch(id, { latest: b.text.trim().split("\n")[0]!.slice(0, 160) });
      }
    } else if (m.type === "user" && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) if (b?.type === "tool_result") this.stepDone(id, b.tool_use_id, b.is_error ? "error" : "done");
    }
  }

  private onUser(m: any) {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== "tool_result") continue;
      const call = this.calls.get(b.tool_use_id);
      const r = m.tool_use_result;
      const one = content.filter((x: any) => x?.type === "tool_result").length === 1;
      const result = one && r && typeof r === "object" ? r : undefined;
      this.onToolResult(b.tool_use_id, call, result, !!b.is_error);
    }
  }

  private onToolResult(toolId: string, call: { name: string; input: any } | undefined, r: any, isError: boolean) {
    const long = this.get(`tool:${toolId}`);
    if (long) this.end(long.id, isError ? "failed" : "done");
    if (!call) return;
    const itemId = this.byTool.get(toolId);
    switch (call.name) {
      case "Agent":
      case "Task": {
        if (!r) break;
        const id = itemId ?? r.agentId ?? r.taskId;
        if (!this.get(id)) break;
        const patch: Partial<ActivityItem> = {};
        if (r.resolvedModel) patch.model = r.resolvedModel;
        if (r.agentType) patch.agentType = r.agentType;
        if (r.worktreePath || r.worktreeBranch) patch.worktree = { path: r.worktreePath, branch: r.worktreeBranch };
        if (r.status === "completed") {
          patch.tokens = r.totalTokens;
          patch.toolUses = r.totalToolUseCount;
          const report = blockText(r.content);
          if (report) patch.summary = report;
          this.end(id, "done", patch);
        } else this.patch(id, patch);
        break;
      }
      case "Monitor":
        if (r?.taskId && this.get(r.taskId))
          this.patch(r.taskId, { kind: "monitor", schedule: r.persistent ? "until stopped" : r.timeoutMs ? `for ${Math.round(r.timeoutMs / 60_000) || "<1"} min` : undefined });
        break;
      case "CronCreate": {
        if (isError || !r?.id) break;
        this.put({
          id: `cron:${r.id}`,
          kind: "schedule",
          title: String(call.input.prompt ?? "Cron job").split("\n")[0]!.slice(0, 120),
          description: call.input.prompt,
          watching: call.input.prompt,
          schedule: [r.humanSchedule ?? call.input.cron, r.recurring === false ? "once" : "", r.durable ? "survives restarts" : ""].filter(Boolean).join(" · "),
          status: "waiting",
          startedAt: this.now(),
          toolId,
          background: true,
        });
        break;
      }
      case "CronDelete":
        if (!isError) this.end(`cron:${call.input.id ?? r?.id}`, "stopped");
        break;
      case "ScheduleWakeup": {
        if (isError) break;
        // One pending wakeup at a time: a new one replaces the last, stop ends them all.
        for (const a of this.list()) if (a.id.startsWith("wakeup:") && a.status === "waiting") this.end(a.id, r?.stopped || call.input.stop ? "stopped" : "done");
        if (r?.stopped || call.input.stop) break;
        const delay = r?.clampedDelaySeconds ?? call.input.delaySeconds ?? 0;
        this.put({
          id: `wakeup:${toolId}`,
          kind: "schedule",
          title: call.input.reason ? String(call.input.reason).slice(0, 120) : "Wake up later",
          description: call.input.prompt,
          watching: call.input.prompt,
          nextAt: r?.scheduledFor ?? this.now() + delay * 1000,
          status: "waiting",
          startedAt: this.now(),
          toolId,
          background: true,
        });
        break;
      }
    }
  }

  private onSystem(m: any) {
    switch (m.subtype) {
      case "task_started": {
        if (m.ambient || m.skip_transcript) return;
        const call = m.tool_use_id ? this.calls.get(m.tool_use_id) : undefined;
        const kind = kindOf(m.task_type, call?.name);
        const input = call?.input ?? {};
        const existing = this.get(m.task_id);
        const item: ActivityItem = {
          ...existing,
          id: m.task_id,
          kind,
          title: (m.task_type === "local_workflow" && m.workflow_name) || m.description || input.description || kind,
          description: m.prompt ?? input.prompt ?? existing?.description,
          status: "running",
          startedAt: existing?.startedAt ?? this.now(),
          endedAt: undefined,
          toolId: m.tool_use_id ?? existing?.toolId,
          parentId: m.parent_task_id,
          background: m.is_backgrounded ?? existing?.background,
          stoppable: true,
        };
        if (kind === "subagent") {
          item.agentType = m.subagent_type ?? input.subagent_type ?? existing?.agentType;
          if (input.model && !item.model) item.model = input.model;
          if (input.isolation === "worktree") item.worktree = existing?.worktree ?? {};
        }
        if (kind === "shell" || kind === "monitor") {
          if (typeof input.command === "string") item.command = input.command;
          if (kind === "monitor") item.watching = input.command ?? input.ws?.url;
        }
        this.put(item);
        if (m.tool_use_id) this.byTool.set(m.tool_use_id, m.task_id);
        return;
      }
      case "task_progress": {
        const id = m.task_id;
        if (!this.get(id)) return;
        this.counted.add(id);
        const p: Partial<ActivityItem> = {};
        if (m.usage) {
          p.tokens = m.usage.total_tokens;
          p.toolUses = m.usage.tool_uses;
        }
        // `summary` is the harness's own progress line; `description` the step it's on.
        const latest = m.summary || m.description;
        if (latest && latest !== this.get(id)!.title) p.latest = latest;
        this.patch(id, p);
        return;
      }
      case "task_updated": {
        const id = m.task_id;
        const patch = m.patch ?? {};
        if (!this.get(id)) return;
        const status = taskStatus(patch.status);
        const p: Partial<ActivityItem> = {};
        if (patch.is_backgrounded !== undefined) p.background = patch.is_backgrounded;
        if (patch.error) p.summary = patch.error;
        if (status === "done" || status === "failed" || status === "stopped") this.end(id, status, { ...p, endedAt: patch.end_time ?? this.now() });
        else this.patch(id, { ...p, ...(status ? { status } : {}) });
        return;
      }
      case "task_notification": {
        if (m.ambient || m.skip_transcript) return;
        const id = m.task_id;
        if (!this.get(id))
          this.put({ id, kind: "other", title: (m.summary ?? "Task").split("\n")[0]!.slice(0, 120), status: "running", startedAt: this.now(), toolId: m.tool_use_id });
        const p: Partial<ActivityItem> = {};
        if (m.summary) p.summary = m.summary;
        if (m.usage) {
          p.tokens = m.usage.total_tokens;
          p.toolUses = m.usage.tool_uses;
        }
        this.end(id, m.status === "failed" ? "failed" : m.status === "stopped" ? "stopped" : "done", p);
        return;
      }
      case "background_tasks_changed": {
        const now = new Set<string>();
        for (const t of m.tasks ?? []) {
          if (t.ambient) continue;
          now.add(t.task_id);
          if (!this.get(t.task_id))
            this.put({
              id: t.task_id,
              kind: kindOf(t.task_type, undefined),
              title: t.description || t.task_type,
              status: "running",
              startedAt: this.now(),
              parentId: t.parent_task_id,
              agentType: t.subagent_type,
              background: true,
              stoppable: true,
            });
        }
        // Left the level without its closing edge: it's over.
        for (const id of this.level) if (!now.has(id) && this.get(id)?.status === "running") this.end(id, "done");
        this.level = now;
        return;
      }
    }
  }

  private onToolProgress(m: any) {
    const call = this.calls.get(m.tool_use_id);
    const name = m.tool_name ?? call?.name ?? "Tool";
    if (TASK_TOOLS.has(name) || this.byTool.has(m.tool_use_id) || (m.elapsed_time_seconds ?? 0) < LONG_TOOL_S) return;
    const id = `tool:${m.tool_use_id}`;
    const cur = this.get(id);
    if (cur) return;
    const input = call?.input ?? {};
    this.put({
      id,
      kind: name === "Bash" ? "shell" : "tool",
      title: input.description || describeTool(name, input),
      command: name === "Bash" ? input.command : undefined,
      status: "running",
      startedAt: this.now() - (m.elapsed_time_seconds ?? 0) * 1000,
      toolId: m.tool_use_id,
      background: false,
    });
  }
}
