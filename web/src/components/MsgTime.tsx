import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useSyncExternalStore, type CSSProperties } from "react";
import { dayKey, formatMsgTime, fullMsgTime } from "../msgTime";

// One shared minute timer for every timestamp on the page; a timestamp re-renders only when the
// local day changes ("3:42 PM" becomes "Yesterday 3:42 PM").
const listeners = new Set<() => void>();
let today = dayKey(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const tick = () => {
  const d = dayKey(Date.now());
  if (d === today) return;
  today = d;
  for (const l of listeners) l();
};
function subscribe(l: () => void) {
  listeners.add(l);
  timer ??= setInterval(tick, 60_000);
  return () => {
    listeners.delete(l);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", tick);

const timeStyle: CSSProperties = { whiteSpace: "nowrap" };

/** A message's time, small and quiet; the full date and time on hover (tap on touch). */
export function MsgTime({ ts }: { ts: number }) {
  useSyncExternalStore(subscribe, () => today);
  if (!ts) return null;
  return (
    <Tooltip content={fullMsgTime(ts)} hasHoverIndication={false}>
      <Text type="supporting" color="secondary" style={timeStyle}>
        <time dateTime={new Date(ts).toISOString()}>{formatMsgTime(ts, Date.now())}</time>
      </Text>
    </Tooltip>
  );
}
