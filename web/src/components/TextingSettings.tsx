import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import type { ConnectorForm, ConnectorStatus, MessagingStatus } from "../../../shared/protocol";
import { rpc } from "../connection";
import { useStore } from "../store";
import { isUnknownOp, legacyMessaging, legacySet } from "../messagingLegacy";

/**
 * Messaging, per runner: each connector (iMessage through Photon, a Discord bot, …) that texts you
 * when a session needs you, asks you something or fails, and takes your replies back to the session.
 * The runner says what each one needs (its forms); secrets stay on the runner, and this only sees
 * whether they're set.
 */
export function TextingSettings({ runnerId }: { runnerId: string }) {
  const link = useStore((s) => s.link);
  const [status, setStatus] = useState<MessagingStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  /** the runner predates connectors: iMessage through its old ops */
  const [legacy, setLegacy] = useState(false);

  useEffect(() => {
    let gone = false;
    setStatus(undefined);
    setLegacy(false);
    const done = (s: MessagingStatus, old: boolean) => { if (!gone) { setStatus(s); setLegacy(old); setError(undefined); } };
    if (link === "open")
      void rpc(runnerId, "messagingStatus", {})
        .then((s) => done(s, false))
        // Only a runner from before connectors (it doesn't know the op) gets the old iMessage ops.
        .catch((e) => (isUnknownOp(e, "messagingStatus") ? rpc(runnerId, "textingStatus", {}).then((s) => done(legacyMessaging(s), true)) : Promise.reject(e)))
        .catch((e) => { if (!gone) setError(isUnknownOp(e, "textingStatus") || !(e as Error)?.message ? "Couldn't load messaging. Update and restart the runner." : `Couldn't load messaging: ${(e as Error).message}`); });
    return () => { gone = true; };
  }, [runnerId, link]);
  /** The runner's ops, or the old iMessage ones on an old runner. */
  const ops = {
    set: (id: string, args: { enabled?: boolean; values?: Record<string, string> }): Promise<MessagingStatus> =>
      legacy ? rpc(runnerId, "setTexting", legacySet(args)).then(legacyMessaging) : rpc(runnerId, "setConnector", { id, ...args }),
    test: (id: string): Promise<null> => (legacy ? rpc(runnerId, "textingTest", {}) : rpc(runnerId, "testConnector", { id })),
  };

  const disabled = busy || link !== "open";
  /** Runs a change; whether it went (its error shows under the connector it was for). */
  const run = async (f: () => Promise<MessagingStatus | null>, onError: (e: string | undefined) => void) => {
    setBusy(true);
    onError(undefined);
    try {
      const s = await f();
      if (s) setStatus(s);
      return true;
    } catch (e) {
      onError((e as Error)?.message || "Couldn't update messaging.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <>{error ? <div className="t-inline-status error" role="alert">{error}</div> : <div className="t-inline-status">Loading…</div>}</>;
  const on = status.connectors.filter((c) => c.enabled);
  // A preference for a connector that's since been turned off stays clearable.
  const stale = status.prefer ? status.connectors.find((c) => c.id === status.prefer && !c.enabled) : undefined;

  return <>
    {error && <div className="t-inline-status error" role="alert">{error}</div>}
    <p className="t-inline-status">
      Get a message when a session needs you, asks you something or fails (not while you're looking at it in Tether), with what it wants and a link. Reply y or n to a request, or write to the agent: its answer comes back the same way. Each message starts with its session's number, like [2]; start a reply with the number to pick the session. When it isn't clear, Tether sends back a list to choose from.
    </p>
    {(on.length > 1 || stale) && (
      <label className="t-field">Send to<select className="t-select" value={status.prefer ?? ""} disabled={disabled} onChange={(e) => void run(() => rpc(runnerId, "setMessagingPrefer", { prefer: e.target.value || null }), setError)}>
        <option value="">Wherever I last wrote{status.lastUsed ? ` (${status.connectors.find((c) => c.id === status.lastUsed)?.label ?? status.lastUsed})` : ""}</option>
        {on.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        {stale && <option value={stale.id}>{stale.label} (off)</option>}
      </select></label>
    )}
    {status.connectors.map((c) => <Connector key={c.id} c={c} ops={ops} disabled={disabled} run={run} />)}
  </>;
}

function Connector({ c, ops, disabled, run }: { c: ConnectorStatus; ops: { set: (id: string, args: { enabled?: boolean; values?: Record<string, string> }) => Promise<MessagingStatus>; test: (id: string) => Promise<null> }; disabled: boolean; run: (f: () => Promise<MessagingStatus | null>, onError: (e: string | undefined) => void) => Promise<boolean> }) {
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const set = (args: { enabled?: boolean; values?: Record<string, string> }) => {
    setNote(undefined);
    return run(() => ops.set(c.id, args), setError);
  };
  const state = !c.enabled ? "Off" : !c.configured ? "Not set up" : c.connected ? "Connected" : "Not connected";
  return (
    <section className="t-credential-harness" aria-label={c.label}>
      <Heading level={3}>{c.label}</Heading>
      {error && <div className="t-inline-status error" role="alert">{error}</div>}
      <div className="t-credential-slot">
        <div className="t-credential-title"><span>{c.label}</span><span className="t-credential-status">{state}{c.lastError ? ` · ${c.lastError}` : ""}</span></div>
        <div className="t-credential-entry">
          <Button label={c.enabled ? "Turn off" : "Turn on"} variant={c.enabled ? "secondary" : "primary"} isDisabled={disabled} onClick={() => void set({ enabled: !c.enabled })} />
          {/* Also while it's down: the test says why it can't connect. */}
          {c.enabled && c.configured && <Button label="Send a test" variant="secondary" isDisabled={disabled} onClick={() => { setNote(undefined); void run(() => ops.test(c.id), setError).then((ok) => ok && setNote("Sent. It should arrive in a moment.")); }} />}
        </div>
        {note && <div className="t-inline-status">{note}</div>}
      </div>
      {c.forms.map((f) => <Form key={f.key} id={`${c.id}-${f.key}`} f={f} disabled={disabled} save={(values) => set({ values })} />)}
      {c.about && <p className="t-inline-status">{c.about}</p>}
    </section>
  );
}

/** Some of a connector's settings, saved together; a secret is write-only. */
function Form({ id, f, disabled, save }: { id: string; f: ConnectorForm; disabled: boolean; save: (values: Record<string, string>) => Promise<boolean> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const locked = disabled || !!f.fromEnv;
  const ready = f.inputs.every((i) => i.optional || (values[i.key] ?? "").trim()) && f.inputs.some((i) => (values[i.key] ?? "").trim());
  return (
    <form className="t-credential-slot" aria-label={f.label} autoComplete="off" onSubmit={(e) => {
      e.preventDefault();
      if (locked || !ready) return;
      void save(Object.fromEntries(f.inputs.map((i) => [i.key, values[i.key] ?? ""]))).then((ok) => ok && setValues({}));
    }}>
      <div className="t-credential-title"><label htmlFor={`${id}-0`}>{f.label}</label><span className="t-credential-status">{f.status}</span></div>
      <div className="t-credential-entry">
        {f.inputs.map((i, n) => (
          <input
            key={i.key}
            id={`${id}-${n}`}
            className="t-search"
            type={i.secret ? "password" : (i.type ?? "text")}
            placeholder={i.placeholder}
            aria-label={i.placeholder}
            value={values[i.key] ?? ""}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            {...(i.secret ? { autoComplete: "new-password" } : {})}
            disabled={locked}
            onChange={(e) => setValues((v) => ({ ...v, [i.key]: e.target.value }))}
          />
        ))}
        <Button label="Save" variant="primary" type="submit" isDisabled={locked || !ready} />
        {f.unset && <Button label="Unset" variant="secondary" isDisabled={locked} onClick={() => void save(Object.fromEntries(f.inputs.map((i) => [i.key, ""])))} />}
      </div>
      {f.note && <div className="t-inline-status">{f.note}</div>}
    </form>
  );
}
