// Forking a Claude Code session (SPEC §16): the Agent SDK's forkSession, a file operation that copies
// the transcript into a new session file with fresh entry ids, through one entry when asked. No
// process starts and nothing is billed. The original's file isn't touched.
//
// A fork point is a transcript message id (shared/fork.ts): an assistant message's API message id,
// which Claude Code writes as one entry per content block. The fork goes through the last of them,
// so the reply is whole; what follows (the turn's bookkeeping entries) is left out. The SDK keeps
// each copied message's API id, so the fork's transcript ends on the same message id (a whole fork:
// has as many messages). That's checked, and a fork that doesn't is removed.

import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { rmSync } from "node:fs";
import type { AdapterFork, ForkRequest } from "../../core/adapter";
import { keepBilling, keptBilling } from "./context";
import { messageId } from "./content";
import { readHistory } from "./history";
import { readStore, type Entry } from "./jsonl";
import { sessionFile, splitNative } from "./paths";
import type { Msg } from "../../../../shared/transcript";

/** The entry a fork through transcript message `upTo` ends at: the last entry of that message. */
export function forkEntry(chain: Entry[], upTo: string): string | undefined {
  // Only Claude Code's own "<synthetic>" replies aren't in the transcript as replies; a moved-in
  // reply ("<moved>", move.ts) is, and can end a fork.
  return chain.findLast((e) => e.type === "assistant" && e.message?.model !== "<synthetic>" && messageId(e.message?.id, e.uuid) === upTo)?.uuid;
}

const remove = (nativeId: string, projectPath: string) => {
  const f = sessionFile(nativeId, projectPath);
  if (f) rmSync(f, { force: true });
};

export const claudeFork: AdapterFork = {
  discard: async (nativeId, projectPath) => remove(nativeId, projectPath),

  async fork({ nativeId, projectPath, upTo, title }: ForkRequest) {
    const { session, agent } = splitNative(nativeId);
    if (agent) throw new Error("A subagent can't be forked.");
    const file = sessionFile(session, projectPath);
    if (!file) throw new Error("That session isn't stored yet.");
    let at: string | undefined;
    if (upTo) {
      at = forkEntry((await readStore(file)).chain(), upTo);
      if (!at) throw new Error("That message isn't in the session's store.");
    }
    const { sessionId } = await forkSession(session, { dir: projectPath, title, ...(at ? { upToMessageId: at } : {}) });
    try {
      const said = (msgs: Msg[]) => msgs.filter((m) => m.role !== "notice");
      const msgs = said(await readHistory(sessionId, projectPath));
      const ok = upTo ? msgs.at(-1)?.id === upTo : msgs.length > 0 && msgs.length === said(await readHistory(session, projectPath)).length;
      if (!ok) throw new Error("The fork didn't read back as the conversation.");
    } catch (e) {
      remove(sessionId, projectPath);
      throw e;
    }
    // The original's latest start, on the same source: shown until the fork's own first start confirms it.
    const billing = keptBilling(session);
    if (billing.kind !== "unknown") keepBilling(sessionId, billing);
    return sessionId;
  },
};
