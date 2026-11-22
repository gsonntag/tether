import { useEffect, useState } from "react";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuDivider, DropdownMenuGroup, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@astryxdesign/core/DropdownMenu";
import { ChevronDownIcon } from "@heroicons/react/16/solid";
import { costChip } from "../../../shared/costs";
import type { BillingSource, SourceChoices } from "../../../shared/credentials";
import { isApiBilling, planChip, planLines, usageChip } from "../../../shared/labels";
import { UNKNOWN_BILLING, type HarnessCapabilities, type HarnessId, type LiveState, type SessionSummary } from "../../../shared/transcript";
import { rpc } from "../connection";
import { navigate } from "../route";
import { billingForDisplay, CURRENT_SOURCE, sourceMenu } from "../sourceMenu";
import { useStore } from "../store";
import { SessionApiCostGroup } from "./SessionApiCostGroup";

const known = new Map<string, SourceChoices>();

/** The runner's answer, kept between sessions so the chip doesn't change shape. None: a plain chip. */
export function useSources(runnerId: string, harness: HarnessId, wanted: boolean) {
  const key = `${runnerId}\0${harness}`;
  const [, loaded] = useState(0);
  const refresh = () => {
    if (!wanted) return;
    void rpc(runnerId, "billingSources", { harness }).then((c) => known.set(key, c), () => known.delete(key)).then(() => loaded((n) => n + 1));
  };
  const link = useStore((s) => s.link);
  const online = useStore((s) => s.runners.find((r) => r.id === runnerId)?.online);
  useEffect(() => {
    if (link === "open" && online) refresh();
  }, [key, wanted, link, online]);
  return { choices: wanted ? known.get(key) : undefined, refresh };
}

/**
 * What the session draws from, loud on a key, and the way to change it.
 */
export function BillingChip({ runnerId, session, state, capabilities, onSwitch, onRetryThrottled }: { runnerId: string; session: SessionSummary; state: LiveState; capabilities?: HarnessCapabilities; onSwitch: (source: BillingSource) => void; onRetryThrottled?: (on: boolean) => void }) {
  // A side chat keeps its session's source (SPEC §16a).
  const changeable = !session.parentSessionId && !session.sideOf && !!capabilities?.sourceSwitch;
  const { choices, refresh } = useSources(runnerId, session.harness, changeable);
  const billing = billingForDisplay(state) ?? UNKNOWN_BILLING;
  const usage = usageChip(billing, state.plan);
  const limits = billing.kind === "plan" ? planChip(state.plan) : undefined;
  const cost = costChip(state.cost);
  const paid = isApiBilling(billing);
  const showSessionCost = paid || !!state.cost;
  const chip = paid ? { className: "t-chip t-paid-badge", title: billing.label } : { className: "t-chip t-chip-info t-usage-chip", title: usage.detail };
  const body = paid ? <><span>{billing.label}</span><span className="t-api-cost" title={cost.detail}>{cost.text}</span></> : limits ? limits.text : usage.text;

  const planName = choices?.options.find((o) => o.source === "subscription")?.billing.label ?? (billing.kind === "plan" ? billing.label : "Plan limits");
  const plan = planLines(state.plan);
  const showRetryThrottled = onRetryThrottled && !session.parentSessionId && !session.sideOf && state.retryThrottled !== undefined;
  const hasMenu = !!choices || plan.length > 0 || showSessionCost || showRetryThrottled;
  if (!hasMenu) return <span {...chip}>{body}</span>;

  const menu = choices ? sourceMenu(session.harness, state, choices) : undefined;
  const hasMoreBelowPlan = showSessionCost || (!!menu && (menu.items.length > 0 || menu.addKey));
  return (
    <>
      <DropdownMenu
        menuMaxHeight={420}
        onOpenChange={(open) => {
          if (!open) return;
          refresh();
          void rpc(runnerId, "refreshPlan", { harness: session.harness }).catch(() => {});
        }}
        renderTrigger={(p) => (
          <button type="button" {...chip} className={`${chip.className} t-source-chip`} {...p} aria-label={`Source: ${paid ? `${billing.label}, ${cost.text}` : limits ? `${billing.label}, ${limits.text}` : usage.text}`}>
            {body}
            <ChevronDownIcon aria-hidden />
          </button>
        )}
      >
        {plan.length > 0 && (
          <DropdownMenuGroup title={planName}>
            {plan.map((line) => <div key={line} className="t-plan-line">{line}</div>)}
          </DropdownMenuGroup>
        )}
        {plan.length > 0 && hasMoreBelowPlan && <DropdownMenuDivider />}
        {showSessionCost && <>
          <SessionApiCostGroup billing={billing} cost={state.cost} />
          {!!menu && (menu.items.length > 0 || menu.addKey) && <DropdownMenuDivider />}
        </>}
        {menu && menu.items.length > 0 && (
          <DropdownMenuRadioGroup label="Source" value={menu.value} onChange={(value) => { if (value !== menu.value && value !== CURRENT_SOURCE) onSwitch(value as BillingSource); }}>
            {menu.items.map((i) => <DropdownMenuRadioItem key={i.value} value={i.value} label={i.label} description={i.reason} isDisabled={!!i.reason} />)}
          </DropdownMenuRadioGroup>
        )}
        {showRetryThrottled && <>
          <DropdownMenuDivider />
          <DropdownMenuCheckboxItem label="Keep retrying when throttled" description="Wait up to six hours for this API key to recover." value={!!state.retryThrottled} onChange={onRetryThrottled} />
        </>}
        {menu?.addKey && menu.items.length > 0 && <DropdownMenuDivider />}
        {menu?.addKey && <DropdownMenuItem label="Add API key…" onClick={() => navigate({ page: "credentials" })} />}
      </DropdownMenu>
    </>
  );
}
