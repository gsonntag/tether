// Which runner ids a runner's service token may claim in its hello. The relay routes rpcs (API keys
// typed into Credentials among them) to whichever connection holds an id, and a newer connection
// with the same id replaces the old one. Without this rule any runner token could take over
// another runner's id. The rule needs no server state, so a restart can't be used to squat an id:
//
// - a token named N may claim N itself, or anything starting with "N:";
// - the original owner token, named exactly "runner", may also claim any id that doesn't start
//   with "runner-" (existing runners use generated ids, e.g. a UUID, so they keep working with no
//   migration), and so can never reach another token's namespace like runner-alice.

export const OWNER_RUNNER_TOKEN = "runner";

export function runnerIdAllowed(tokenName: string, id: string): boolean {
  if (!tokenName) return false;
  if (id === tokenName || id.startsWith(`${tokenName}:`)) return true;
  return tokenName === OWNER_RUNNER_TOKEN && !id.startsWith("runner-");
}

/** WebSocket close reasons are at most 123 bytes of UTF-8. */
export const CLOSE_REASON_BYTES = 123;

/** Cuts a close reason to fit, never in the middle of a character. */
export function fitCloseReason(reason: string, max = CLOSE_REASON_BYTES): string {
  const enc = new TextEncoder();
  if (enc.encode(reason).length <= max) return reason;
  let out = "";
  for (const ch of reason) {
    if (enc.encode(out + ch + "…").length > max) break;
    out += ch;
  }
  return out + "…";
}

/** What the runner is told (and logs) when its id is refused: which ids its token may use. */
export function runnerIdRefusal(tokenName: string, id: string): string {
  const shortId = id.length > 24 ? `${id.slice(0, 24)}…` : id;
  const allowed = tokenName === OWNER_RUNNER_TOKEN ? `any id not starting with "runner-"` : `"${tokenName}" or "${tokenName}:<anything>"`;
  return fitCloseReason(`runner id "${shortId}" isn't allowed for token "${tokenName}": use ${allowed}`);
}
