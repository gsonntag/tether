import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowPathIcon, ClockIcon } from "@heroicons/react/24/outline";
import type { SessionSchedule } from "../shared/protocol";
import { fmtWhen, kindLabel } from "../shared/schedule";
import { act } from "../store";

/**
 * The session's loops and schedules (/loop, /schedule), one compact line each under the goal line:
 * what it is, when it runs next and its prompt, with a button that stops or deletes it.
 * `inset`: room on the left for the floating sidebar button (phones, sidebar hidden).
 */
export function ScheduleLine({ sessionId, schedules, inset }: { sessionId: string; schedules?: SessionSchedule[]; inset?: boolean }) {
  if (!schedules?.length) return null;
  return (
    <VStack gap={0} paddingInlineStart={inset ? 10 : 4} paddingInlineEnd={2} style={{ maxHeight: "20vh", overflowY: "auto" }}>
      {schedules.map((s) => {
        const stop = s.kind === "loop" ? "Stop this loop" : "Delete this schedule";
        const runs = s.runs ? `\n\nRan ${s.runs} time${s.runs === 1 ? "" : "s"}${s.lastRunAt ? `, last at ${fmtWhen(s.lastRunAt)}` : ""}.` : "";
        return (
          <HStack key={s.id} gap={2} vAlign="center">
            <Icon icon={s.kind === "loop" ? ArrowPathIcon : ClockIcon} size="sm" color="secondary" label={kindLabel(s)} />
            <Text type="supporting" hasTabularNumbers>
              {kindLabel(s)} · {s.label} · Next {fmtWhen(s.nextAt)}
            </Text>
            <StackItem size="fill">
              <Tooltip content={`${s.prompt}${runs}`}>
                <Text maxLines={1} hasTruncateTooltip={false}>
                  {s.prompt}
                </Text>
              </Tooltip>
            </StackItem>
            <IconButton label={stop} tooltip={stop} variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={() => act("deleteSchedule", { sessionId, id: s.id })} />
          </HStack>
        );
      })}
    </VStack>
  );
}
