// Every live session's activity on this runner: what's running, grouped by session.

import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, Layout, LayoutContent, LayoutHeader, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { isActive, type SessionActivity } from "../shared/protocol";
import { upsertActivity } from "../shared/reducer";
import { onActivity, rpc, selectSession, useStore } from "../store";
import { activitySummary } from "../activity";
import { ActivityRow } from "./Activity";
import { HarnessBadge } from "./HarnessBadge";

/** Items that ended this recently stay listed, so you see what just finished. */
const RECENT_MS = 15 * 60_000;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function RunningPage() {
  const runnerId = useStore((s) => s.runnerId);
  const [list, setList] = useState<SessionActivity[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    let stop = false;
    let soon: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      rpc("listActivity", { recentMs: RECENT_MS })
        .then((r) => !stop && (setList(r), setError("")))
        .catch((e) => !stop && setError(e.message ?? String(e)));
    const loadSoon = () => {
      clearTimeout(soon);
      soon = setTimeout(load, 500);
    };
    load();
    // Changes arrive pushed (every session's events reach the browser); a session not listed yet
    // reloads the list. A slow poll drops closed sessions and items past RECENT_MS.
    const off = onActivity((sessionId, items, replace) =>
      setList((cur) => {
        const i = cur?.findIndex((s) => s.session.id === sessionId) ?? -1;
        if (!cur || i < 0) {
          if (items.some(isActive)) loadSoon();
          return cur;
        }
        const next = [...cur];
        next[i] = { ...cur[i]!, items: replace ? items : upsertActivity(cur[i]!.items, items) };
        return next;
      }),
    );
    const t = setInterval(() => document.visibilityState === "visible" && load(), 30_000);
    return () => {
      stop = true;
      off();
      clearInterval(t);
      clearTimeout(soon);
    };
  }, [runnerId]);

  const running = (list ?? []).reduce((n, s) => n + s.items.filter(isActive).length, 0);
  return (
    <Layout
      padding={4}
      contentWidth={880}
      header={
        <LayoutHeader paddingBlockEnd={2}>
          <VStack gap={0.5} paddingBlockStart={6}>
            <Heading level={1}>Running</Heading>
            <Text type="supporting">
              {list ? `${running} running across ${plural(list.filter((s) => s.items.some(isActive)).length, "session")} · finished in the last 15 minutes stay listed` : "Loading…"}
            </Text>
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent>
          {!list && !error && <Spinner label="Loading activity…" />}
          {error && <Text type="supporting">{error}</Text>}
          {list && !list.length && (
            <EmptyState title="Nothing running" description="Subagents, background shells, monitors and wakeups of every live session show here." />
          )}
          <VStack gap={5}>
            {(list ?? []).map(({ session, items }) => {
              const sorted = [...items].sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || b.startedAt - a.startedAt);
              const project = session.projectPath.split(/[\\/]/).filter(Boolean).pop() ?? session.projectPath;
              return (
                <VStack key={session.id} gap={1}>
                  <HStack gap={2} vAlign="center">
                    <HarnessBadge harness={session.harness} />
                    <StackItem size="fill">
                      <VStack gap={0}>
                        <Text type="label" weight="semibold" maxLines={1}>
                          {session.title}
                        </Text>
                        <Text type="supporting" maxLines={1}>
                          {[project, activitySummary(items) || "nothing running now"].join(" · ")}
                        </Text>
                      </VStack>
                    </StackItem>
                    {/* static: a long title truncates instead of squeezing the button */}
                    <StackItem>
                      <Button label="Open" size="sm" variant="ghost" onClick={() => selectSession(session.id)} />
                    </StackItem>
                  </HStack>
                  <VStack>
                    {sorted.map((a) => (
                      <ActivityRow key={a.id} sessionId={session.id} item={a} harness={session.harness} parent={a.parentId ? items.find((p) => p.id === a.parentId)?.title : undefined} />
                    ))}
                  </VStack>
                </VStack>
              );
            })}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
