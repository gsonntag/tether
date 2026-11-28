import { useEffect, useState } from "react";
import type { BillingSource } from "../../shared/credentials";
import type { HarnessId } from "../../shared/transcript";
import { accountLabelOf, labelOf } from "./accountLabels";
import { rpc } from "./connection";
import { accessOf } from "./runners";
import { useStore } from "./store";

/** Read account details through the owner-only op, separate from the shared billing sources. */
export function useAccountLabel(runnerId: string | undefined, harness: HarnessId, wanted: boolean) {
  const link = useStore((s) => s.link);
  const runner = useStore((s) => s.runners.find((r) => r.id === runnerId));
  const allowed = wanted && link === "open" && !!runner?.online && accessOf(runner) === "manage";
  const [account, setAccount] = useState<{ runnerId: string; harness: HarnessId; labels: Partial<Record<BillingSource, string>> }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!allowed || !runnerId) {
      setAccount(undefined);
      return;
    }
    let active = true;
    const primary = rpc(runnerId, "harnessLoginStatus", { harness }).catch(() => undefined);
    const extra = harness === "claude" ? rpc(runnerId, "listHarnessAccounts", { harness }).catch(() => []) : [];
    void Promise.all([primary, extra]).then(([status, accounts]) => {
      if (!active) return;
      const labels: Partial<Record<BillingSource, string>> = {};
      if (status) labels.subscription = labelOf(status);
      for (const account of accounts) labels[account.source] = accountLabelOf(account);
      setAccount({ runnerId, harness, labels });
    });
    return () => { active = false; };
  }, [allowed, runnerId, harness, revision]);
  const labels = allowed && account?.runnerId === runnerId && account?.harness === harness ? account?.labels : undefined;
  return {
    label: labels?.subscription,
    labels,
    refresh: () => setRevision((n) => n + 1),
  };
}
