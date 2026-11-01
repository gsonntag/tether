import { DropdownMenuGroup } from "@astryxdesign/core/DropdownMenu";
import { costChip } from "../../../shared/costs";
import type { LiveState } from "../../../shared/transcript";

export function SessionApiCostGroup({ cost: sessionCost }: { cost: LiveState["cost"] }) {
  const cost = costChip(sessionCost);
  return (
    <DropdownMenuGroup title="API key spend this session">
      <div className="t-plan-line" title={cost.detail}>{cost.text}</div>
    </DropdownMenuGroup>
  );
}
