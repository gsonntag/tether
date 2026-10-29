// Codex thread items as transcript parts and messages (SPEC §5, §6). The app-server describes a
// thread as turns of items (userMessage, agentMessage, reasoning, commandExecution, fileChange, …),
// the same shape live (item/started, item/completed) and stored (thread/turns/list), so live and
// stored transcripts agree:
//
//  - a userMessage item is a user message, id `u-<item id>`: typed in Tether, in Codex's own TUI,
//    or steered into a running turn, they all arrive this way;
//  - the items after it, up to the next user message, are one assistant message, id
//    `a-<the first shown item's id>`;
//  - a context compaction is a notice (`c-<item id>`, not Tether's own "n-" notices).
//
// Pure: tested from recorded daemon streams (fixtures/).

import { resolve } from "node:path";
import { fromTether } from "../../../../shared/fromTether";
import type { Msg, Part, ToolPart } from "../../../../shared/transcript";
import { classifyTool } from "../toolKind";

/** Codex runs shell commands as `/bin/bash -lc '<script>'`: the card shows the script. */
export function unwrapShell(cmd: string): string {
  const m = cmd.match(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)")$/s);
  if (!m) return cmd.replace(/^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(?=[^'"\s])/, "");
  return m[1] !== undefined ? m[1].replace(/'\\''/g, "'") : m[2]!.replace(/\\(["\\$`])/g, "$1");
}

/** A unified diff as old/new text pairs per hunk (the edit card draws them as a diff). */
export function diffPairs(diff: string, kind: string): { old_string: string; new_string: string }[] {
  const lines = diff.split("\n");
  if (!lines.some((l) => l.startsWith("@@"))) return kind === "delete" ? [{ old_string: diff, new_string: "" }] : [{ old_string: "", new_string: diff }];
  const hunks: { o: string[]; n: string[] }[] = [];
  let cur: { o: string[]; n: string[] } | undefined;
  for (const l of lines) {
    if (l.startsWith("@@")) hunks.push((cur = { o: [], n: [] }));
    else if (!cur || l.startsWith("\\")) continue;
    else if (l[0] === " ") cur.o.push(l.slice(1)), cur.n.push(l.slice(1));
    else if (l[0] === "-") cur.o.push(l.slice(1));
    else if (l[0] === "+") cur.n.push(l.slice(1));
  }
  return hunks.map((h) => ({ old_string: h.o.join("\n"), new_string: h.n.join("\n") }));
}

/** A patch's input as the edit card reads it: the (first) file, every file, and the hunks. */
export function patchInput(changes: { path: string; kind?: { type?: string } | string; diff?: string }[], cwd: string) {
  const kindOf = (c: (typeof changes)[number]) => (typeof c.kind === "string" ? c.kind : (c.kind?.type ?? "update"));
  const paths = changes.map((c) => resolve(cwd, c.path));
  return {
    path: paths[0] ?? cwd,
    ...(paths.length > 1 ? { files: paths } : {}),
    edits: changes.flatMap((c) => diffPairs(c.diff ?? "", kindOf(c))),
  };
}

const toolStatus = (s: string | undefined): ToolPart["status"] => (s === "completed" ? "done" : s === "failed" || s === "declined" || s === "interrupted" ? "error" : "running");

function mcpText(r: any): string | undefined {
  if (!r) return undefined;
  const text = (r.content ?? []).map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c))).join("\n");
  return text || (r.structuredContent ? JSON.stringify(r.structuredContent, null, 2) : undefined);
}

function tool(id: string, name: string, input: unknown, status: ToolPart["status"], output?: string | null, extra: Partial<ToolPart> = {}): ToolPart {
  return { type: "tool", id, name, input, status, ...classifyTool(name, input), ...(output ? { output } : {}), ...extra };
}

/** Codex's calls on its subagents, as their cards name them. */
const COLLAB_NAMES: Record<string, string> = {
  wait: "Wait for subagents",
  sendInput: "Message a subagent",
  sendMessage: "Message a subagent",
  followupTask: "Follow-up for a subagent",
  resumeAgent: "Resume a subagent",
  closeAgent: "Close a subagent",
  interruptAgent: "Stop a subagent",
  listAgents: "List subagents",
};

/** The last part of a subagent's path ("/root/list_files" -> "list_files"). */
export const pathLeaf = (p: unknown): string | undefined => (typeof p === "string" ? p.split("/").filter(Boolean).pop() : undefined);

/** A subagent's name: the task name in its path, else the nickname Codex gave it. */
export const agentName = (t: any): string | undefined =>
  pathLeaf(t?.agentPath ?? t?.source?.subAgent?.thread_spawn?.agent_path) ?? t?.agentNickname ?? t?.source?.subAgent?.thread_spawn?.agent_nickname ?? t?.agentRole ?? undefined;

/** A thread item as a part (undefined: not shown). Text and thinking may be empty while streaming. */
export function itemPart(item: any, cwd: string): Part | undefined {
  switch (item?.type) {
    case "agentMessage":
    case "plan":
      return { type: "text", text: item.text ?? "" };
    case "reasoning": {
      const text = (item.summary?.length ? item.summary : (item.content ?? [])).join("\n\n");
      return { type: "thinking", text };
    }
    case "commandExecution": {
      const command = unwrapShell(item.command ?? "");
      const failed = item.status === "completed" && item.exitCode != null && item.exitCode !== 0;
      return tool(item.id, "bash", { command }, failed ? "error" : toolStatus(item.status), item.aggregatedOutput);
    }
    case "fileChange":
      return tool(item.id, "apply_patch", patchInput(item.changes ?? [], cwd), toolStatus(item.status));
    case "mcpToolCall":
      return tool(item.id, `mcp__${item.server}__${item.tool}`, item.arguments ?? {}, toolStatus(item.status), item.error?.message ?? mcpText(item.result));
    case "dynamicToolCall":
      return tool(item.id, item.tool, item.arguments ?? {}, toolStatus(item.status), (item.contentItems ?? []).map((c: any) => c.text ?? "[image]").join("\n") || undefined);
    case "collabAgentToolCall": {
      if (item.tool === "spawnAgent") {
        const child = item.receiverThreadIds?.[0];
        const report = child ? item.agentsStates?.[child]?.message : undefined;
        // Spawning returns at once; the subagent's own status shows on its session.
        return tool(item.id, "Agent", { prompt: item.prompt ?? "", ...(item.model ? { model: item.model } : {}) }, toolStatus(item.status), report);
      }
      const reports = Object.entries<any>(item.agentsStates ?? {})
        .map(([, st]) => st?.message)
        .filter(Boolean)
        .join("\n\n");
      // Waiting for, messaging or closing subagents: a task card (no link, no JSON), named for what it does.
      const t = tool(item.id, COLLAB_NAMES[item.tool] ?? `Subagents: ${item.tool}`, item.prompt ? { prompt: item.prompt } : {}, toolStatus(item.status), reports || undefined);
      return { ...t, kind: "task" };
    }
    case "subAgentActivity":
      // A subagent started (Codex ≥ 0.165 reports spawns this way): its card links to its session.
      if (item.kind !== "started") return undefined;
      return tool(item.id, "Agent", { description: pathLeaf(item.agentPath) ?? "Subagent", ...(item.model ? { model: item.model } : {}) }, "done");
    case "webSearch":
      return tool(item.id, "web_search", { query: item.query ?? item.action?.query ?? "" }, item.status ? toolStatus(item.status) : "done");
    case "imageView":
      return tool(item.id, "view_image", { path: item.path }, "done");
    case "imageGeneration":
      return tool(item.id, "image_generation", { prompt: item.revisedPrompt ?? item.prompt ?? "" }, toolStatus(item.status));
    default:
      return undefined;
  }
}

/** A user message's text: its text inputs (images and skills as a word). */
export function userText(item: any): string {
  return (item.content ?? [])
    .map((c: any) => (c.type === "text" ? c.text : c.type === "image" || c.type === "localImage" ? "[image]" : c.type === "skill" || c.type === "mention" ? `$${c.name}` : ""))
    .filter(Boolean)
    .join("\n");
}

/** A userMessage item as a transcript message (Tether's own messages marked as such). */
export function userMsg(item: any, ts: number): Msg | undefined {
  const text = userText(item);
  if (!text) return undefined;
  const tether = fromTether(text);
  return tether !== undefined
    ? { id: `u-${item.id}`, role: "user", ts, origin: { kind: "tether" }, parts: [{ type: "text", text: tether }] }
    : { id: `u-${item.id}`, role: "user", ts, parts: [{ type: "text", text }] };
}

export const compactionNotice = (id: string, ts: number): Msg => ({ id: `c-${id}`, role: "notice", level: "info", ts, parts: [{ type: "text", text: "Context compacted." }] });

/** A part worth showing: empty text and thinking aren't. */
export const shown = (p: Part | undefined): p is Part => !!p && !((p.type === "text" || p.type === "thinking") && !p.text);

/** A turn's error as people read it. */
export function turnError(turn: any): string | undefined {
  if (turn?.status !== "failed") return undefined;
  const e = turn.error;
  return [e?.message, e?.additionalDetails].filter(Boolean).join(": ") || "The turn failed.";
}

/** A stored thread's turns as a transcript. */
export function historyMsgs(turns: any[], cwd: string, model?: string): Msg[] {
  const out: Msg[] = [];
  let last = 0;
  /** subagent thread -> its spawn card (a later agents call's report shows on it, as live) */
  const spawns = new Map<string, ToolPart>();
  for (const turn of turns) {
    let a: Msg | undefined;
    const ts = (last = (turn.startedAt ?? 0) * 1000 || (turn.completedAt ?? 0) * 1000 || last);
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage") {
        const u = userMsg(item, ts);
        if (u) out.push(u);
        a = undefined;
        continue;
      }
      if (item.type === "contextCompaction") {
        out.push(compactionNotice(item.id, ts));
        a = undefined;
        continue;
      }
      const part = itemPart(item, cwd);
      if (item.type === "collabAgentToolCall") {
        if (item.tool === "spawnAgent" && part?.type === "tool") for (const c of item.receiverThreadIds ?? []) spawns.set(c, part);
        else
          for (const [c, st] of Object.entries<any>(item.agentsStates ?? {})) {
            const sp = spawns.get(c);
            if (sp && st?.message) sp.output = st.message;
          }
      }
      if (!shown(part)) continue;
      if (!a) out.push((a = { id: `a-${item.id}`, role: "assistant", parts: [], ts, ...(model ? { model } : {}) }));
      a.parts.push(part);
    }
    const err = turnError(turn);
    if (err) {
      if (a) a.error = err;
      else out.push({ id: `e-${turn.id}`, role: "assistant", ts, parts: [], error: err });
    }
  }
  return out;
}

