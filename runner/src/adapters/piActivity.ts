// pi activity. Core pi has no subagents or background shells; the pi-subagents package adds them:
//  - its foreground `subagent` tool streams tool_execution_update records whose
//    partialResult.details.progress lists every agent of the call (status, current tool, recent
//    tools, tokens, model), and tool_execution_end carries details.results with the final outputs;
//  - async (background) runs and workflows are published as a JSON snapshot through the
//    "subagent-async" widget (extension_ui_request setWidget, "PI_SUBAGENT_ASYNC_JSON:" + JSON).

import type { ActivityItem, ActivityStatus } from "../../../web/src/shared/protocol";
import { ActivityBook, describeTool, tail } from "./activity";

const ASYNC_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const firstLine = (s: unknown, n = 100) => String(s ?? "").trim().split("\n")[0]!.slice(0, n);

const progressStatus = (s: string | undefined): ActivityStatus =>
  s === "completed" ? "done" : s === "failed" ? "failed" : s === "detached" ? "stopped" : "running";

const nodeStatus = (s: string | undefined): ActivityStatus =>
  s === "complete" || s === "partial"
    ? "done"
    : s === "failed" || s === "rejected"
      ? "failed"
      : s === "stopped"
        ? "stopped"
        : s === "queued" || s === "paused"
          ? "waiting"
          : "running";

export class PiActivity extends ActivityBook {
  /** async run ids in the last snapshot */
  private asyncIds = new Set<string>();

  /** Feeds one RPC record; returns the items that changed. */
  onRecord(r: any): ActivityItem[] {
    if (r?.type === "tool_execution_update" && r.toolName === "subagent") this.onProgress(r.toolCallId, r.partialResult?.details);
    else if (r?.type === "tool_execution_end" && r.toolName === "subagent") this.onEnd(r.toolCallId, r.result?.details, !!r.isError);
    else if (r?.type === "extension_ui_request" && r.method === "setWidget" && r.widgetKey === "subagent-async") this.onSnapshot(r.widgetLines);
    return this.take();
  }

  private onProgress(toolCallId: string, d: any) {
    if (!d) return;
    const results: any[] = d.results ?? [];
    for (const p of d.progress ?? results.map((x) => x.progress).filter(Boolean)) {
      const id = `${toolCallId}:${p.index ?? 0}`;
      const cur = this.get(id);
      const item: ActivityItem = {
        ...cur,
        id,
        kind: "subagent",
        title: firstLine(p.task) || p.agent || "Subagent",
        description: p.task,
        agentType: p.agent,
        status: progressStatus(p.status),
        startedAt: cur?.startedAt ?? this.now() - (p.durationMs ?? 0),
        toolId: toolCallId,
        background: false,
        model: p.model ?? cur?.model,
        tokens: p.tokens ?? cur?.tokens,
        toolUses: p.toolCount ?? cur?.toolUses,
        latest: p.currentTool ? describeTool(p.currentTool, p.currentToolArgs) : p.recentOutput?.length ? firstLine(p.recentOutput.at(-1), 160) : cur?.latest,
        steps: (p.recentTools ?? []).map((t: any, i: number) => ({ id: `${t.tool}:${t.endMs ?? i}`, tool: t.tool, label: describeTool(t.tool, t.args), status: "done" as const, ts: t.endMs ?? this.now() })),
        output: p.recentOutput?.length ? tail(p.recentOutput.join("\n")) : cur?.output,
        summary: p.error ?? cur?.summary,
      };
      if (p.currentTool) item.steps = [...item.steps!, { id: `now:${p.currentToolStartedAt ?? ""}`, tool: p.currentTool, label: item.latest!, status: "running", ts: p.currentToolStartedAt ?? this.now() }];
      if (item.status !== "running" && !cur?.endedAt) item.endedAt = this.now();
      this.put(item);
    }
  }

  private onEnd(toolCallId: string, d: any, isError: boolean) {
    this.onProgress(toolCallId, d);
    for (const r of d?.results ?? []) {
      const id = `${toolCallId}:${r.index ?? 0}`;
      if (!this.get(id)) continue;
      const failed = r.error || r.timedOut || (r.exitCode != null && r.exitCode !== 0);
      this.end(id, r.stopped || r.interrupted ? "stopped" : failed ? "failed" : "done", {
        summary: r.error ?? r.finalOutput ?? undefined,
        model: r.model ?? this.get(id)!.model,
        ...(r.usage ? { tokens: (r.usage.input ?? 0) + (r.usage.output ?? 0) } : {}),
      });
    }
    // Anything of this call still marked running is over with it.
    for (const a of this.list()) if (a.toolId === toolCallId && a.status === "running" && !a.id.startsWith("async:")) this.end(a.id, isError ? "failed" : "done");
  }

  private onSnapshot(lines: unknown) {
    const line = Array.isArray(lines) ? lines.find((l) => typeof l === "string" && l.startsWith(ASYNC_PREFIX)) : undefined;
    let runs: any[] = [];
    if (line)
      try {
        runs = JSON.parse(line.slice(ASYNC_PREFIX.length)).runs ?? [];
      } catch {
        return;
      }
    const seen = new Set<string>();
    const visit = (n: any, parentId?: string) => {
      if (!n?.id) return;
      const id = `async:${n.id}`;
      seen.add(id);
      const cur = this.get(id);
      const status = nodeStatus(n.state);
      const a = n.activity ?? {};
      this.put({
        ...cur,
        id,
        kind: n.kind === "workflow" ? "workflow" : "subagent",
        title: firstLine(n.label) || n.kind,
        status,
        startedAt: n.startedAt ?? cur?.startedAt ?? this.now(),
        endedAt: status === "running" || status === "waiting" ? undefined : (n.endedAt ?? cur?.endedAt ?? this.now()),
        parentId,
        background: true,
        toolUses: a.toolCount ?? cur?.toolUses,
        latest: a.currentTool ? describeTool(a.currentTool, {}) : cur?.latest,
      });
      for (const c of n.children ?? []) visit(c, id);
    };
    for (const n of runs) visit(n);
    // Gone from the snapshot while still going: it ended out of sight.
    for (const id of this.asyncIds) if (!seen.has(id) && this.get(id)?.status === "running") this.end(id, "done");
    this.asyncIds = seen;
  }
}
