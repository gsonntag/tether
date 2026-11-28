import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { accountDisplayLabel, harnessLoginHref, type HarnessAccount, type HarnessLoginFlow, type HarnessLoginStatus } from "../../../shared/harnessLogin";
import { HARNESS_LABELS, type HarnessId } from "../../../shared/transcript";
import { rpc } from "../connection";
import { invalidateAccountLabelCache } from "../accountLabel";
import { cswapLabel } from "../accountLabels";
import { accessOf } from "../runners";
import { useStore } from "../store";

export function HarnessLoginLink({ runnerId, harness }: { runnerId: string; harness: HarnessId }) {
  const runner = useStore((s) => s.runners.find((r) => r.id === runnerId));
  if (!runner || accessOf(runner) !== "manage") return null;
  return <a className="t-link" href={harnessLoginHref(runnerId, harness)}>Sign in to {HARNESS_LABELS[harness]}</a>;
}

const statusText = (s: HarnessLoginStatus | undefined) => {
  switch (s?.state) {
    case "signedIn": {
      // Leave out displayName here: the title slot already renders it (G8).
      const { name, detail } = accountDisplayLabel({ ...s, displayName: undefined }, "Signed in");
      return [name, detail].filter(Boolean).join(" · ");
    }
    case "signedOut": return "Signed out";
    case "unavailable": return "Not installed";
    case "unknown": return "Status unavailable";
    default: return "Checking…";
  }
};

const extraProbeText = (extra: HarnessAccount | undefined) => {
  if (!extra) return "";
  if (extra.probe === "signedOut") return " · Signed out";
  if (extra.probe === "unknown") return " · Status unavailable";
  if (extra.probe === undefined && !extra.available) return " · Sign-in required";
  return "";
};

