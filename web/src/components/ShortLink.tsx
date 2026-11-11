// The page for a short link (`#/l/<code>`, ../shortLink.ts): asks the connected runners what it
// opens, then replaces itself with the session. An unknown or expired code says so, with a way Home.

import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { LinkSlashIcon, SignalSlashIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../connection";
import { navigate, parseRoute, replaceSession } from "../route";
import { ASK_TIMEOUT_MS, askRunner, Lookup } from "../shortLink";
import { useStore } from "../store";

export function ShortLink({ code }: { code: string }) {
  const runners = useStore((s) => s.runners);
  const link = useStore((s) => s.link);
  const online = useMemo(() => runners.filter((r) => r.online).map((r) => r.id), [runners]);
  const lookup = useRef<Lookup | undefined>(undefined);
  lookup.current ??= new Lookup(code, Date.now());
  const [now, setNow] = useState(() => Date.now());

  // The clock: the settle wait, retries, and "waiting for your computer".
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
        const sessionId = l.answered(id, a, Date.now());
        const here = parseRoute(location.hash);
        if (sessionId && here.page === "link" && here.code === code) replaceSession(id, sessionId);
        else setNow(Date.now());
      });
    }
  }, [online, link, code, now]);

  const look = lookup.current.look(online, now);
  const home = <Button label="Go Home" variant="primary" onClick={() => navigate({ page: "home" })} />;
  if (look === "missing")
    return <EmptyState icon={<Icon icon={LinkSlashIcon} size="lg" />} title="This link has expired or doesn't exist" description="Links from texts last 7 days. The session may still be in your list." actions={home} />;
  if (look === "offline")
    return <EmptyState icon={<Icon icon={SignalSlashIcon} size="lg" />} title="Waiting for your computer" description="None of your runners is connected, so this link can't open yet. It will as soon as one connects." actions={home} />;
  return <div className="t-inline-status"><Spinner size="sm" label="Opening link…" /></div>;
}
