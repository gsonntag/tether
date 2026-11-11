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
import { askRunner, CODE_RE, linkLook } from "../shortLink";
import { useStore } from "../store";

export function ShortLink({ code }: { code: string }) {
  const runners = useStore((s) => s.runners);
  const link = useStore((s) => s.link);
  const online = useMemo(() => runners.filter((r) => r.online).map((r) => r.id), [runners]);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const asked = useRef(new Set<string>());
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  // Re-checks the clock until the answer can show.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (link !== "open" || !CODE_RE.test(code)) return;
    for (const id of online) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void askRunner((r, c) => rpc(r, "resolveLink", { code: c }), id, code).then((hit) => {
        // Only while this page is still showing this code.
        const here = parseRoute(location.hash);
        if (hit && here.page === "link" && here.code === code) replaceSession(hit.runnerId, hit.sessionId);
        else setAnswered((a) => new Set(a).add(id));
      });
    }
  }, [online, link, code]);

  const look = linkLook({ code, elapsedMs: now - since, linkOpen: link === "open", online, answered });
  const home = <Button label="Go Home" variant="primary" onClick={() => navigate({ page: "home" })} />;
  if (look === "missing")
    return <EmptyState icon={<Icon icon={LinkSlashIcon} size="lg" />} title="This link has expired or doesn't exist" description="Links from texts last 7 days. The session may still be in your list." actions={home} />;
  if (look === "offline")
    return <EmptyState icon={<Icon icon={SignalSlashIcon} size="lg" />} title="Waiting for your computer" description="None of your runners is connected, so this link can't open yet. It will as soon as one connects." actions={home} />;
  return <div className="t-inline-status"><Spinner size="sm" label="Opening link…" /></div>;
}
