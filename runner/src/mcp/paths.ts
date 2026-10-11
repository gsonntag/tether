// Where the MCP registry keeps its state: Tether's runner config dir, never a harness config.
//   servers.json   the registry (env and headers can hold secrets: mode 600)
//   exports.json   the ledger of entries Tether wrote into harness configs (export.ts)
//   tokens.json    reserved for OAuth tokens (Decision 8; mode 600, never written into harness configs)

import { join } from "node:path";
import { configDir } from "../context/paths";

export const mcpDir = () => join(configDir(), "mcp");
export const serversFile = () => join(mcpDir(), "servers.json");
export const ledgerFile = () => join(mcpDir(), "exports.json");
export const tokensFile = () => join(mcpDir(), "tokens.json");
