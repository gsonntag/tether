// Claude Code's permission prompts as Tether requests (SPEC §6, §7), and the answers back. The SDK
// routes every prompt through canUseTool: tool approvals, AskUserQuestion (a question with options),
// and ExitPlanMode (approving a plan: Claude Code leaves plan mode for "Ask first" by itself, or for
// another mode when the approval says so). Pure, so it is tested without a process.

import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { RequestQuestion } from "../../../../shared/transcript";
import type { Decision, RequestAsk } from "../../core/adapter";
import { classifyTool } from "../toolKind";

/** The canUseTool options Tether reads. */
export interface AskOptions {
  toolUseID?: string;
  title?: string;
  description?: string;
  displayName?: string;
  decisionReason?: string;
  blockedPath?: string;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

function questionsOf(input: Record<string, unknown>): RequestQuestion[] {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs
    .filter((q: any) => typeof q?.question === "string")
    .map((q: any) => ({
      question: q.question,
      ...(str(q.header) ? { header: q.header } : {}),
      options: (Array.isArray(q.options) ? q.options : []).filter((o: any) => typeof o?.label === "string").map((o: any) => ({ label: o.label, ...(str(o.description) ? { description: o.description } : {}) })),
      ...(q.multiSelect ? { multiSelect: true } : {}),
    }));
}

/** A canUseTool call as a request. */
export function claudeAsk(tool: string, input: Record<string, unknown>, o: AskOptions = {}): RequestAsk {
  const base = { tool, input, ...(o.toolUseID ? { toolId: o.toolUseID } : {}) };
  if (tool === "AskUserQuestion") {
    const questions = questionsOf(input);
    const first = questions[0];
    return { ...base, kind: "question", question: first?.question ?? "Claude has a question.", options: first?.options.map((x) => x.label) ?? [], questions };
  }
  if (tool === "ExitPlanMode")
    return {
      ...base,
      kind: "approval",
      title: "Claude's plan is ready",
      plan: str(input.plan) ?? "",
      approveAs: [{ id: "acceptEdits", label: "Approve and accept edits", description: "Leave plan mode; file edits go ahead without asking" }],
    };
  const reason = str(o.decisionReason) ?? (o.blockedPath ? `It touches ${o.blockedPath}, outside the folders Claude may use.` : undefined);
  const { kind: toolKind, ...tags } = classifyTool(tool, input);
  return { ...base, kind: "approval", toolKind, ...tags, ...(str(o.title) ? { title: o.title } : {}), ...(reason ? { reason } : {}) };
}

/** What canUseTool answers for a decision. */
export function claudeResult(ask: RequestAsk, input: Record<string, unknown>, d: Decision): PermissionResult {
  if (!d.allow) return { behavior: "deny", message: d.reason, ...(d.interrupt ? { interrupt: true } : {}) };
  if (ask.kind === "question") {
    const answers: Record<string, string> = {};
    (ask.questions ?? []).forEach((q, i) => {
      const a = d.answers?.[i]?.trim();
      if (a) answers[q.question] = a;
    });
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
  return { behavior: "allow", updatedInput: input, ...(d.mode ? { updatedPermissions: [{ type: "setMode", mode: d.mode as any, destination: "session" }] } : {}) };
}
