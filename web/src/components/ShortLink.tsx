// The page for a short link (`#/l/<code>`, ../shortLink.ts): asks the connected runners what it
// opens, then shows the session under the same short URL (the code is kept in linkCache.ts, so
// useRoute reads the page as the session). It says plainly when a code is unknown or expired,
// when a runner that might have it is offline or not answering, and keeps listening either way.

import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ClockIcon, LinkSlashIcon, SignalSlashIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc, wakeLink } from "../connection";
import { linkCache } from "../linkCache";
import { navigate } from "../route";
import { ASK_TIMEOUT_MS, askRunner, Lookup } from "../shortLink";
import { useStore } from "../store";

export function ShortLink({ code }: { code: string }) {
  const runners = useStore((s) => s.runners);
  const link = useStore((s) => s.link);
  const online = useMemo(() => runners.filter((r) => r.online).map((r) => r.id), [runners]);
  const offlineKnown = useMemo(() => runners.filter((r) => !r.online).map((r) => r.id), [runners]);
  const lookup = useRef<Lookup | undefined>(undefined);
  lookup.current ??= new Lookup(code);
  const [now, setNow] = useState(() => Date.now());

  // The clock: the waits and the retries.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const l = lookup.current!;
    const at = Date.now();
    l.linkOpen(link === "open", at);
    for (const id of l.toAsk(online, at)) {
      void askRunner((r, c) => rpc(r, "resolveLink", { code: c }, ASK_TIMEOUT_MS), id, code).then((a) => {
        // The runner asked is the one that has it, whatever the answer says.
        const { sessionId, wake } = l.answered(id, a, Date.now());
        if (wake) wakeLink();
        if (sessionId) linkCache.remember(code, id, sessionId, false);
        else setNow(Date.now());
      });
    }
  }, [online, link, code, now]);

  const look = lookup.current.look(online, offlineKnown, now);
  const home = <Button label="Go Home" variant="primary" onClick={() => navigate({ page: "home" })} />;
  if (look === "missing")
    return <EmptyState icon={<Icon icon={LinkSlashIcon} size="lg" />} title="This link has expired or doesn't exist" description="Links from texts last 7 days. The session may still be in your list." actions={home} />;
  if (look === "maybeOffline")
    return <EmptyState icon={<Icon icon={SignalSlashIcon} size="lg" />} title="Couldn't find this link" description="One of your computers is offline, so it may open once it's back." actions={home} />;
  if (look === "unanswered")
    return <EmptyState icon={<Icon icon={ClockIcon} size="lg" />} title="Your computer isn't answering right now" description="This link should open once it's back." actions={home} />;
  if (look === "offline")
    return <EmptyState icon={<Icon icon={SignalSlashIcon} size="lg" />} title="Waiting for your computer" description="None of your runners is connected, so this link can't open yet. It will as soon as one connects." actions={home} />;
  return <div className="t-inline-status"><Spinner size="sm" label={look === "connecting" ? "Connecting…" : "Opening link…"} /></div>;
}
