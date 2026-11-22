import type { HarnessAccount } from "../../../shared/harnessLogin";
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

import type { KnownRunner } from "../runners";
import { PAGE_LABELS, resolveSettingsPage, runnersForPage, visibleSettingsPages, type SettingsPage } from "../settings";
import { RunnersSettings } from "./RunnersSettings";

/** The Runner menu's "All runners" (Usage only). */
const ALL = "*all";

const labels: Record<CredentialSource, string> = { anthropic: "Anthropic API key", openai: "OpenAI API key", azure: "API key", bedrock: "Bedrock API key" };

/** Settings, per runner: Runners (names and sharing), Credentials (Anthropic and OpenAI keys), Azure (its key, resource and deployments) Messaging (iMessage, Discord) and this device's Notifications. */
export function Settings({ page: asked, loginTarget, runners: propRunners, role: propRole }: { page: SettingsPage; loginTarget?: { runnerId?: string; harness?: HarnessId }; runners?: KnownRunner[]; role?: string }) {
  const storeRunners = useStore((s) => s.runners);
  const storeRole = useStore((s) => s.user?.role);
  const allRunners = propRunners ?? storeRunners;
  const role = propRole ?? storeRole;
  const visiblePages = visibleSettingsPages(allRunners, role);
  const page = resolveSettingsPage(asked, allRunners, role);
  // The URL keeps the asked page: before hello and the runner list arrive nothing looks usable, so
  // rewriting it to the fallback would stick and lose every reload or deep link.
  const pageRunners = runnersForPage(allRunners, page);

  const [chosen, setChosen] = useState(loginTarget?.runnerId ?? "");
  // Usage can show every runner together: its first choice, and where it starts.
  const allUsageRunners = page === "usage" && pageRunners.length > 1 && (chosen === ALL || !chosen);
  const runner = pageRunners.find((r) => r.id === chosen) ?? pageRunners.find((r) => r.online) ?? pageRunners[0];
  return (
    <main className="t-settings-page">
      <Heading level={1}>Settings</Heading>
      <div className="t-settings-body">
      <nav className="t-settings-nav" aria-label="Settings">
        {visiblePages.map((p) => (
          <a key={p} href={`#/settings/${p}`} aria-current={page === p ? "page" : undefined}>
            {PAGE_LABELS[p]}
          </a>
        ))}
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
      <Heading level={2}>{page === "bedrock" ? "Amazon Bedrock" : PAGE_LABELS[page]}</Heading>
      {pageRunners.length > 1 && <label className="t-field">Runner<select className="t-select" value={allUsageRunners ? ALL : runner?.id ?? ""} onChange={(e) => setChosen(e.target.value)}>{page === "usage" && <option value={ALL}>All runners</option>}{pageRunners.map((r) => <option key={r.id} value={r.id}>{r.name || r.id}{page === "usage" && !r.online ? " (offline)" : ""}</option>)}</select></label>}
      {allUsageRunners ? <UsageSettings key={ALL} runners={pageRunners.map((r) => ({ id: r.id, name: r.name || r.id, online: r.online }))} /> : !runner ? <div className="t-inline-status">No runner connected.</div> : !runner.online ? <div className="t-inline-status">Runner offline.</div> : page === "accounts" ? <RunnerAccounts key={runner.id} runnerId={runner.id} /> : page === "azure" ? <AzureSettings key={runner.id} runnerId={runner.id} /> : page === "bedrock" ? <BedrockSettingsPage key={runner.id} runnerId={runner.id} /> : page === "texting" ? <TextingSettings key={runner.id} runnerId={runner.id} /> : page === "agents" ? <AgentSettings key={runner.id} runnerId={runner.id} /> : page === "usage" ? <UsageSettings key={runner.id} runners={[{ id: runner.id, name: runner.name || runner.id, online: true }]} /> : <RunnerCredentials key={runner.id} runnerId={runner.id} first={runner.id === loginTarget?.runnerId ? loginTarget?.harness : undefined} />}
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
    {harness === "claude" && <ExtraAccounts runnerId={runnerId} harness={harness} />}
  </section>);
}

function ExtraAccounts({ runnerId, harness }: { runnerId: string; harness: HarnessId }) {
  const link = useStore((s) => s.link);
  const [accounts, setAccounts] = useState<HarnessAccount[]>();
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((n) => n + 1);
  useEffect(() => {
    if (link !== "open") return;
    let active = true;
    void rpc(runnerId, "listHarnessAccounts", { harness }).then((result) => {
      if (active) setAccounts(result);
    }).catch(() => {});
    return () => { active = false; };
  }, [runnerId, harness, link, revision]);
  if (!accounts) return null;
  return <>
    {accounts.map((extra) => <HarnessLogin key={extra.source} runnerId={runnerId} harness={harness} extra={extra} rename onChanged={refresh} />)}
    <HarnessLogin runnerId={runnerId} harness={harness} add onChanged={refresh} />
  </>;
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
      {harness === "claude" && <a className="t-link" href="#/settings/accounts">Manage Claude accounts</a>}
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
