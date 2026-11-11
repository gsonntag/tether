import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import type { CredentialSlot as Status, CredentialSource, CredentialStatus } from "../../../shared/credentials";
import { rpc } from "../connection";
import { useStore } from "../store";
import { AgentSettings } from "./AgentSettings";
import { AzureSettings } from "./AzureSettings";
import { DeviceNotifications } from "./DeviceNotifications";
import { HarnessUpdates } from "./HarnessUpdates";
import { TextingSettings } from "./TextingSettings";

type Page = "credentials" | "azure" | "texting" | "notifications" | "agents" | "updates";
const labels: Record<CredentialSource, string> = { anthropic: "Anthropic API key", openai: "OpenAI API key", azure: "API key" };

/** Settings, per runner: Credentials (Anthropic and OpenAI keys), Azure (its key, resource and deployments) Texting (iMessage) and this device's Notifications. */
export function Settings({ page }: { page: Page }) {
  const runners = useStore((s) => s.runners);
  const [chosen, setChosen] = useState("");
  const runner = runners.find((r) => r.id === chosen) ?? runners.find((r) => r.online) ?? runners[0];
  return (
    <main className="t-settings-page">
      <Heading level={1}>Settings</Heading>
      <div className="t-settings-body">
      <nav className="t-settings-nav" aria-label="Settings">
        <a href="#/settings/credentials" aria-current={page === "credentials" ? "page" : undefined}>Credentials</a>
        <a href="#/settings/azure" aria-current={page === "azure" ? "page" : undefined}>Azure</a>
        <a href="#/settings/texting" aria-current={page === "texting" ? "page" : undefined}>Texting</a>
        <a href="#/settings/notifications" aria-current={page === "notifications" ? "page" : undefined}>Notifications</a>
        <a href="#/settings/agents" aria-current={page === "agents" ? "page" : undefined}>Agents</a>
        <a href="#/settings/updates" aria-current={page === "updates" ? "page" : undefined}>Updates</a>
      </nav>
      <div className="t-credentials">
      {page === "notifications" ? <>
      <Heading level={2}>Notifications</Heading>
      <DeviceNotifications />
      </> : page === "updates" ? <HarnessUpdates /> : <>
      <Heading level={2}>{page === "azure" ? "Azure" : page === "texting" ? "Texting" : page === "agents" ? "Agents" : "Credentials"}</Heading>
      {runners.length > 1 && <label className="t-field">Runner<select className="t-select" value={runner?.id ?? ""} onChange={(e) => setChosen(e.target.value)}>{runners.map((r) => <option key={r.id} value={r.id}>{r.name || r.id}</option>)}</select></label>}
      {!runner ? <div className="t-inline-status">No runner connected.</div> : !runner.online ? <div className="t-inline-status">Runner offline.</div> : page === "azure" ? <AzureSettings key={runner.id} runnerId={runner.id} /> : page === "texting" ? <TextingSettings key={runner.id} runnerId={runner.id} /> : page === "agents" ? <AgentSettings key={runner.id} runnerId={runner.id} /> : <RunnerCredentials key={runner.id} runnerId={runner.id} />}
      </>}
      </div>
      </div>
    </main>
  );
}

/** A runner's key status, loaded when the link is open, and a way to change it. */
export function useCredentials(runnerId: string) {
  const link = useStore((s) => s.link);
  const [status, setStatus] = useState<CredentialStatus>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let gone = false;
    setStatus(undefined);
    if (link === "open") void rpc(runnerId, "credentials", {}).then((s) => { if (!gone) { setStatus(s); setError(undefined); } }).catch(() => { if (!gone) setError("Couldn't load credentials. Update and restart the runner."); });
    return () => { gone = true; };
  }, [runnerId, link]);
  const change = async (request: Promise<CredentialStatus>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try { setStatus(await request); return true; } catch (e) { setError((e as Error)?.message || "Couldn't update credentials."); return false; } finally { setBusy(false); }
  };
  return { status, error, busy, disabled: busy || link !== "open", change };
}

function RunnerCredentials({ runnerId }: { runnerId: string }) {
  const { status, error, disabled, change } = useCredentials(runnerId);
  const slot = (source: "anthropic" | "openai") => <KeySlot source={source} status={status![source]} disabled={disabled} save={(key) => void change(rpc(runnerId, "setCredential", { source, key }))} unset={() => void change(rpc(runnerId, "unsetCredential", { source }))} />;
  return <>
    {error && <div className="t-inline-status error" role="alert">{error}</div>}
    {!status ? !error && <div className="t-inline-status">Loading…</div> : <>
      <section className="t-credential-harness"><Heading level={3}>Claude</Heading>{slot("anthropic")}</section>
      <section className="t-credential-harness"><Heading level={3}>Codex</Heading>{slot("openai")}</section>
    </>}
  </>;
}

/** A write-only key: the field clears as it's sent, and only Set and its last four come back. */
export function KeySlot({ source, status, disabled, save, unset }: { source: CredentialSource; status: Status; disabled: boolean; save: (key: string) => void; unset: () => void }) {
  const secret = useRef<HTMLInputElement>(null);
  const [hasKey, setHasKey] = useState(false);
  const id = `credential-${source}`;
  return <form className="t-credential-slot" aria-label={source === "azure" ? "Azure API key" : labels[source]} autoComplete="off" onSubmit={(e) => {
    e.preventDefault();
    if (disabled || !secret.current?.value) return;
    const key = secret.current.value;
    secret.current.value = "";
    setHasKey(false);
    save(key);
  }}>
    <div className="t-credential-title"><label htmlFor={id}>{labels[source]}</label><span className="t-credential-status">{status.set ? `Set${status.last4 ? ` · ••••${status.last4}` : ""}` : "Not set"}</span></div>
    <div className="t-credential-entry"><input ref={secret} id={id} className="t-search" type="password" placeholder={status.set ? "Replace key" : "API key"} autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false} disabled={disabled} onChange={(e) => setHasKey(!!e.currentTarget.value)} />
      <Button label="Save" variant="primary" type="submit" isDisabled={disabled || !hasKey} />
      {status.set && <Button label="Unset" variant="secondary" isDisabled={disabled} onClick={() => unset()} />}
    </div>
  </form>;
}
