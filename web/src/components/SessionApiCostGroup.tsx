import { DropdownMenuGroup } from "@astryxdesign/core/DropdownMenu";
import { costChip, type SessionCost } from "../../../shared/costs";
import { isApiBilling } from "../../../shared/labels";
import type { Billing } from "../../../shared/transcript";

export function SessionApiCostGroup({ billing, cost: sessionCost }: { billing?: Billing; cost?: SessionCost }) {
  if (!isApiBilling(billing) && !sessionCost) return null;
  const cost = costChip(sessionCost);
  return (
    <DropdownMenuGroup title="API key spend this session">
      <div className="t-plan-line" title={cost.detail}>{cost.text}</div>
    </DropdownMenuGroup>
  );
}
