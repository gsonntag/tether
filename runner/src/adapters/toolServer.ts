// The one Tether MCP server every session gets (core/adapter.ts ToolServer), kept per harness so
// each adapter can hand it to its harness when a session starts.

import type { ToolServer } from "../core/adapter";

export class ToolServerSlot {
  current?: ToolServer;

  set(server: ToolServer): () => void {
    this.current = server;
    return () => {
      if (this.current === server) this.current = undefined;
    };
  }

  /** The server for a session in `projectPath`, unless that folder is left out. */
  for(projectPath: string): ToolServer | undefined {
    const s = this.current;
    return s && !s.skip?.(projectPath) ? s : undefined;
  }
}
