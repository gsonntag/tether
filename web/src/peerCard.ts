// A peer tool's card (SPEC §9a), as words: what it did, to whom. ToolCard shows it.

import { peerAction, peerTarget } from "../../shared/peers";
import type { ToolPart } from "../../shared/transcript";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** A peer tool's card head: what it did, to whom (SPEC §9a). */
export function peerHead(p: ToolPart, title: string | undefined): { label: string; sum: string } {
  const i = (p.input ?? {}) as Record<string, any>;
  const who = title ? `“${title}”` : (str(i.to) ?? "");
  switch (peerAction(p.name)) {
    case "sessions":
      return { label: "Looked at sessions", sum: [str(i.project), str(i.query)].filter(Boolean).join(" · ") };
    case "send":
      return { label: p.status === "running" ? "Sending to" : p.status === "error" ? "Not sent to" : "Sent to", sum: who };
    case "ask":
      // Failed once asked (no answer, a failed or stopped turn): the answer names the session.
      return { label: p.status === "running" ? "Asking" : p.status !== "error" ? "Asked" : peerTarget(p.output) ? "Ask failed" : "Not asked", sum: who };
    case "broadcast":
      return { label: p.status === "error" ? "Not sent to all" : "Sent to all", sum: [str(i.project), str(i.status)].filter(Boolean).join(" · ") };
    default:
      return { label: p.name, sum: "" };
  }
}
