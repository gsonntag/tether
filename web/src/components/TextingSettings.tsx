import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import type { TextingStatus } from "../../../shared/protocol";
import { rpc } from "../connection";
import { useStore } from "../store";

/**
 * Texting, per runner: iMessages through Photon when a session needs you, asks you something or fails, and
 * replies by text that go back to the session. The keys stay on the runner; this only sees whether
 * they're set.
 */
export function TextingSettings({ runnerId }: { runnerId: string }) {
  const link = useStore((s) => s.link);
  const [status, setStatus] = useState<TextingStatus>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectSecret, setProjectSecret] = useState("");

  useEffect(() => {
    let gone = false;
    setStatus(undefined);
    if (link === "open") void rpc(runnerId, "textingStatus", {}).then((s) => { if (!gone) { setStatus(s); setError(undefined); } }).catch(() => { if (!gone) setError("Couldn't load texting. Update and restart the runner."); });
    return () => { gone = true; };
  }, [runnerId, link]);

  const disabled = busy || link !== "open";
  const run = async (f: () => Promise<TextingStatus | null>, done?: string) => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      const s = await f();
      if (s) setStatus(s);
      if (done) setNote(done);
      return true;
    } catch (e) {
      setError((e as Error)?.message || "Couldn't update texting.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const set = (args: { enabled?: boolean; phone?: string; projectId?: string; projectSecret?: string }) => run(() => rpc(runnerId, "setTexting", args));

  if (!status) return <>{error ? <div className="t-inline-status error" role="alert">{error}</div> : <div className="t-inline-status">Loading…</div>}</>;
  const state = !status.enabled ? "Off" : !status.keysSet || !status.phoneLast4 ? "Not set up" : status.connected ? "Connected" : "Not connected";

  return <>
    {error && <div className="t-inline-status error" role="alert">{error}</div>}
    <p className="t-inline-status">
      Get an iMessage when a session needs you, asks you something or fails (not while you're looking at it in Tether), with what it wants and a link. Reply y or n to a request, or text the agent: its answer comes back by text. Each text starts with its session's number, like [2]; start a reply with the number to pick the session. When it isn't clear, Tether texts back a list to choose from.
    </p>
    <div className="t-credential-slot" aria-label="Texting">
      <div className="t-credential-title"><span>Texting</span><span className="t-credential-status">{state}{status.lastError ? ` · ${status.lastError}` : ""}</span></div>
      <div className="t-credential-entry">
        <Button label={status.enabled ? "Turn off" : "Turn on"} variant={status.enabled ? "secondary" : "primary"} isDisabled={disabled} onClick={() => void set({ enabled: !status.enabled })} />
        {status.enabled && status.connected && <Button label="Send a test" variant="secondary" isDisabled={disabled} onClick={() => void run(() => rpc(runnerId, "textingTest", {}), "Sent. It should arrive in a moment.")} />}
      </div>
      {note && <div className="t-inline-status">{note}</div>}
    </div>

    <form className="t-credential-slot" aria-label="Phone" autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (!disabled && phone.trim()) void set({ phone }).then((ok) => ok && setPhone("")); }}>
      <div className="t-credential-title"><label htmlFor="texting-phone">Your phone</label><span className="t-credential-status">{status.phoneLast4 ? `••••${status.phoneLast4}${status.fromEnv.phone ? " · from runner.env" : ""}` : "Not set"}</span></div>
      <div className="t-credential-entry">
        <input id="texting-phone" className="t-search" type="tel" placeholder="+13105551234" value={phone} disabled={disabled || status.fromEnv.phone} onChange={(e) => setPhone(e.target.value)} />
        <Button label="Save" variant="primary" type="submit" isDisabled={disabled || status.fromEnv.phone || !phone.trim()} />
      </div>
    </form>

    <form className="t-credential-slot" aria-label="Photon project" autoComplete="off" onSubmit={(e) => {
      e.preventDefault();
      if (disabled || !projectId.trim() || !projectSecret) return;
      void set({ projectId, projectSecret }).then((ok) => { if (ok) { setProjectId(""); setProjectSecret(""); } });
    }}>
      <div className="t-credential-title"><label htmlFor="texting-project">Photon project</label><span className="t-credential-status">{status.keysSet ? `Set${status.fromEnv.keys ? " · from runner.env" : ""}` : "Not set"}</span></div>
      <div className="t-credential-entry">
        <input id="texting-project" className="t-search" placeholder="Project ID" value={projectId} autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled || status.fromEnv.keys} onChange={(e) => setProjectId(e.target.value)} />
        <input className="t-search" type="password" placeholder="Project secret" aria-label="Project secret" value={projectSecret} autoComplete="new-password" disabled={disabled || status.fromEnv.keys} onChange={(e) => setProjectSecret(e.target.value)} />
        <Button label="Save" variant="primary" type="submit" isDisabled={disabled || status.fromEnv.keys || !projectId.trim() || !projectSecret} />
        {status.keysSet && !status.fromEnv.keys && <Button label="Unset" variant="secondary" isDisabled={disabled} onClick={() => void set({ projectId: "", projectSecret: "" })} />}
      </div>
    </form>
    <p className="t-inline-status">Phone must be added and verified on Photon dashboard</p>
  </>;
}
