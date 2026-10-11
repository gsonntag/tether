import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ClockIcon } from "@heroicons/react/24/outline";
import { workLabel, type WorkInput } from "../workState";

/**
 * A session's working state as one small mark, the same in the sidebar and on Home:
 * the main turn running (accent spinner), only background work running (grey spinner),
 * waiting on a limit (amber dot), a wakeup armed (clock), live and idle (blue dot).
 */
export function WorkIndicator({ work }: { work: WorkInput }) {
  const { state, label, tooltip } = workLabel(work);
  switch (state) {
    case "working":
      // Both spinners carry a tooltip and a label, so blue vs grey isn't the only difference.
      return (
        <Tooltip content={tooltip}>
          <Spinner size="sm" aria-label={label} />
        </Tooltip>
      );
    case "background":
      return (
        <Tooltip content={tooltip}>
          <Spinner size="sm" shade="subtle" aria-label={`${label}: ${tooltip}`} />
        </Tooltip>
      );
    case "waiting":
      return <StatusDot variant="warning" label={label} tooltip={tooltip} />;
    case "scheduled":
      return (
        <Tooltip content={tooltip}>
          <Icon icon={ClockIcon} size="sm" color="secondary" label={tooltip} />
        </Tooltip>
      );
    case "idle":
      return <StatusDot variant="accent" label={label} tooltip={tooltip} />;
    default:
      return null;
  }
}
