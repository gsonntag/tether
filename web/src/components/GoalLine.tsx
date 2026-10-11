import { HStack } from "@astryxdesign/core/HStack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import type { GoalStatus, SessionGoal } from "../shared/protocol";
import { goalSummary } from "../shared/goal";

const DOT: Record<GoalStatus, "success" | "warning" | "error" | "accent" | "neutral"> = {
  active: "accent",
  paused: "neutral",
  done: "success",
  blocked: "error",
  budget: "warning",
};

/**
 * The session's goal (/goal), one line at the top: status, budget used, and the objective.
 * `inset`: room on the left for the floating sidebar button (phones, sidebar hidden).
 */
export function GoalLine({ goal, inset }: { goal?: SessionGoal | null; inset?: boolean }) {
  if (!goal) return null;
  const why = goal.status !== "active" && goal.reason ? `\n\n${goal.reason}` : "";
  const latest = goal.notes[goal.notes.length - 1]?.text;
  return (
    <Tooltip content={`${goal.objective}${why}${latest && !why ? `\n\nLatest: ${latest}` : ""}${goal.native ? "\n\nMirrored into the harness's own goal." : ""}`}>
      <HStack gap={2} vAlign="center" paddingInlineStart={inset ? 10 : 4} paddingInlineEnd={4} paddingBlock={1}>
        <StatusDot variant={DOT[goal.status]} label={goalSummary(goal)} isPulsing={goal.status === "active"} />
        <Text type="supporting" hasTabularNumbers>
          Goal · {goalSummary(goal)}
        </Text>
        <Text maxLines={1} hasTruncateTooltip={false}>
          {goal.objective}
        </Text>
      </HStack>
    </Tooltip>
  );
}
