import { useState } from "react";
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
import { VStack } from "@astryxdesign/core/VStack";
import { markNoticeRead, refreshNotices, selectSession, useStore } from "../store";
import { fmtClock } from "../util";

/** The bell: what your agents asked, finished or got stuck on, newest first. */
export function NoticeBell() {
  const notices = useStore((s) => s.notices);
  const noticesSeen = useStore((s) => s.noticesSeen);
  const noticesRead = useStore((s) => s.noticesRead);
  const [open, setOpen] = useState(false);
  const isRead = (id: string, ts: number) => ts <= noticesSeen || noticesRead.includes(id);
  const unseen = notices.filter((n) => !isRead(n.id, n.ts)).length;

  const setOpenState = (o: boolean) => {
    setOpen(o);
    if (o) refreshNotices();
  };

  const content = (
    <VStack>
      <HStack gap={2} vAlign="center" paddingInline={3} paddingBlock={1}>
        <StackItem size="fill">
          <Text type="supporting">Notifications</Text>
        </StackItem>
        <Button
          label="Settings"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            useStore.setState({ dialog: "settings" });
          }}
        />
      </HStack>
      <Divider />
      {notices.length === 0 ? (
        <VStack padding={3}>
          <Text type="supporting">Nothing yet. Questions, finished turns and blocks show up here.</Text>
        </VStack>
      ) : (
        <VStack isScrollable style={{ maxHeight: "60dvh" }}>
          <List density="compact" hasDividers>
            {notices.slice(0, 50).map((n) => {
              const read = isRead(n.id, n.ts);
              const kind = n.kind === "finished" ? "Completed" : n.kind === "question" ? "Question" : "Blocked";
              return (
                <ListItem
                  key={n.id}
                  label={n.title}
                  description={
                    <Text type="supporting" maxLines={2}>
                      {n.body}
                    </Text>
                  }
                  startContent={
                    <StatusDot
                      variant={read ? "neutral" : n.kind === "finished" ? "success" : "error"}
                      label={`${kind} · ${read ? "Viewed" : "Ready to view"}`}
                    />
                  }
                  endContent={
                    <Text type="supporting" color="disabled" hasTabularNumbers>
                      {fmtClock(n.ts)}
                    </Text>
                  }
                  onClick={() => {
                    markNoticeRead(n.id);
                    setOpen(false);
                    if (n.sessionId) selectSession(n.sessionId);
                  }}
                />
              );
            })}
          </List>
        </VStack>
      )}
    </VStack>
  );

  return (
    <Popover label="Notifications" isOpen={open} onOpenChange={setOpenState} content={content} padding={0} width={360} placement="below" alignment="start">
      <Button
        label="Notifications"
        variant="ghost"
        size="sm"
        tooltip="Notifications"
        icon={<Icon icon={BellIcon} />}
        isIconOnly={unseen === 0}
        endContent={unseen > 0 ? <Badge variant="error" label={unseen > 9 ? "9+" : unseen} /> : undefined}
      >
        {unseen > 0 ? "" : undefined}
      </Button>
    </Popover>
  );
}
