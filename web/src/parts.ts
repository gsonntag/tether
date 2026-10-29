// Parts as they come off the wire, checked before rendering.

import type { Part } from "../../shared/transcript";

/** A part as it came off the wire, made safe to render: text that isn't a string becomes one. */
export function checked(part: Part): Part | null {
  if (!part || typeof part !== "object") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  switch (part.type) {
    case "text":
    case "thinking":
      return typeof part.text === "string" ? part : { ...part, text: str((part as any).text) };
    case "image":
      return typeof part.data === "string" ? part : { ...part, data: "" };
    case "tool":
      return typeof part.name === "string" && typeof part.id === "string" ? (part.output === undefined || typeof part.output === "string" ? part : { ...part, output: str(part.output) }) : null;
    default:
      return null;
  }
}

