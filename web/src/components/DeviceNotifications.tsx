import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { disablePush, enablePush, pushState, testPush, type PushState } from "../push";
import { useStore } from "../store";

/** This device's notifications: on or off, and a test. */
export function DeviceNotifications() {
  const pushKey = useStore((s) => s.pushKey);
  const runners = useStore((s) => s.runners);
  const online = runners.filter((r) => r.online).map((r) => r.id);
  const [state, setState] = useState<PushState>();
  const [note, setNote] = useState<string>();
  useEffect(() => {
    let gone = false;
    void pushState(pushKey).then((s) => !gone && setState(s));
    return () => {
      gone = true;
    };
  }, [pushKey]);
  if (!state) return null;
  const run = async (f: () => Promise<PushState | void>) => {
    setNote(undefined);
    try {
      const s = await f();
      if (s) setState(s);
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const text: Record<PushState, string> = {
    unsupported: "This browser can't show notifications from Tether. On an iPhone, add Tether to the Home Screen first.",
    nokey: "Notifications aren't set up on this server yet (it needs TETHER_VAPID_PUBLIC_KEY and TETHER_VAPID_PRIVATE_KEY).",
    denied: "Notifications are blocked for this site. Allow them in the browser's site settings.",
    off: "Get a notification when a session needs you, finishes or fails.",
    on: "This device gets a notification when a session needs you, finishes or fails (not for a session it's showing).",
  };
  return (
    <div className="t-notify" aria-label="Notifications">
      <div className="t-notify-text">
        <span className="t-notify-title">Notifications on this device</span>
        <span className="t-inline-status">{note ?? text[state]} <a href="#/settings/texting">Get texts too</a></span>
        <span className="t-inline-status">May not work on macOS yet.</span>
      </div>
      {state === "off" && <Button label="Turn on" size="sm" variant="primary" clickAction={() => run(() => enablePush(pushKey!, online))} />}
      {state === "on" && (
        <>
          {online[0] && <Button label="Test" size="sm" variant="secondary" clickAction={() => run(() => testPush(online[0]!).then(() => setNote("Sent. It should show in a moment.")))} />}
          <Button label="Turn off" size="sm" variant="ghost" clickAction={() => run(() => disablePush(online))} />
        </>
      )}
    </div>
  );
}
