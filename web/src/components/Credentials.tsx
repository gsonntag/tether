import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import type { TokenRates } from "../../../shared/costs";
import { rpc } from "../connection";
import { useStore } from "../store";

type Source = "anthropic" | "openai" | "azure";
type Status = { set: boolean; last4?: string; endpoint?: string; deployment?: string; rates?: TokenRates };
type CredentialsStatus = Record<Source, Status>;
const labels: Record<Source, string> = { anthropic: "Anthropic API key", openai: "OpenAI API key", azure: "Azure" };

export function Credentials() {
  const runners = useStore((s) => s.runners);
  const [chosen, setChosen] = useState("");
  const runner = runners.find((r) => r.id === chosen) ?? runners.find((r) => r.online) ?? runners[0];
  return (
    <main className="t-credentials">
      <Heading level={1}>Credentials</Heading>
      {runners.length > 1 && <label className="t-field">Runner<select className="t-select" value={runner?.id ?? ""} onChange={(e) => setChosen(e.target.value)}>{runners.map((r) => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}</select></label>}
      {!runner ? <div className="t-inline-status">No runner connected.</div> : !runner.online ? <div className="t-inline-status">Runner offline.</div> : <RunnerCredentials key={runner.id} runnerId={runner.id} />}
    </main>
  );
}

function RunnerCredentials({ runnerId }: { runnerId: string }) {
  const link = useStore((s) => s.link);
  const [status, setStatus] = useState<CredentialsStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    setStatus(undefined);
    if (link === "open") void rpc(runnerId, "credentials", {}).then((s) => { if (!gone) { setStatus(s); setError(undefined); } }).catch(() => { if (!gone) setError("Couldn't load credentials. Update and restart the runner."); });
    return () => { gone = true; };
  }, [runnerId, link]);
  const change = async (request: Promise<CredentialsStatus>) => {
    setBusy(true);
    setError(undefined);
    try { setStatus(await request); } catch { setError("Couldn't update credentials."); } finally { setBusy(false); }
  };
  return <>
    {error && <div className="t-inline-status error" role="alert">{error}</div>}
    {!status ? !error && <div className="t-inline-status">Loading…</div> : <>
      <section className="t-credential-harness"><Heading level={2}>Claude</Heading><CredentialSlot source="anthropic" status={status.anthropic} disabled={busy || link !== "open"} save={(a) => change(rpc(runnerId, "setCredential", a))} unset={() => change(rpc(runnerId, "unsetCredential", { source: "anthropic" }))} /></section>
      <section className="t-credential-harness"><Heading level={2}>Codex</Heading>{(["azure", "openai"] as const).map((source) => <CredentialSlot key={source} source={source} status={status[source]} disabled={busy || link !== "open"} save={(a) => change(rpc(runnerId, "setCredential", a))} unset={() => change(rpc(runnerId, "unsetCredential", { source }))} />)}</section>
    </>}
  </>;
}

function CredentialSlot({ source, status, disabled, save, unset }: { source: Source; status: Status; disabled: boolean; save: (args: { source: Source; key: string; endpoint?: string; deployment?: string; rates?: TokenRates }) => Promise<void>; unset: () => Promise<void> }) {
  const secret = useRef<HTMLInputElement>(null);
  const endpoint = useRef<HTMLInputElement>(null);
  const deployment = useRef<HTMLInputElement>(null);
  const rateInputs = useRef<Partial<Record<keyof TokenRates, HTMLInputElement | null>>>({});
  const requireRates = () => {
    const all = Object.values(rateInputs.current);
    const any = all.some((input) => !!input?.value);
    for (const input of all) if (input) input.required = any;
  };
  const [hasKey, setHasKey] = useState(false);
  const id = `credential-${source}`;
  return <form className="t-credential-slot" aria-label={labels[source]} autoComplete="off" onSubmit={(e) => {
    e.preventDefault();
    if (disabled || !secret.current?.value) return;
    requireRates();
    const rateFields = rateInputs.current;
    if (!e.currentTarget.reportValidity()) return;
    const rates = source === "azure" && rateFields.input?.value ? { input: Number(rateFields.input.value), output: Number(rateFields.output!.value), cached: Number(rateFields.cached!.value) } : undefined;
    const key = secret.current.value;
    secret.current.value = "";
    setHasKey(false);
    void save({ source, key, ...(source === "azure" ? { endpoint: endpoint.current?.value.trim(), deployment: deployment.current?.value.trim(), ...(rates ? { rates } : {}) } : {}) });
  }}>
    <div className="t-credential-title"><label htmlFor={id}>{labels[source]}</label><span className="t-credential-status">{status.set ? `Set${status.last4 ? ` · ••••${status.last4}` : ""}` : "Not set"}</span></div>
    {source === "azure" && <>
      <label className="t-field" htmlFor={`${id}-endpoint`}>Endpoint<input key={status.endpoint} ref={endpoint} id={`${id}-endpoint`} className="t-search" type="url" defaultValue={status.endpoint ?? ""} placeholder="https://…" autoComplete="off" disabled={disabled} required /></label>
      <label className="t-field" htmlFor={`${id}-deployment`}>Deployment<input key={status.deployment} ref={deployment} id={`${id}-deployment`} className="t-search" defaultValue={status.deployment ?? ""} autoComplete="off" disabled={disabled} /></label>
      <details className="t-credential-rates"><summary>USD / 1M tokens</summary><div className="t-rate-fields">{([['input', 'Input'], ['cached', 'Cached input'], ['output', 'Output']] as const).map(([name, label]) => <label className="t-field" key={name} htmlFor={`${id}-${name}-rate`}>{label}<input key={String(status.rates?.[name])} ref={(input) => { rateInputs.current[name] = input; }} id={`${id}-${name}-rate`} className="t-search" type="number" min="0" max="1000000" step="any" defaultValue={status.rates?.[name] ?? ""} placeholder="Optional" autoComplete="off" disabled={disabled} onChange={requireRates} /></label>)}</div></details>
    </>}
    <div className="t-credential-entry"><input ref={secret} id={id} className="t-search" type="password" placeholder={status.set ? "Replace key" : "API key"} autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled} onChange={(e) => setHasKey(!!e.currentTarget.value)} />
      <Button label="Save" variant="primary" type="submit" isDisabled={disabled || !hasKey} />
      {status.set && <Button label="Unset" variant="secondary" isDisabled={disabled} onClick={() => void unset()} />}
    </div>
  </form>;
}
