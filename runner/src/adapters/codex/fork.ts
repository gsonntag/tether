// Forking a Codex thread (SPEC §16): the app-server's `thread/fork`, which copies the thread into a
// new one through a given turn (`lastTurnId`, inclusive), writes its own rollout at once and starts no
// turn (checked on daemon 0.169.1: the fork is idle, its turns keep their ids, `forkedFromId` names the
// original). So "Fork from here" needs no rollback: the turns after it are never copied.
//
// A fork point is a transcript message id (shared/fork.ts): `a-<item>`, an assistant message made of
// the items from <item> on. It must end its turn: a reply followed by a message steered into the same
// turn can't be one, as the fork would take the whole turn.
//
// The fork's rollout holds only its own lines: its session_meta points at the original's
// (`forked_from_id`, `forked_from_ordinal_exclusive`), which the daemon reads the history from
// (checked on daemon 0.169.1).
//
// Copied with §15's import instead (copyInstead): a thread on a key's private app-server, which
// stays there (SPEC, Credentials and billing safety) and serves one thread; and a thread with history
// brought in (a move's import, a source change's earlier thread), which isn't in its own turns and
// which Tether reads from the thread's own rollout head, so a fork wouldn't show it (checked: an
// imported thread's fork reads none back).

import type { AdapterFork, ForkRequest } from "../../core/adapter";
import { threadTurns } from "./discovery";
import { remember, remembered } from "./remember";
import { threadCall } from "./sources";
import { readOnlyLoad } from "./readOnly";

/** The turn a fork through transcript message `upTo` ends with. Throws when that message doesn't end one. */
export function forkTurn(turns: any[], upTo: string): string {
  const item = upTo.startsWith("a-") ? upTo.slice(2) : undefined;
  const turn = item ? turns.find((t) => (t.items ?? []).some((i: any) => i.id === item)) : undefined;
  if (!turn) throw new Error("That message can't be forked from. Fork from a later reply.");
  const items: any[] = turn.items ?? [];
  if (items.slice(items.findIndex((i) => i.id === item)).some((i) => i.type === "userMessage")) throw new Error("That reply is in the middle of a turn. Fork from the turn's last reply.");
  if (turn.status === "inProgress") throw new Error("That turn hasn't finished.");
  return turn.id;
}

const forget = (id: string) => threadCall(id, "thread/archive", { threadId: id }).catch(() => undefined);

export const codexFork: AdapterFork = {
  copyInstead: (nativeId) => {
    const r = remembered(nativeId);
    return !!(r?.source || r?.imported || r?.carriedFrom);
  },

  discard: async (nativeId) => void (await forget(nativeId)),

  async fork({ nativeId, projectPath, upTo, title, readOnly }: ForkRequest) {
    if (codexFork.copyInstead!(nativeId)) throw new Error("This thread is copied, not forked.");
    const turns = await threadTurns(nativeId);
    const lastTurnId = upTo ? forkTurn(turns, upTo) : turns.at(-1)?.id;
    if (!lastTurnId) throw new Error("Nothing to fork yet.");
    // A side chat is loaded read-only from the start (readOnly.ts): the daemon keeps a loaded thread's config.
    const load = readOnly ? await readOnlyLoad((m, p) => threadCall(nativeId, m, p), projectPath) : {};
    const r: any = await threadCall(nativeId, "thread/fork", { threadId: nativeId, lastTurnId, excludeTurns: true, ...load });
    const id: string | undefined = r?.thread?.id;
    if (!id) throw new Error("Codex didn't make the fork.");
    try {
      const got = await threadTurns(id);
      if (got.at(-1)?.id !== lastTurnId) throw new Error("The fork didn't read back as the conversation.");
      await threadCall(id, "thread/name/set", { threadId: id, name: title });
      // The source the original's latest start confirmed, shown until the fork's own first start says.
      const billing = remembered(nativeId)?.billing;
      if (billing) remember(id, { billing });
    } catch (e) {
      await forget(id);
      throw e;
    }
    return id;
  },
};
