// A side chat on Codex (SPEC §16a): its thread runs in a read-only sandbox with no approvals, which
// Codex enforces itself, but MCP servers and apps run outside the sandbox. So a read-only thread is
// loaded (thread/fork, thread/resume) with every MCP server the person's config names turned off by
// name (read from config/read, as at load), apps and subagents off, and without Tether's own server.
// Failing to read the config fails the load: nothing runs with servers that might write.

/** Codex features that act outside the sandbox. */
const OFF = { "features.apps": false, "features.plugins": false, "features.multi_agent": false, "features.hooks": false } as const;

/** What a read-only thread is loaded with: its sandbox, no approvals, and the config above. */
export async function readOnlyLoad(call: (method: string, params: unknown) => Promise<any>, projectPath: string): Promise<Record<string, unknown>> {
  let cfg: any;
  try {
    cfg = await call("config/read", { cwd: projectPath });
  } catch (e) {
    throw new Error(`Couldn't read Codex's config to turn its MCP servers off for a read-only side chat: ${(e as Error)?.message ?? e}`);
  }
  const servers = cfg?.config?.mcp_servers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null)) throw new Error("Codex's config has MCP servers Tether can't read: a read-only side chat can't start.");
  const mcpOff = Object.fromEntries(Object.keys(servers ?? {}).map((name) => [`mcp_servers.${name}.enabled`, false]));
  return { sandbox: "read-only", approvalPolicy: "never", config: { ...OFF, ...mcpOff }, developerInstructions: READ_ONLY_INSTRUCTIONS };
}

/** MCP connection states in which a server can be called. */
const LIVE = new Set(["starting", "connected", "authenticationRequired"]);

/**
 * After a read-only thread is loaded: the daemon's own word that none of its MCP servers runs (a
 * thread another client had loaded keeps that client's config). Anything else, or no answer, fails.
 */
export async function assertNoMcp(call: (method: string, params: unknown) => Promise<any>, threadId: string): Promise<void> {
  let r: any;
  try {
    r = await call("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly" });
  } catch (e) {
    throw new Error(`Couldn't check that a read-only side chat has no MCP servers: ${(e as Error)?.message ?? e}`);
  }
  if (!Array.isArray(r?.data)) throw new Error("Couldn't check that a read-only side chat has no MCP servers.");
  const on = r.data.filter((s: any) => LIVE.has(s?.runtimeStatus) || Object.keys(s?.tools ?? {}).length > 0).map((s: any) => String(s?.name));
  if (on.length) throw new Error(`A read-only side chat can't run with MCP servers on (${on.join(", ")}). Close it and open a new one.`);
}

export const READ_ONLY_INSTRUCTIONS = "You are in a read-only side chat beside the person's main session. Answer their questions by reading: you can't change files or anything else. If something needs changing, say what, for the main session to do.";
