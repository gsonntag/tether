// The New session dialog's folder rule (SPEC §4): a folder that isn't there starts nothing until
// the owner confirms it; one that can't be used starts nothing at all.

import type { FolderCheck } from "../../shared/protocol";

/** How long typing has to pause before the runner is asked. */
export const CHECK_DELAY_MS = 400;

/** No answer yet (or a runner too old to give one): the runner's own checks on newSession decide. */
export const folderBlocked = (check: FolderCheck | undefined, confirmed: boolean) =>
  !!check && check.state !== "exists" && !(check.state === "missing" && confirmed);
