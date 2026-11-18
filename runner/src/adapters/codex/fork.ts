// Forking a Codex thread (SPEC §16): the app-server's `thread/fork`, which copies the thread into a
// new one through a given turn (`lastTurnId`, inclusive), writes its rollout at once and starts no
// turn (checked on 0.164: the fork is idle, its turns keep their ids, `forkedFromId` names the
// original). So "Fork from here" needs no rollback: the turns after it are never copied.
//
// A fork point is a transcript message id (shared/fork.ts): `a-<item>`, an assistant message made of
// the items from <item> on. It must end its turn: a reply followed by a message steered into the same
// turn can't be one, as the fork would take the whole turn.
//
// A thread on a key's private app-server stays there (SPEC, Credentials and billing safety), and one
// private process serves one thread: such a session is copied with §15's import instead (copyInstead).

import type { AdapterFork, ForkRequest } from "../../core/adapter";
import { threadTurns } from "./discovery";
import { remember, remembered } from "./remember";
import { threadCall } from "./sources";

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
  copyInstead: (nativeId) => !!remembered(nativeId)?.source,

  async fork({ nativeId, upTo, title }: ForkRequest) {
    if (remembered(nativeId)?.source) throw new Error("A thread on a key's own Codex process is copied, not forked.");
    const turns = await threadTurns(nativeId);
    const lastTurnId = upTo ? forkTurn(turns, upTo) : turns.at(-1)?.id;
    if (!lastTurnId) throw new Error("Nothing to fork yet.");
    const r: any = await threadCall(nativeId, "thread/fork", { threadId: nativeId, lastTurnId, excludeTurns: true });
    const id: string | undefined = r?.thread?.id;
    if (!id) throw new Error("Codex didn't make the fork.");
    try {
      const got = await threadTurns(id);
      if (got.at(-1)?.id !== lastTurnId) throw new Error("The fork didn't read back as the conversation.");
      await threadCall(id, "thread/name/set", { threadId: id, name: title });
      // What Tether knows of the original that the fork's history shares: an imported history at its
      // start, a source change's earlier thread, and the source its latest start confirmed (shown
      // until the fork's own first start says).
      const was = remembered(nativeId);
      remember(id, { ...(was?.billing ? { billing: was.billing } : {}), ...(was?.imported ? { imported: true } : {}), ...(was?.carriedFrom ? { carriedFrom: was.carriedFrom } : {}) });
    } catch (e) {
      await forget(id);
      throw e;
    }
    return id;
  },
};
