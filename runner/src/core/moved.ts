// Where a moved session's whole history is kept (SPEC §15): a private folder per target session,
// outside any project. Here, not in the module, because a harness that needs telling may read it
// (Claude: a read rule, so reading it asks nothing); the core still doesn't know the module.

import { join } from "node:path";
import { CONFIG_DIR } from "../config";

export const movedBase = () => join(CONFIG_DIR, "modules", "move");
export const movedDir = (sessionId: string, base = movedBase()) => join(base, sessionId.replace(/[^\w.-]/g, "_"));
