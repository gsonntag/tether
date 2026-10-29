// Codex's approval requests and questions as Tether requests (SPEC §6, §7), and the answers back.
// The daemon sends them to every connection subscribed to the thread (Tether and Codex's own TUI
// alike); whichever answers first wins and the daemon tells the others (serverRequest/resolved).
// Pure, so it is tested without a daemon.

import type { RequestQuestion } from "../../../../shared/transcript";
import type { Decision, RequestAsk } from "../../core/adapter";
import { classifyTool } from "../toolKind";
import { patchInput, unwrapShell } from "./items";

/** A tool's kind and its command or path, as a request carries them. */
function tags(tool: string, input: unknown) {
  const { kind: toolKind, ...rest } = classifyTool(tool, input);
  return { toolKind, ...rest };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** The server requests Tether answers. */
export const ASKS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request"]);

/** The tool name a MCP approval is about (`mcp__server__tool`, as on the tool card). */
export function mcpApprovalTool(p: any): string {
  const name = p?._meta?.tool_name ?? /run tool "(.+)"\?\s*$/.exec(p?.message ?? "")?.[1] ?? p?._meta?.tool_title ?? "tool";
  return `mcp__${p?.serverName ?? "mcp"}__${name}`;
}

/**
 * A server request as a Tether request (undefined: not one Tether asks a person about, e.g. an MCP
 * form). `patch`: the fileChange item the approval is about (the request carries only its id).
 */
export function codexAsk(method: string, p: any, cwd: string, patch?: any): RequestAsk | undefined {
  const toolId = str(p?.itemId);
  const reason = str(p?.reason);
  const base = { ...(toolId ? { toolId } : {}), ...(reason ? { reason } : {}) };
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = unwrapShell(p.command ?? "");
      const input = { command, ...(p.cwd && p.cwd !== cwd ? { cwd: p.cwd } : {}), ...(p.additionalPermissions ? { permissions: p.additionalPermissions } : {}) };
      const net = p.networkApprovalContext?.host ? `Network access to ${p.networkApprovalContext.host}` : undefined;
      return { ...base, kind: "approval", tool: "bash", input, ...tags("bash", input), ...(net && !reason ? { reason: net } : {}) };
    }
    case "item/fileChange/requestApproval": {
      const input = patch ? patchInput(patch.changes ?? [], cwd) : { path: p.grantRoot ?? cwd, edits: [] };
      return { ...base, kind: "approval", tool: "apply_patch", input, ...tags("apply_patch", input), ...(p.grantRoot ? { title: `Write access to ${p.grantRoot}` } : {}) };
    }
    case "item/permissions/requestApproval":
      return { ...base, kind: "approval", tool: "request_permissions", input: { permissions: p.permissions ?? {}, ...(p.cwd ? { cwd: p.cwd } : {}) }, toolKind: "other", title: "More access for its sandbox" };
    case "item/tool/requestUserInput": {
      const questions: RequestQuestion[] = (p.questions ?? []).map((q: any) => ({
        question: q.question ?? "",
        ...(str(q.header) ? { header: q.header } : {}),
        options: (q.options ?? []).filter((o: any) => typeof o?.label === "string").map((o: any) => ({ label: o.label, ...(str(o.description) ? { description: o.description } : {}) })),
      }));
      const first = questions[0];
      return { ...base, kind: "question", tool: "request_user_input", input: { questions: p.questions ?? [] }, question: first?.question || "Codex has a question.", options: first?.options.map((o) => o.label) ?? [], questions };
    }
    case "mcpServer/elicitation/request": {
      if (p?._meta?.codex_approval_kind !== "mcp_tool_call") return undefined;
      const tool = mcpApprovalTool(p);
      return { kind: "approval", tool, input: p._meta?.tool_params ?? {}, toolKind: "other", ...(str(p.message) ? { title: p.message } : {}) };
    }
  }
  return undefined;
}

/** What the daemon gets back for a decision. */
export function codexAnswer(method: string, p: any, d: Decision): unknown {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      // "cancel" also stops the turn, as declining with Esc in Codex's TUI does.
      return { decision: d.allow ? "accept" : d.interrupt ? "cancel" : "decline" };
    case "item/permissions/requestApproval":
      return d.allow ? { permissions: { ...(p.permissions?.network ? { network: p.permissions.network } : {}), ...(p.permissions?.fileSystem ? { fileSystem: p.permissions.fileSystem } : {}) }, scope: "turn" } : { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput": {
      const answers: Record<string, { answers: string[] }> = {};
      if (d.allow)
        (p.questions ?? []).forEach((q: any, i: number) => {
          const a = d.answers?.[i]?.trim();
          if (a && q?.id) answers[q.id] = { answers: [a] };
        });
      return { answers };
    }
    case "mcpServer/elicitation/request":
      return { action: d.allow ? "accept" : d.interrupt ? "cancel" : "decline", content: null, _meta: null };
  }
  return undefined;
}

/** How an elicitation is declined. */
export const DECLINE_ELICITATION = { action: "decline", content: null, _meta: null };

/** The tool name of a request Tether can't show. */
export const CANT_SHOW = "codex_request";

/**
 * A request Tether can't show (an MCP form or link, a method it doesn't know): a card that says so
 * and points at the terminal, where Codex's TUI shows it. It stays open for the TUI to answer; from
 * Tether it can only be declined.
 */
export function cantShow(method: string, p: any): RequestAsk {
  const what = method === "mcpServer/elicitation/request" ? `${p?.serverName ?? "An MCP server"} ${p?.mode === "url" ? "wants you to open a link" : "needs some input"}` : `Codex is asking something (${method})`;
  const detail = [str(p?.message), str(p?.url)].filter(Boolean).join("\n");
  return {
    kind: "question",
    tool: CANT_SHOW,
    input: { method },
    question: `${what} that Tether can't show. Open the terminal to answer it there, or decline it here.`,
    options: ["Decline"],
    questions: [{ question: `${what} that Tether can't show. Open the terminal to answer it there, or decline it here.`, options: [{ label: "Decline" }] }],
    ...(detail ? { reason: detail } : {}),
  };
}
