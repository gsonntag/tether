import { useEffect, useState } from "react";
import type { RunnerSettings } from "../../../shared/protocol";
import { rpc } from "../connection";
import { useStore } from "../store";

/** How agents run on a runner: whether Claude's subagents always go to the background, and whether sessions keep their replies short. */
export function AgentSettings({ runnerId }: { runnerId: string }) {
  const link = useStore((s) => s.link);
  const [settings, setSettings] = useState<RunnerSettings>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    setSettings(undefined);
    if (link === "open") void rpc(runnerId, "runnerSettings", {}).then((s) => { if (!gone) { setSettings(s); setError(undefined); } }).catch(() => { if (!gone) setError("Couldn't load settings. Update and restart the runner."); });
    return () => { gone = true; };
  }, [runnerId, link]);
  const toggle = async (patch: RunnerSettings) => {
    setBusy(true);
    setError(undefined);
    try { setSettings(await rpc(runnerId, "setRunnerSettings", patch)); } catch (e) { setError((e as Error)?.message || "Couldn't change the setting."); } finally { setBusy(false); }
  };
  if (!settings) return <>{error ? <div className="t-inline-status error" role="alert">{error}</div> : <div className="t-inline-status">Loading…</div>}</>;
  return <>
    {error && <div className="t-inline-status error" role="alert">{error}</div>}
    <label className="t-check">
      <input type="checkbox" checked={settings.backgroundSubagents === true} disabled={busy || link !== "open"} onChange={(e) => void toggle({ backgroundSubagents: e.target.checked })} />
      Always run Claude subagents in the background
    </label>
    <label className="t-check">
      <input type="checkbox" checked={settings.conciseReplies !== false} disabled={busy || link !== "open"} onChange={(e) => void toggle({ conciseReplies: e.target.checked })} />
      Concise replies: sessions end each turn with a short answer, outcome first
    </label>
  </>;
}
