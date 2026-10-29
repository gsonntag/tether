// Tether's session id is `${harness}:${nativeId}` (SPEC §4).

import { HARNESS_LABELS, type HarnessId } from "./transcript";

export const sessionId = (harness: HarnessId, nativeId: string) => `${harness}:${nativeId}`;

export function parseSessionId(id: string): { harness: HarnessId; nativeId: string } | null {
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1) return null;
  const harness = id.slice(0, i);
  if (!(harness in HARNESS_LABELS)) return null;
  return { harness: harness as HarnessId, nativeId: id.slice(i + 1) };
}
