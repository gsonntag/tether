import { useEffect, useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { CheckIcon, ComputerDesktopIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { HARNESS_LABELS } from "../../../shared/transcript";
import { rpc } from "../connection";
import type { KnownRunner } from "../runners";
import { openSession } from "../route";
import { folderName, inbox, waitingOn, type InboxKind, type InboxRow } from "../sessionList";
import { disablePush, enablePush, pushState, testPush, type PushState } from "../push";
import { HarnessGlyph, shortAgo } from "./SessionRow";
import { forgetRunner, useStore } from "../store";
import { RunnerDot, runnerStatus } from "./RunnerStatus";
import { useNow } from "./useNow";

export function Home() {
  const runners = useStore((s) => s.runners);
  const linkOpen = useStore((s) => s.link === "open");

  return (
    <Layout
      height="fill"
      contentWidth={768}
      content={
        <LayoutContent padding={6}>
          <VStack gap={6}>
            <Inbox />
            <VStack gap={4}>
              <Heading level={2}>Runners</Heading>
              {runners.length === 0 ? (
                <EmptyState
                  icon={<Icon icon={ComputerDesktopIcon} size="lg" />}
                  title={linkOpen ? "No runner has connected yet" : "Connecting…"}
                  description={linkOpen ? "Start the runner on a machine with TETHER_URL and TETHER_TOKEN set, and it shows up here." : undefined}
                />
              ) : (
                <List hasDividers>
                  {runners.map((r) => (
                    <RunnerRow key={r.id} runner={r} linkOpen={linkOpen} />
                  ))}
                </List>
              )}
              <Notifications />
            </VStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}

const KIND_LABEL: Record<InboxKind, string> = { needs: "Needs you", failed: "Failed", finished: "Finished", working: "Working" };

/** One ranked list of what needs you, across runners (SPEC §10). */
function Inbox() {
  const summaries = useStore((s) => s.summaries);
  const runners = useStore((s) => s.runners);
  const now = useNow();
  const rows = useMemo(() => inbox(summaries), [summaries]);
  const many = runners.filter((r) => r.online).length > 1;
  const unread = rows.filter((r) => r.inbox === "failed" || r.inbox === "finished");
  const markRead = (r: InboxRow) => void rpc(r.runnerId, "setRead", { sessionId: r.id, read: true }).catch(() => {});
  return (
    <VStack gap={3}>
      <div className="t-inbox-head">
        <Heading level={1}>Home</Heading>
        {unread.length > 1 && <Button label="Mark all read" size="sm" variant="ghost" onClick={() => unread.forEach(markRead)} />}
      </div>
      {rows.length === 0 ? (
        <div className="t-inline-status">Nothing needs you. Finished and failed turns show here until you look at them.</div>
      ) : (
        <div className="t-inbox" role="list">
          {rows.map((r) => (
            <div key={`${r.runnerId}:${r.id}`} className={`t-inbox-row ${r.inbox}`} role="listitem" data-session={r.id}>
              <button type="button" className="t-inbox-main" onClick={() => openSession(r.runnerId, r.id)}>
                <span className="t-inbox-kind">{KIND_LABEL[r.inbox]}</span>
                <span className="t-row-title">{r.title || "Untitled"}</span>
                <span className="t-row-meta">
                  <HarnessGlyph harness={r.harness} />
                  <span className="t-proj">{folderName(r.projectPath)}</span>
                  {many && <span className="t-proj">· {runners.find((x) => x.id === r.runnerId)?.name ?? r.runnerId}</span>}
                  <span>· {shortAgo(r.updatedAt, now)}</span>
                  {r.inbox === "needs" && (r.requests ?? 0) > 1 && <span>· {r.requests} requests</span>}
                  {(r.queued ?? 0) > 0 && <span>· {r.queued} queued{r.queuePaused ? ", paused" : ""}</span>}
                </span>
                {r.inbox === "failed" && r.failure && <span className="t-inbox-why">{r.failure}</span>}
              </button>
              {(r.inbox === "failed" || r.inbox === "finished") && (
                <IconButton label={`Mark ${r.title || "this session"} read`} tooltip="Mark read" size="sm" variant="ghost" icon={<Icon icon={CheckIcon} />} onClick={() => markRead(r)} />
              )}
            </div>
          ))}
        </div>
      )}
    </VStack>
  );
}

/** This device's notifications: on or off, and a test. */
function Notifications() {
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
        <span className="t-inline-status">{note ?? text[state]}</span>
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

function RunnerRow({ runner, linkOpen }: { runner: KnownRunner; linkOpen: boolean }) {
  const now = useNow();
  const [check, setCheck] = useState<string>();
  // A ping result describes one connection; it means nothing after a reconnect or a drop.
  const conn = `${runner.online && linkOpen}:${runner.connectedAt}`;
  const [checkedConn, setCheckedConn] = useState(conn);
  if (checkedConn !== conn) {
    setCheckedConn(conn);
    setCheck(undefined);
  }
  const status = runnerStatus(runner, linkOpen, now);
  const summaries = useStore((s) => s.summaries);
  const waiting = useMemo(() => waitingOn(summaries, runner.id), [summaries, runner.id]);
  const harnesses = runner.harnesses.map((h) => `${HARNESS_LABELS[h.id] ?? h.id} ${h.version}`).join(" · ") || "No harnesses found";
  const host = runner.hostname !== runner.name ? `${runner.hostname} · ` : "";

  const ping = async () => {
    const t0 = performance.now();
    try {
      await rpc(runner.id, "ping", {});
      setCheck(`Answered in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      setCheck((e as Error).message);
    }
  };

  return (
    <ListItem
      label={runner.name || runner.id}
      startContent={<RunnerDot runner={runner} now={now} />}
      description={
        <VStack gap={0.5}>
          <Text type="supporting" display="block" maxLines={1}>
            {[status.label, check].filter(Boolean).join(" · ")}
          </Text>
          <Text type="supporting" display="block" maxLines={1}>
            {host + harnesses}
          </Text>
          {waiting.length > 0 && (
            <span className="t-runner-waiting">
              <span className="t-needs">Needs you:</span>
              {waiting.map((w) => (
                <button key={w.id} type="button" className="t-link" onClick={() => openSession(runner.id, w.id)}>
                  {w.title || "Untitled"}
                </button>
              ))}
            </span>
          )}
        </VStack>
      }
      endContent={
        !linkOpen ? undefined : runner.online ? (
          <Button label="Ping" size="sm" variant="secondary" clickAction={ping} />
        ) : (
          <IconButton label={`Forget ${runner.name || runner.id}`} tooltip="Forget" size="sm" variant="ghost" icon={<Icon icon={XMarkIcon} />} onClick={() => forgetRunner(runner.id)} />
        )
      }
    />
  );
}
