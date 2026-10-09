// pi extension: send every tool call to the Tether guard before it runs.
// Loaded by the runner with `pi -e <this file>`; inert when not started by Tether.
export default function (pi: any) {
  const url = process.env.TETHER_GUARD_URL;
  if (!url) return;
  pi.on("tool_call", async (event: any) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.TETHER_GUARD_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ key: process.env.TETHER_GUARD_KEY, tool: event.toolName, input: event.input, toolId: event.toolCallId }),
      });
      const v: any = await res.json();
      if (!v.allow) return { block: true, reason: v.reason || "Blocked by the Tether guard." };
    } catch (e: any) {
      return { block: true, reason: `Tether guard unreachable (${e?.message ?? e}); blocked to be safe.` };
    }
  });
}
