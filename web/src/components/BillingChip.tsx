import { useEffect, useState } from "react";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuDivider, DropdownMenuGroup, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@astryxdesign/core/DropdownMenu";
import { ChevronDownIcon } from "@heroicons/react/16/solid";
import { costChip } from "../../../shared/costs";
import { keyTarget, type BillingSource, type SourceChoices } from "../../../shared/credentials";
import { isApiBilling, planLines, usageChip } from "../../../shared/labels";
import { UNKNOWN_BILLING, type HarnessCapabilities, type HarnessId, type LiveState, type SessionSummary } from "../../../shared/transcript";
import { rpc } from "../connection";
import { navigate } from "../route";
import { billingForDisplay, CURRENT_SOURCE, sourceMenu } from "../sourceMenu";
import { useStore } from "../store";
import { FallbackKeysDialog } from "./FallbackKeysDialog";
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

/** What the session draws from, loud on a key, and the way to change it. */
export function BillingChip({ runnerId, session, state, capabilities, onSwitch, onAutoKey }: { runnerId: string; session: SessionSummary; state: LiveState; capabilities?: HarnessCapabilities; onSwitch: (source: BillingSource) => void; onAutoKey: (on: boolean) => void }) {
  const [editingFallback, setEditingFallback] = useState(false);
  const changeable = !session.parentSessionId && !!capabilities?.sourceSwitch;
  const { choices, refresh } = useSources(runnerId, session.harness, changeable);
  const billing = billingForDisplay(state) ?? UNKNOWN_BILLING;
  const usage = usageChip(billing, state.plan);
  const cost = costChip(state.cost);
  const paid = isApiBilling(billing);
  const showSessionCost = paid || !!state.cost;
  const chip = paid ? { className: "t-chip t-paid-badge", title: billing.label } : { className: "t-chip t-chip-info t-usage-chip", title: usage.detail };
  const body = paid ? <><span>{billing.label}</span><span className="t-api-cost" title={cost.detail}>{cost.text}</span></> : usage.text;
  if (!choices) return <span {...chip}>{body}</span>;

  const menu = sourceMenu(session.harness, state, choices);
  // The plan's figures whatever the session draws from, by the plan's own name, so a key session sees them before switching.
  const planName = choices.options.find((o) => o.source === "subscription")?.billing.label;
  const plan = planName ? planLines(state.plan) : [];
  const keys = choices.options.filter((o) => o.source !== "subscription");
  const target = keyTarget(choices.options, state.lastKey, state.fallbackKeys);
  const onPlan = billing.kind === "plan";
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
          <button type="button" {...chip} className={`${chip.className} t-source-chip`} {...p} aria-label={`Source: ${paid ? `${billing.label}, ${cost.text}` : usage.text}`}>
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
        {plan.length > 0 && <DropdownMenuDivider />}
        {showSessionCost && <>
          <SessionApiCostGroup billing={billing} cost={state.cost} />
          <DropdownMenuDivider />
        </>}
        <DropdownMenuRadioGroup label="Source" value={menu.value} onChange={(value) => { if (value !== menu.value && value !== CURRENT_SOURCE) onSwitch(value as BillingSource); }}>
          {menu.items.map((i) => <DropdownMenuRadioItem key={i.value} value={i.value} label={i.label} description={i.reason} isDisabled={!!i.reason} />)}
        </DropdownMenuRadioGroup>
        {(keys.length > 0 || state.autoKey) && <DropdownMenuDivider />}
        {onPlan && (keys.length > 0 || state.autoKey) && <DropdownMenuCheckboxItem label="Switch to API key when plan runs out" description={target ? `Next: ${target.billing.label}` : "No allowed key available"} value={!!state.autoKey} onChange={onAutoKey} />}
        <DropdownMenuItem label="Fallback keys…" onClick={() => setEditingFallback(true)} />
        {menu.addKey && menu.items.length > 0 && <DropdownMenuDivider />}
        {menu.addKey && <DropdownMenuItem label="Add API key…" onClick={() => navigate({ page: "credentials" })} />}
      </DropdownMenu>
      {editingFallback && <FallbackKeysDialog harness={session.harness} state={state} choices={choices} onClose={() => setEditingFallback(false)} onSave={async (fallbackKeys) => { await rpc(runnerId, "setAutoKey", { sessionId: session.id, on: !!state.autoKey, fallbackKeys }); }} />}
    </>
  );
}
