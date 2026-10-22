/** A path relative to the project, or with ~ for the home folder. */
export const relTo = (p: string, root?: string) => {
  const r = root?.replace(/\/$/, "");
  if (r && p.startsWith(r + "/")) return p.slice(r.length + 1);
  return p.replace(/^\/home\/[^/]+/, "~");
};

/**
 * What the call is, in words (the approval card's header): what it does and what it does it to.
 * `hasEdits`: the input carries changes to an existing file (Transcript's `edits`), so a
 * write/create tool is editing, not writing a new file.
 */
export function describeCall(name: string, input: any, root?: string, hasEdits = false): { verb: string; command?: string; path?: string; server?: string } {
  const command = input?.command ?? input?.CommandLine ?? input?.cmd;
  if (typeof command === "string" || Array.isArray(command)) return { verb: "wants to run", command: Array.isArray(command) ? command.join(" ") : command };
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return { verb: `wants to call ${mcp[1]}`, server: mcp[2] };
  const p = input?.file_path ?? input?.filePath ?? input?.path ?? input?.notebook_path ?? input?.TargetFile;
  if (typeof p === "string") {
    const write = /write|create/i.test(name) && !hasEdits;
    return { verb: `wants to ${write ? "write" : /^(read|view)/i.test(name) ? "read" : "edit"} ${relTo(p, root)}`, path: p };
  }
  if (typeof input?.url === "string") return { verb: `wants to fetch ${input.url}` };
  return { verb: `wants to use ${name}` };
}
