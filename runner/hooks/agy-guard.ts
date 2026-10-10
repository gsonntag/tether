// Antigravity PreToolUse hook (agy-customizations/docs/hooks.md): asks the Tether guard about each
// tool call. The runner passes it to the agy processes it starts (`--add-dir` of a folder holding
// `.agents/hooks.json`, see adapters/antigravity.ts); nothing is installed into ~/.gemini. Those
// processes run with --dangerously-skip-permissions, so this hook is the only gate: without the
// guard's environment it blocks everything.
//
// stdin: {toolCall: {name, args}, stepIdx, conversationId, modelName, transcriptPath,
//         artifactDirectoryPath, workspacePaths}
// stdout: {decision: "allow" | "deny", reason?, overwrite?}
const input: any = await Bun.stdin.json().catch(() => ({}));
const out = (o: object) => console.log(JSON.stringify(o));
const url = process.env.TETHER_GUARD_URL;
if (!url) {
  out({ decision: "deny", reason: "The Tether guard isn't reachable from this process; blocked to be safe." });
} else {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.TETHER_GUARD_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        key: process.env.TETHER_GUARD_KEY,
        tool: input.toolCall?.name,
        input: input.toolCall?.args ?? {},
        toolId: input.stepIdx != null ? `agy-${input.stepIdx}` : undefined,
        meta: {
          step: input.stepIdx,
          conversationId: input.conversationId,
          modelName: input.modelName,
          transcriptPath: input.transcriptPath,
          artifactDirectoryPath: input.artifactDirectoryPath,
        },
      }),
    });
    const v: any = await res.json();
    out(
      v.allow
        ? { decision: "allow", reason: v.reason, ...(v.overwrite ? { overwrite: v.overwrite } : {}) }
        : { decision: "deny", reason: v.reason || "Blocked by the Tether guard." },
    );
  } catch (e: any) {
    out({ decision: "deny", reason: `Tether guard unreachable (${e?.message ?? e}); blocked to be safe.` });
  }
}
