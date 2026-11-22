import { HARNESS_LABELS, type HarnessId } from "../../../shared/transcript";
import { HarnessLogin } from "./HarnessLogin";
import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import type { CredentialSlot as Status, CredentialSource, CredentialStatus } from "../../../shared/credentials";
import { rpc } from "../connection";
import { useStore } from "../store";
import { AgentSettings } from "./AgentSettings";
import { BedrockSettingsPage } from "./BedrockSettings";
import { AzureSettings } from "./AzureSettings";
import { DeviceNotifications } from "./DeviceNotifications";
import { DisplaySettings } from "./DisplaySettings";
import { HarnessUpdates } from "./HarnessUpdates";
import { TextingSettings } from "./TextingSettings";
import { UsageSettings } from "./UsageSettings";

import { RunnersSettings } from "./RunnersSettings";
import { accessOf } from "../runners";

/** The Runner menu's "All runners" (Usage only). */
const ALL = "*all";

type Page = "accounts" | "runners" | "credentials" | "azure" | "bedrock" | "texting" | "notifications" | "display" | "agents" | "updates" | "usage";
const labels: Record<CredentialSource, string> = { anthropic: "Anthropic API key", openai: "OpenAI API key", azure: "API key", bedrock: "Bedrock API key" };

/** Settings, per runner: Runners (names and sharing), Credentials (Anthropic and OpenAI keys), Azure (its key, resource and deployments) Messaging (iMessage, Discord) and this device's Notifications. */
export function Settings({ page: asked, loginTarget }: { page: Page; loginTarget?: { runnerId?: string; harness?: HarnessId } }) {
  // Everything but Notifications and Display is the owner's: only runners you own, and none for someone a
  // runner is merely shared with (shared/access.ts).
  const runners = useStore((s) => s.runners).filter((r) => accessOf(r) === "manage");
  const role = useStore((s) => s.user?.role);
  const owner = !role || role === "owner" || runners.length > 0;
  const page: Page = owner ? asked : asked === "display" ? "display" : "notifications";
  const [chosen, setChosen] = useState(loginTarget?.runnerId ?? "");
  // Usage can show every runner together: its first choice, and where it starts.
  const allRunners = page === "usage" && runners.length > 1 && (chosen === ALL || !chosen);
  const runner = runners.find((r) => r.id === chosen) ?? runners.find((r) => r.online) ?? runners[0];
  return (
    <main className="t-settings-page">
      <Heading level={1}>Settings</Heading>
      <div className="t-settings-body">
      <nav className="t-settings-nav" aria-label="Settings">
        {owner && <>
        <a href="#/settings/runners" aria-current={page === "runners" ? "page" : undefined}>Runners</a>
        <a href="#/settings/credentials" aria-current={page === "credentials" ? "page" : undefined}>Credentials</a>
        <a href="#/settings/accounts" aria-current={page === "accounts" ? "page" : undefined}>Accounts</a>
        <a href="#/settings/azure" aria-current={page === "azure" ? "page" : undefined}>Azure</a>
        <a href="#/settings/bedrock" aria-current={page === "bedrock" ? "page" : undefined}>Bedrock</a>
        <a href="#/settings/texting" aria-current={page === "texting" ? "page" : undefined}>Messaging</a>
        <a href="#/settings/notifications" aria-current={page === "notifications" ? "page" : undefined}>Notifications</a>
        <a href="#/settings/display" aria-current={page === "display" ? "page" : undefined}>Display</a>
        <a href="#/settings/agents" aria-current={page === "agents" ? "page" : undefined}>Agents</a>
        <a href="#/settings/updates" aria-current={page === "updates" ? "page" : undefined}>Updates</a>
        <a href="#/settings/usage" aria-current={page === "usage" ? "page" : undefined}>Usage</a>
        </>}
        {!owner && <>
        <a href="#/settings/notifications" aria-current={page === "notifications" ? "page" : undefined}>Notifications</a>
        <a href="#/settings/display" aria-current={page === "display" ? "page" : undefined}>Display</a>
        </>}
      </nav>
      <div className={page === "usage" ? "t-credentials t-credentials-wide" : "t-credentials"}>
      {page === "notifications" ? <>
      <Heading level={2}>Notifications</Heading>
      <DeviceNotifications />
      </> : page === "display" ? <>
      <Heading level={2}>Display</Heading>
      <DisplaySettings />
      </> : page === "runners" ? <>
      <Heading level={2}>Runners</Heading>
      <RunnersSettings />
      </> : page === "updates" ? <HarnessUpdates /> : <>
      <Heading level={2}>{page === "accounts" ? "Accounts" : page === "azure" ? "Azure" : page === "bedrock" ? "Amazon Bedrock" : page === "texting" ? "Messaging" : page === "agents" ? "Agents" : page === "usage" ? "Usage" : "Credentials"}</Heading>
      {runners.length > 1 && <label className="t-field">Runner<select className="t-select" value={allRunners ? ALL : runner?.id ?? ""} onChange={(e) => setChosen(e.target.value)}>{page === "usage" && <option value={ALL}>All runners</option>}{runners.map((r) => <option key={r.id} value={r.id}>{r.name || r.id}{page === "usage" && !r.online ? " (offline)" : ""}</option>)}</select></label>}
      {allRunners ? <UsageSettings key={ALL} runners={runners.map((r) => ({ id: r.id, name: r.name || r.id, online: r.online }))} /> : !runner ? <div className="t-inline-status">No runner connected.</div> : !runner.online ? <div className="t-inline-status">Runner offline.</div> : page === "accounts" ? <RunnerAccounts key={runner.id} runnerId={runner.id} /> : page === "azure" ? <AzureSettings key={runner.id} runnerId={runner.id} /> : page === "bedrock" ? <BedrockSettingsPage key={runner.id} runnerId={runner.id} /> : page === "texting" ? <TextingSettings key={runner.id} runnerId={runner.id} /> : page === "agents" ? <AgentSettings key={runner.id} runnerId={runner.id} /> : page === "usage" ? <UsageSettings key={runner.id} runners={[{ id: runner.id, name: runner.name || runner.id, online: true }]} /> : <RunnerCredentials key={runner.id} runnerId={runner.id} first={runner.id === loginTarget?.runnerId ? loginTarget?.harness : undefined} />}
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

const harnesses: HarnessId[] = ["claude", "codex", "antigravity"];

function RunnerAccounts({ runnerId }: { runnerId: string }) {
  return harnesses.map((harness) => <section key={harness} className="t-credential-harness">
    <Heading level={3}>{HARNESS_LABELS[harness]}</Heading>
    <HarnessLogin runnerId={runnerId} harness={harness} rename />
  </section>);
}

function RunnerCredentials({ runnerId, first }: { runnerId: string; first?: HarnessId }) {
  const { status, error, disabled, change } = useCredentials(runnerId);
  const slot = (source: "anthropic" | "openai") => <KeySlot source={source} status={status![source]} disabled={disabled} save={(key) => void change(rpc(runnerId, "setCredential", { source, key }))} unset={() => void change(rpc(runnerId, "unsetCredential", { source }))} />;
  const ordered = first ? [first, ...harnesses.filter((h) => h !== first)] : harnesses;
  return <>
    {error && <div className="t-inline-status error" role="alert">{error}</div>}
    {ordered.map((harness) => <section key={harness} className="t-credential-harness">
      <Heading level={3}>{harness === "claude" ? "Claude" : HARNESS_LABELS[harness]}</Heading>
      <HarnessLogin runnerId={runnerId} harness={harness} />
      {status && harness === "claude" && slot("anthropic")}
      {status && harness === "codex" && slot("openai")}
    </section>)}
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
