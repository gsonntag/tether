// Antigravity hook (agy-customizations/docs/hooks.md): asks the Tether guard about each tool call.
// The runner passes it to the agy processes it starts (`--add-dir` of a folder holding
// `.agents/hooks.json`, see adapters/antigravity.ts); nothing is installed into ~/.gemini. Those
// processes run with --dangerously-skip-permissions, so this hook is the only gate. It fails closed:
// anything but the guard's explicit allow is a deny (agy treats a crash, a timeout or unparsable
// output as a denial too; the command in hooks.json also turns empty output into one).
//
// PreToolUse   stdin: {toolCall: {name, args}, stepIdx, conversationId, modelName, transcriptPath,
//                      artifactDirectoryPath, workspacePaths}
//              stdout: {decision: "allow" | "deny", reason?, overwrite?}
// PreInvocation stdin: {invocationNum, initialNumSteps, conversationId, …}; stdout: {}
//              Tells the runner the hook is loaded before each model request: a session whose model
//              answers without it is running unguarded and gets stopped.
const input: any = await Bun.stdin.json().catch(() => ({}));
const out = (o: object) => console.log(JSON.stringify(o));
const deny = (reason: string) => out({ decision: "deny", reason });
const url = process.env.TETHER_GUARD_URL;
const post = (body: object) =>
  fetch(url!, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.TETHER_GUARD_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ key: process.env.TETHER_GUARD_KEY, ...body }),
  });
const meta = {
  step: input.stepIdx,
  conversationId: input.conversationId,
  modelName: input.modelName,
  transcriptPath: input.transcriptPath,
  artifactDirectoryPath: input.artifactDirectoryPath,
};

if (input.invocationNum !== undefined && !input.toolCall) {
  // PreInvocation: agy ignores this hook's failures, so there is nothing to deny here.
  if (url) await post({ event: "invocation", meta: { ...meta, invocationNum: input.invocationNum } }).catch(() => {});
  out({});
} else if (typeof input.toolCall?.name !== "string" || !input.toolCall.name) {
  deny("Tether's guard hook couldn't read this tool call; blocked to be safe.");
} else if (!url) {
  deny("The Tether guard isn't reachable from this process; blocked to be safe.");
} else {
  try {
    const res = await post({
      tool: input.toolCall.name,
      input: input.toolCall.args ?? {},
      toolId: input.stepIdx != null ? `agy-${input.stepIdx}` : undefined,
      meta,
    });
    const v: any = await res.json();
    if (v?.allow === true) out({ decision: "allow", reason: v.reason, ...(v.overwrite ? { overwrite: v.overwrite } : {}) });
    else deny(v?.reason || "Blocked by the Tether guard.");
  } catch (e: any) {
    deny(`Tether guard unreachable (${e?.message ?? e}); blocked to be safe.`);
  }
}
