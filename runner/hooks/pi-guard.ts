// pi extension: send every tool call to the Tether guard before it runs.
// Loaded by the runner with `pi -e <this file>`; inert when not started by Tether.
export default function (pi: any) {
  const url = process.env.TETHER_GUARD_URL;
  if (!url) return;
  // Kept here and taken out of pi's environment, so the commands its tools run (bash) don't inherit
  // the session's key and token (they could speak for this session on Tether's bridge).
  const token = process.env.TETHER_GUARD_TOKEN;
  const key = process.env.TETHER_GUARD_KEY;
  delete process.env.TETHER_GUARD_URL;
  delete process.env.TETHER_GUARD_TOKEN;
  delete process.env.TETHER_GUARD_KEY;
  pi.on("tool_call", async (event: any) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ key, tool: event.toolName, input: event.input, toolId: event.toolCallId }),
      });
      const v: any = await res.json();
      if (!v.allow) return { block: true, reason: v.reason || "Blocked by the Tether guard." };
    } catch (e: any) {
      return { block: true, reason: `Tether guard unreachable (${e?.message ?? e}); blocked to be safe.` };
    }
  });
}
