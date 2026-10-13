// pi activity. Core pi has no subagents or background shells; the pi-subagents package adds them:
//  - its foreground `subagent` tool streams tool_execution_update records whose
//    partialResult.details.progress lists every agent of the call (status, current tool, recent
//    tools, tokens, model), and tool_execution_end carries details.results with the final outputs;
//  - async (background) runs and workflows are published as a JSON snapshot through the
//    "subagent-async" widget (extension_ui_request setWidget, "PI_SUBAGENT_ASYNC_JSON:" + JSON).
// Workflows and chains have real steps: a foreground chain/workflow call's chainAgents or
// workflowGraph, an async workflow's "step"/"host-step" children. They become the workflow item's
// phases, and each agent's item names its phase.

import type { ActivityItem, ActivityPhase, ActivityStatus } from "../../../web/src/shared/protocol";
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

const isLane = (c: any) => c?.kind === "step" || c?.kind === "host-step";

const phaseStatus = (s: string | undefined): ActivityPhase["status"] =>
  s === "complete" || s === "partial" ? "done" : s === "failed" || s === "rejected" || s === "stopped" ? "failed" : s === "queued" || s === "paused" ? "pending" : "running";

function lanePhase(c: any): ActivityPhase {
  const status = phaseStatus(c.state);
  const detail =
    c.state === "stopped"
      ? "Stopped"
      : c.state === "partial"
        ? "Partly done"
        : status === "running" && c.activity?.currentTool
          ? describeTool(c.activity.currentTool, {})
          : c.hostStep?.detail
            ? firstLine(c.hostStep.detail, 160)
            : undefined;
  return { title: firstLine(c.label) || "Step", status, ...(detail ? { detail } : {}) };
}

/** A foreground workflow graph node's status (WorkflowNodeStatus) as a phase status; detached or unknown: not running here. */
const graphStatus = (s: string): ActivityPhase["status"] =>
  s === "completed" || s === "partial" ? "done" : s === "failed" || s === "rejected" || s === "stopped" ? "failed" : s === "running" ? "running" : "pending";

/**
 * The steps of a foreground chain or workflow call, each over a run of agent indexes (a parallel
 * step has several): from details.workflowGraph when sent, else details.chainAgents ("[a+b]" is a
 * parallel step of two). Same reading as pi-subagents' own renderer (tui/render.js).
 */
export function chainSpans(d: any): { title: string; start: number; count: number; status?: string }[] {
  const nodes: any[] = (d?.workflowGraph?.nodes ?? []).filter((n: any) => n?.stepIndex !== undefined).sort((a: any, b: any) => a.stepIndex - b.stepIndex);
  if (nodes.length) {
    let cursor = 0;
    return nodes.map((n) => {
      const kids: number[] = (n.children ?? []).map((c: any) => c.flatIndex).filter((x: unknown) => typeof x === "number");
      const group = n.kind === "parallel-group" || n.kind === "dynamic-parallel-group";
      const start = group ? (kids.length ? Math.min(...kids) : cursor) : (n.flatIndex ?? cursor);
      const count = group ? (n.children?.length ?? 0) : 1;
      cursor = Math.max(cursor, start + count);
      return { title: firstLine(n.label) || n.agent || `Step ${n.stepIndex + 1}`, start, count, status: n.status };
    });
  }
  let start = 0;
  return (d?.chainAgents ?? []).map((label: string) => {
    const parallel = typeof label === "string" && label.startsWith("[") && label.endsWith("]");
    const count = parallel ? label.slice(1, -1).split("+").filter((x) => x.trim()).length : 1;
    const span = { title: parallel ? label.slice(1, -1).split("+").map((x) => x.trim()).join(" + ") : String(label), start, count };
    start += count;
    return span;
  });
}

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
    const progress: any[] = d.progress ?? results.map((x) => x.progress).filter(Boolean);
    // A chain or workflow call: its steps are phases of one workflow item, its agents children.
    const spans = (d.mode === "chain" || d.mode === "workflow") && !d.background ? chainSpans(d) : [];
    const chainId = spans.length > 1 ? `chain:${toolCallId}` : undefined;
    if (chainId) {
      const cur = this.get(chainId);
      const phases = spans.map((s): ActivityPhase => {
        const mine = progress.filter((p) => (p.index ?? 0) >= s.start && (p.index ?? 0) < s.start + s.count);
        const done = mine.filter((p) => p.status === "completed").length;
        const failed = mine.some((p) => p.status === "failed");
        const going = mine.find((p) => p.status === "running");
        const status = s.status ? graphStatus(s.status) : failed ? "failed" : going ? "running" : done && done >= s.count ? "done" : "pending";
        const detail = s.count > 1 && mine.length ? `${done} of ${s.count} agents done` : going?.currentTool ? describeTool(going.currentTool, going.currentToolArgs) : undefined;
        return { title: s.title, status, ...(detail ? { detail } : {}) };
      });
      const now = progress.find((p) => p.status === "running");
      if (!cur?.endedAt)
        this.put({
          ...cur,
          id: chainId,
          kind: "workflow",
          title: d.mode === "workflow" ? "Workflow" : `Chain: ${spans.map((s) => s.title).join(" → ")}`.slice(0, 120),
          status: "running",
          startedAt: cur?.startedAt ?? this.now(),
          toolId: toolCallId,
          background: false,
          latest: now ? (now.currentTool ? describeTool(now.currentTool, now.currentToolArgs) : firstLine(now.task)) : cur?.latest,
          phases,
        });
    }
    for (const p of progress) {
      const id = `${toolCallId}:${p.index ?? 0}`;
      const cur = this.get(id);
      // Not started yet (a later chain step): nothing running to show.
      if (p.status === "pending" && !cur) continue;
      const phase = chainId ? spans.findIndex((s) => (p.index ?? 0) >= s.start && (p.index ?? 0) < s.start + s.count) : -1;
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
        ...(chainId ? { parentId: chainId, ...(phase >= 0 ? { phase } : {}) } : {}),
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
    const visit = (n: any, parentId?: string, phase?: number, lane = false) => {
      if (!n?.id) return;
      const id = `async:${n.id}`;
      const cur = this.get(id);
      const status = nodeStatus(n.state);
      // A workflow's lanes ("step" nodes, planned stages included) and host checks are its phases.
      const lanes = n.kind === "workflow" ? (n.children ?? []).filter(isLane) : [];
      // A lane that hasn't started is only a phase, not something running.
      if (phase !== undefined && status === "waiting" && !cur) return;
      seen.add(id);
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
        phase,
        background: true,
        toolUses: a.toolCount ?? cur?.toolUses,
        latest: a.currentTool ? describeTool(a.currentTool, {}) : n.hostStep?.detail ? firstLine(n.hostStep.detail, 160) : cur?.latest,
        ...(lanes.length ? { phases: lanes.map(lanePhase) } : {}),
      });
      // A lane's own runs (a parallel step's agents) sit under it, in its phase.
      if (lane) {
        for (const g of n.children ?? []) visit(g, id, phase);
        return;
      }
      for (const c of n.children ?? []) {
        const i = lanes.indexOf(c);
        if (i < 0) visit(c, id);
        // A host check (CI, review bot) is only a phase.
        else if (c.kind !== "host-step") visit(c, id, i, true);
      }
    };
    for (const n of runs) visit(n);
    // Gone from the snapshot while still going: it ended out of sight.
    for (const id of this.asyncIds) if (!seen.has(id) && this.get(id)?.status === "running") this.end(id, "done");
    this.asyncIds = seen;
  }
}
