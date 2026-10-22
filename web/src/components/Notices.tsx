import { useEffect, useRef, useState } from "react";
import { BellIcon } from "@heroicons/react/24/outline";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { Popover } from "@astryxdesign/core/Popover";
import { StackItem } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VStack } from "@astryxdesign/core/VStack";
import { NOTIFY_KINDS, type AgentNotice } from "../shared/protocol";
import { isShellCall, latestPerSession } from "../dashboard";
import { knownSessions } from "../sessionLists";
import { enablePush, needsHomeScreen, pushOnHere, pushState, pushSupported } from "../push";
import { act, clearNotices, markBellSeen, markNoticeRead, openPage, refreshNotices, selectSession, useStore } from "../store";
import { ago } from "../util";
import { TitleLink } from "./RowMenu";

/** The kind as a word (the dot's colour is never the only cue). */
const KIND: Record<AgentNotice["kind"], { word: string; dot: "success" | "error" | "warning" }> = {
  finished: { word: "Finished", dot: "success" },
  question: { word: "Needs you", dot: "error" },
  blocked: { word: "Blocked", dot: "error" },
  memory: { word: "Memory conflict", dot: "warning" },
};

/** The bell: what your agents asked, finished or got stuck on, newest first. Opening it drains its count. */
export function NoticeBell() {
  const notices = useStore((s) => s.notices);
  const noticesSeen = useStore((s) => s.noticesSeen);
  const noticesRead = useStore((s) => s.noticesRead);
  const bellSeen = useStore((s) => s.bellSeen);
  const [open, setOpen] = useState(false);
  const isRead = (n: AgentNotice) => n.ts <= noticesSeen || noticesRead.includes(n.id);
  const rows = latestPerSession(notices);
  const unseen = rows.filter((n) => n.ts > bellSeen && !isRead(n)).length;

  const setOpenState = (o: boolean) => {
    setOpen(o);
    if (o) {
      refreshNotices();
      markBellSeen();
    }
  };
  // New ones that arrive while it's open are seen too.
  useEffect(() => {
    if (open) markBellSeen();
  }, [open, notices]);

  const content = (
    <VStack>
      <HStack gap={2} vAlign="center" paddingInline={3} paddingBlock={1}>
        <StackItem size="fill">
          <Text type="label">Notifications</Text>
        </StackItem>
        {notices.length > 0 && <Button label="Clear all" variant="ghost" size="sm" onClick={() => void clearNotices()} />}
      </HStack>
      <Divider />
      {rows.length === 0 ? (
        <EmptyNotices />
      ) : (
        <VStack isScrollable style={{ maxHeight: "60dvh" }}>
          <List density="compact" hasDividers>
            {rows.slice(0, 50).map((n) => (
              <NoticeRow key={n.id} n={n} read={isRead(n)} close={() => setOpen(false)} />
            ))}
          </List>
        </VStack>
      )}
    </VStack>
  );

  return (
    <Popover label="Notifications" isOpen={open} onOpenChange={setOpenState} content={content} padding={0} width={360} placement="below" alignment="start">
      <Button
        label={unseen ? `Notifications, ${unseen} unread` : "Notifications"}
        variant="ghost"
        size="sm"
        tooltip="Notifications"
        icon={<Icon icon={BellIcon} />}
        endContent={unseen > 0 ? <Badge variant="error" label={unseen > 9 ? "9+" : unseen} /> : undefined}
      >
        {""}
      </Button>
    </Popover>
  );
}

function NoticeRow({ n, read, close }: { n: AgentNotice; read: boolean; close: () => void }) {
  const title = useStore((st) => (n.kind === "memory" ? undefined : (st.open[n.sessionId]?.session ?? knownSessions(st.projects, st.sessions, st.recent).get(n.sessionId) ?? st.pulses[st.runnerId ?? ""]?.[n.sessionId]?.session)?.title));
  const [busy, setBusy] = useState(false);
  const link = useRef<HTMLButtonElement>(null);
  const kind = KIND[n.kind];
  // A notice's title is "<what> · <session title>"; the session's own title wins when known.
  const name = title ?? (n.title.split(" · ").slice(1).join(" · ") || n.title);
  const retry = n.kind === "blocked" && n.toolId && (
    <HStack gap={2} paddingBlockStart={1}>
      <Button
        label="Approve & retry"
        variant="primary"
        size="sm"
        isLoading={busy}
        onClick={async () => {
          setBusy(true);
          const r = await act("approveBlocked", { sessionId: n.sessionId, toolId: n.toolId! });
          setBusy(false);
          if (r !== undefined) {
            markNoticeRead(n.id);
            refreshNotices();
          }
        }}
      />
      {isShellCall(n.call) && (
        <Button
          label="Run it myself"
          variant="secondary"
          size="sm"
          onClick={async () => {
            if ((await act("runBlocked", { sessionId: n.sessionId, toolId: n.toolId! })) !== undefined) markNoticeRead(n.id);
          }}
        />
      )}
    </HStack>
  );
  return (
    <ListItem
      interactiveRef={link}
      label={
        <TitleLink
          title={name}
          weight={read ? "normal" : "semibold"}
          linkRef={link}
          onOpen={() => {
            markNoticeRead(n.id);
            close();
            if (n.kind === "memory") openPage("memory", n.conflictId ?? "conflicts");
            else if (n.sessionId) selectSession(n.sessionId);
          }}
        />
      }
      description={
        <VStack gap={0}>
          <HStack gap={1} vAlign="center">
            <Text type="supporting" maxLines={1}>
              {[n.kind === "memory" ? undefined : n.project, kind.word].filter(Boolean).join(" · ")} ·{" "}
            </Text>
            <Tooltip content={new Date(n.ts).toLocaleString()}>
              <Text type="supporting" hasTabularNumbers>
                {ago(n.ts) === "now" ? "now" : `${ago(n.ts)} ago`}
              </Text>
            </Tooltip>
          </HStack>
          {retry}
        </VStack>
      }
      startContent={<StatusDot variant={read ? "neutral" : kind.dot} label={`${kind.word}${read ? " · opened" : ""}`} />}
    />
  );
}

/** Nothing yet: one line, and the way to get pushes when this device doesn't. */
function EmptyNotices() {
  const runnerId = useStore((s) => s.runnerId);
  const [on, setOn] = useState(() => !!runnerId && pushOnHere(runnerId));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const can = pushSupported() && Notification.permission !== "denied";
  useEffect(() => {
    if (runnerId && can) pushState().then((st) => setOn(!!st.kinds), () => {});
  }, [runnerId]);
  return (
    <VStack padding={3} gap={2}>
      <Text type="supporting">Nothing yet. Questions, finished turns and blocked calls show up here.</Text>
      {!on && needsHomeScreen() && <Text type="supporting">Add Tether to your Home Screen to get pushes.</Text>}
      {!on && can && (
        <HStack>
          <Button
            label="Turn on push notifications"
            size="sm"
            isLoading={busy}
            onClick={async () => {
              setBusy(true);
              setErr(undefined);
              try {
                await enablePush(NOTIFY_KINDS.map((k) => k.id));
                setOn(true);
              } catch (e: any) {
                setErr(e?.message ?? String(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        </HStack>
      )}
      {err && <Text type="supporting">{err}</Text>}
    </VStack>
  );
}