export function HarnessLogin({ runnerId, harness, rename, extra, add, onChanged }: {
  runnerId: string;
  harness: HarnessId;
  rename?: boolean;
  extra?: HarnessAccount;
  add?: boolean;
  onChanged?: () => void;
}) {
  const connected = useStore((s) => s.link === "open");
  const [primary, setStatus] = useState<HarnessLoginStatus>();
  const status = extra?.status ?? primary;
  const cswap = extra?.managedBy === "cswap" ? extra : undefined;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [flowId, setFlowId] = useState<string>();
  const [challenge, setChallenge] = useState<Extract<HarnessLoginFlow, { state: "pending" }>>();
  const [revision, setRevision] = useState(0);
  const active = useRef(false);
  const flowRef = useRef<string>(undefined);
  const codeField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const id = flowRef.current;
      if (id) void rpc(runnerId, "harnessLoginCancel", { flowId: id }).catch(() => {});
    };
  }, [runnerId]);

  useEffect(() => {
    if (!connected || extra || add) return;
    let gone = false;
    void rpc(runnerId, "harnessLoginStatus", { harness }).then((result) => {
      if (!gone) setStatus(result);
    }, (e: Error) => {
      if (!gone) { setStatus({ state: "unknown" }); setError(e.message); }
    });
    return () => { gone = true; };
  }, [runnerId, harness, connected, revision, extra, add]);

  useEffect(() => {
    if (!connected || !flowId) return;
    let gone = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      flowRef.current = undefined;
      setFlowId(undefined);
      setChallenge(undefined);
      setStatus(undefined);
      setRevision((n) => n + 1);
      invalidateAccountLabelCache(runnerId, harness);
      onChanged?.();
    };
    const poll = async () => {
      try {
        const result = await rpc(runnerId, "harnessLoginPoll", { flowId });
        if (gone) return;
        if (result.state === "pending") {
          setChallenge(result);
          timer = setTimeout(() => void poll(), 1000);
        } else {
          if (result.state === "failed") setError("Sign-in failed. Try again or check the harness on the runner.");
          if (result.state === "expired") setError("Sign-in expired. Start again for a new code or link.");
          finish();
        }
      } catch (e) {
        if (!gone) { setError((e as Error).message); finish(); }
      }
    };
    void poll();
    return () => { gone = true; clearTimeout(timer); };
  }, [connected, runnerId, flowId]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const { flowId: id } = await rpc(runnerId, "harnessLoginStart", { harness, account: add ? "new" : extra?.source });
      if (!active.current) {
        void rpc(runnerId, "harnessLoginCancel", { flowId: id }).catch(() => {});
        return;
      }
      flowRef.current = id;
      setFlowId(id);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!flowId) return;
    setBusy(true);
    setError("");
    try {
      await rpc(runnerId, "harnessLoginCancel", { flowId });
      flowRef.current = undefined;
      setFlowId(undefined);
      setChallenge(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const send = async () => {
    const code = codeField.current?.value.trim();
    if (!flowId || !code) return;
    setBusy(true);
    setError("");
    try {
      await rpc(runnerId, "harnessLoginCode", { flowId, code });
      if (codeField.current) codeField.current.value = "";
      setChallenge(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const signOut = async () => {
    setBusy(true);
    setError("");
    try {
      if (extra) {
        await rpc(runnerId, "removeHarnessAccount", { harness, source: extra.source });
        onChanged?.();
      } else {
        setStatus(await rpc(runnerId, "harnessLogout", { harness }));
      }
      invalidateAccountLabelCache(runnerId, harness);
      setConfirm(false);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  const renameAccount = async (accountId: string, displayName: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await rpc(runnerId, "renameHarnessAccount", { harness, accountId, displayName, source: extra?.source });
      if (extra) onChanged?.();
      else setStatus(result);
      invalidateAccountLabelCache(runnerId, harness);
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return <div className="t-credential-slot">
    {!add && <div className="t-credential-title">{status?.state === "signedIn" && status.displayName ? status.displayName : harness === "claude" && !extra ? "Primary account" : cswap ? "Claude account via cswap" : "Harness account"} <span className="t-credential-status" role="status">{cswap ? cswapLabel({ ...cswap.status, ...(cswap.status.state === "signedIn" ? { displayName: undefined } : {}) }) : statusText(status)}{extraProbeText(extra)}</span></div>}
    {cswap && <div className="t-credential-hint">{cswap.hint ?? "Managed by cswap: sign in again and remove it with cswap."}</div>}
    {error && <div className="t-inline-status error" role="alert">{error}</div>}
    {rename && !flowId && !confirm && !(cswap && !cswap.available) && status?.state === "signedIn" && status.accountId && (
      <form className="t-credential-entry" key={status.accountId + (status.displayName ?? "")} onSubmit={(e) => {
        e.preventDefault();
        const name = new FormData(e.currentTarget).get("displayName");
        if (typeof name === "string" && status.accountId) void renameAccount(status.accountId, name);
      }}>
        <input className="t-search" name="displayName" aria-label={`${HARNESS_LABELS[harness]} display name`} placeholder="Display name" defaultValue={status.displayName ?? ""} maxLength={80} disabled={busy || !connected} />
        <Button label="Save name" variant="secondary" type="submit" isDisabled={busy || !connected} />
      </form>
    )}
    {flowId ? <>
      {challenge?.url ? <a className="t-link" href={challenge.url} target="_blank" rel="noreferrer">Open {HARNESS_LABELS[harness]} sign-in</a> : <span role="status">Waiting for the harness…</span>}
      {challenge?.deviceCode && <div>Enter this one-time code on the sign-in page <strong><code>{challenge.deviceCode}</code></strong></div>}
      {challenge?.acceptsCode && <form className="t-credential-entry" onSubmit={(e) => { e.preventDefault(); void send(); }} autoComplete="off">
        <input ref={codeField} className="t-search" aria-label="Authorization code" placeholder="Paste authorization code" type="password" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} required />
        <Button type="submit" label="Submit code" isDisabled={busy || !connected} />
      </form>}
      <div className="t-credential-entry"><Button label="Cancel" variant="secondary" isDisabled={busy || !connected} onClick={() => void cancel()} /></div>
    </> : confirm ? <>
      <div>{extra ? "Remove this account from the runner? Sessions using it will need another source." : `Sign out of ${HARNESS_LABELS[harness]} on this runner? Its command line uses the same account.`}</div>
      <div className="t-credential-entry">
        <Button label={extra ? "Remove account" : "Sign out"} isDisabled={busy || !connected} onClick={() => void signOut()} />
        <Button label="Cancel" variant="secondary" isDisabled={busy} onClick={() => setConfirm(false)} />
      </div>
    </> : !cswap && (add || (status && status.state !== "unavailable")) && <div className="t-credential-entry">
      <Button label={add ? "Add Claude account" : status?.state === "signedIn" ? "Sign in again" : "Sign in"} isDisabled={busy || !connected} onClick={() => void start()} />
      {status?.state === "signedIn" && <Button label={extra ? "Remove" : "Sign out"} variant="secondary" isDisabled={busy || !connected} onClick={() => setConfirm(true)} />}
    </div>}
  </div>;
}
