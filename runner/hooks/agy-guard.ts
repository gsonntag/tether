// Antigravity PreToolUse hook (antigravity.google/docs/hooks): asks the Tether guard about
// each tool call. Installed into ~/.gemini/config/hooks.json by the runner (Settings → Guard).
// Outside Tether (no TETHER_GUARD_URL) it answers "ask", i.e. Antigravity's own behavior.
const input: any = await Bun.stdin.json().catch(() => ({}));
const out = (o: object) => console.log(JSON.stringify(o));
const url = process.env.TETHER_GUARD_URL;
if (!url) {
  out({ decision: "ask" });
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
      }),
    });
    const v: any = await res.json();
    out(v.allow ? { decision: "allow", reason: v.reason } : { decision: "deny", reason: v.reason || "Blocked by the Tether guard." });
  } catch (e: any) {
    out({ decision: "deny", reason: `Tether guard unreachable (${e?.message ?? e}); blocked to be safe.` });
  }
}
