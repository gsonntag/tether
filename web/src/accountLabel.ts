import { useEffect, useState } from "react";
import type { HarnessId } from "../../shared/transcript";
import { rpc } from "./connection";
import { accessOf } from "./runners";
import { useStore } from "./store";

/** Read account details through the owner-only op, separate from the shared billing sources. */
export function useAccountLabel(runnerId: string | undefined, harness: HarnessId, wanted: boolean) {
  const link = useStore((s) => s.link);
  const runner = useStore((s) => s.runners.find((r) => r.id === runnerId));
  const allowed = wanted && link === "open" && !!runner?.online && accessOf(runner) === "manage";
  const [account, setAccount] = useState<{ runnerId: string; harness: HarnessId; label: string }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!allowed || !runnerId) {
      setAccount(undefined);
      return;
    }
    let active = true;
    void rpc(runnerId, "harnessLoginStatus", { harness }).then((status) => {
      if (!active) return;
      const label = status.state === "signedIn"
        ? [status.displayName || status.organization || status.email, status.plan].filter(Boolean).join(" · ")
        : "";
      setAccount(label ? { runnerId, harness, label } : undefined);
    }, () => { if (active) setAccount(undefined); });
    return () => { active = false; };
  }, [allowed, runnerId, harness, revision]);
  return {
    label: allowed && account && account.runnerId === runnerId && account.harness === harness ? account.label : undefined,
    refresh: () => setRevision((n) => n + 1),
  };
}
