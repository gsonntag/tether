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

/** The MCP connection states in which a server can't be called: anything else (null included) counts as on. */
const OFF_STATES = new Set(["disabled", "failed", "cancelled"]);

/**
 * After a read-only thread is loaded: the daemon's own word, page by page, that every MCP server it
 * knows for the thread is off (a thread another client had loaded keeps that client's config).
 * Anything else, or no answer, fails. Only what the daemon reports per thread can be checked:
 * config/read takes no thread, so the features turned off at load (apps, plugins, hooks) can't be read
 * back; apps would show here as their own server.
 */
export async function assertNoMcp(call: (method: string, params: unknown) => Promise<any>, threadId: string): Promise<void> {
  const on: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= 50) throw new Error("Couldn't check that a read-only side chat has no MCP servers: too many pages.");
    let r: any;
    try {
      r = await call("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}) });
    } catch (e) {
      throw new Error(`Couldn't check that a read-only side chat has no MCP servers: ${(e as Error)?.message ?? e}`);
    }
    if (!Array.isArray(r?.data)) throw new Error("Couldn't check that a read-only side chat has no MCP servers.");
    for (const s of r.data) if (!OFF_STATES.has(s?.runtimeStatus) || Object.keys(s?.tools ?? {}).length > 0) on.push(String(s?.name));
    if (typeof r.nextCursor !== "string" || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  if (on.length) throw new Error(`A read-only side chat can't run with MCP servers on (${on.join(", ")}). Close it and open a new one.`);
}

export const READ_ONLY_INSTRUCTIONS = "You are in a read-only side chat beside the person's main session. Answer their questions by reading: you can't change files or anything else. If something needs changing, say what, for the main session to do.";
