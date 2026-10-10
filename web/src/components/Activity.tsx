// Everything a session has going on besides the transcript: subagents, background shells,
// monitors, cron jobs and wakeups. A compact summary under the message box opens the Activity
// panel (a side panel on desktop, a sheet on phones); the Running page lists it for every session.

import { useEffect, useState, type CSSProperties } from "react";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import { HStack, LayoutPanel, VStack } from "@astryxdesign/core/Layout";
import { Markdown } from "@astryxdesign/core/Markdown";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Timer } from "@astryxdesign/core/Timer";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { CheckCircleIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import { modelDisplay } from "../models";
import { activityOf, activitySummary } from "../activity";
import { ACTIVITY_KINDS, isActive, type ActivityItem, type ActivityStatus, type LiveState } from "../shared/protocol";
import { act, setActivityOpen, useStore } from "../store";
import { fmtClock } from "../util";

const NARROW = "(max-width: 767px)";
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
/** Child items (a subagent's own shells and agents) sit under their parent. */
const nested: CSSProperties = { paddingInlineStart: "var(--spacing-4)" };

const STATUS: Record<ActivityStatus, { variant: "accent" | "warning" | "success" | "error" | "neutral"; label: string }> = {
  running: { variant: "accent", label: "Running" },
  waiting: { variant: "warning", label: "Waiting" },
  done: { variant: "success", label: "Done" },
  failed: { variant: "error", label: "Failed" },
  stopped: { variant: "neutral", label: "Stopped" },
};

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/** The second line of a row: what it's doing now, or what it is. */
function rowDescription(a: ActivityItem, harness?: string): string {
  const what = [a.agentType, a.model ? modelDisplay(a.model, harness).name : undefined].filter(Boolean).join(" · ");
  if (isActive(a)) {
    if (a.status === "waiting" && a.nextAt) return `Next ${fmtClock(a.nextAt)}${a.schedule ? ` · ${a.schedule}` : ""}`;
    if (a.status === "waiting" && a.schedule) return a.schedule;
    return a.latest ?? (a.kind === "shell" || a.kind === "monitor" ? (a.command ?? what) : what);
  }
  const end = a.summary?.split("\n").find((l) => l.trim());
  return end ?? what;
}

/** The session's running work, for the bar under the message box. Opens the Activity panel. */
export function ActivityButton({ state }: { state: LiveState }) {
  const items = activityOf(state);
  const open = useStore((s) => s.activityOpen);
  if (!items.length) return null;
  const active = items.filter(isActive);
  const summary = activitySummary(items);
  const finished = items.length - active.length;
  return (
    <Button
      label={summary ? `Activity: ${summary}` : "Activity"}
      tooltip={open ? "Hide activity" : "Subagents, shells and other work in this session"}
      variant="ghost"
      size="sm"
      icon={active.some((a) => a.status === "running") ? <Spinner size="sm" /> : <Icon icon={active.length ? Squares2X2Icon : CheckCircleIcon} />}
      onClick={() => setActivityOpen(!open)}
    >
      {summary || `${finished} finished`}
    </Button>
  );
}

/** Desktop: the panel at the session's end edge; phones: a sheet. */
export function ActivityPanel({ sessionId, state, harness }: { sessionId: string; state: LiveState; harness?: string }) {
  const open = useStore((s) => s.activityOpen);
  const narrow = useMediaQuery(NARROW);
  const items = activityOf(state);
  if (narrow)
    return (
      <BottomSheet isOpen={open} onOpenChange={setActivityOpen} label="Activity" height="tall" padding={3}>
        <ActivityList sessionId={sessionId} items={items} harness={harness} />
      </BottomSheet>
    );
  if (!open) return null;
  return (
    <LayoutPanel width={400} hasDivider isScrollable label="Activity" padding={3}>
      <ActivityList sessionId={sessionId} items={items} harness={harness} onClose={() => setActivityOpen(false)} />
    </LayoutPanel>
  );
}

/** Running and armed items grouped by kind, then the recently finished ones (folded). */
export function ActivityList({ sessionId, items, harness, onClose }: { sessionId: string; items: ActivityItem[]; harness?: string; onClose?: () => void }) {
  const active = items.filter(isActive);
  const finished = items.filter((a) => !isActive(a)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const summary = activitySummary(items);
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <VStack gap={0.5}>
            <Heading level={2}>Activity</Heading>
            <Text type="supporting">{summary || (items.length ? "Nothing running now" : "Nothing yet")}</Text>
          </VStack>
        </StackItem>
        {onClose && <IconButton label="Close activity" tooltip="Close" variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={onClose} />}
      </HStack>
      {!items.length && (
        <EmptyState
          isCompact
          title="Nothing running"
          description="Subagents, background shells, monitors and scheduled wakeups show here while the agent runs them."
        />
      )}
      {ACTIVITY_KINDS.map((k) => {
        const group = active.filter((a) => a.kind === k.id);
        if (!group.length) return null;
        return (
          <VStack key={k.id} gap={0.5}>
            <Text type="label" color="secondary">
              {k.plural[0]!.toUpperCase() + k.plural.slice(1)} · {group.length}
            </Text>
            <Rows sessionId={sessionId} items={group} all={items} harness={harness} />
          </VStack>
        );
      })}
      {finished.length > 0 && (
        <Collapsible defaultIsOpen={!active.length} trigger={<Text type="label" color="secondary">{`Finished · ${finished.length}`}</Text>}>
          <Rows sessionId={sessionId} items={finished} all={items} harness={harness} />
        </Collapsible>
      )}
    </VStack>
  );
}

/** Rows with children (a subagent's own work) right under their parent. */
function Rows({ sessionId, items, all, harness }: { sessionId: string; items: ActivityItem[]; all: ActivityItem[]; harness?: string }) {
  const ids = new Set(items.map((a) => a.id));
  const known = new Set(all.map((a) => a.id));
  const top = items.filter((a) => !a.parentId || !ids.has(a.parentId));
  const out: { a: ActivityItem; depth: number }[] = [];
  const add = (a: ActivityItem, depth: number) => {
    out.push({ a, depth });
    for (const c of items) if (c.parentId === a.id) add(c, depth + 1);
  };
  for (const a of top) add(a, a.parentId && known.has(a.parentId) ? 1 : 0);
  return (
    <VStack>
      {out.map(({ a, depth }) => (
        <VStack key={a.id} style={depth ? nested : undefined}>
          <ActivityRow sessionId={sessionId} item={a} harness={harness} parent={a.parentId ? all.find((p) => p.id === a.parentId)?.title : undefined} />
        </VStack>
      ))}
    </VStack>
  );
}

export function ActivityRow({ sessionId, item: a, harness, parent }: { sessionId: string; item: ActivityItem; harness?: string; parent?: string }) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const st = STATUS[a.status];
  const live = isActive(a);
  useEffect(() => {
    if (!live) setStopping(false);
  }, [live]);
  return (
    <VStack>
      <Item
        density="compact"
        align="start"
        isSelected={open}
        onClick={() => setOpen(!open)}
        startContent={<StatusDot variant={st.variant} label={st.label} tooltip={st.label} isPulsing={a.status === "running"} />}
        label={a.title}
        labelLines={1}
        description={rowDescription(a, harness) || undefined}
        descriptionLines={open ? 3 : 1}
        endContent={
          <HStack gap={1} vAlign="center">
            {a.status === "running" ? (
              <Timer startTime={a.startedAt} />
            ) : a.endedAt ? (
              <Tooltip content={`${st.label} ${fmtClock(a.endedAt)}`}>
                <Text type="supporting" hasTabularNumbers>
                  {duration(a.endedAt - a.startedAt)}
                </Text>
              </Tooltip>
            ) : null}
            {live && a.stoppable && (
              <IconButton
                label={`Stop ${a.title}`}
                tooltip="Stop"
                variant="ghost"
                size="sm"
                isLoading={stopping}
                icon={<Icon icon="stop" />}
                onClick={(e) => {
                  e.stopPropagation();
                  setStopping(true);
                  act("stopActivity", { sessionId, id: a.id }).then((r) => r === undefined && setStopping(false));
                }}
              />
            )}
          </HStack>
        }
      />
      {open && <ActivityDetails item={a} harness={harness} parent={parent} />}
    </VStack>
  );
}

function ActivityDetails({ item: a, harness, parent }: { item: ActivityItem; harness?: string; parent?: string }) {
  const model = a.model ? modelDisplay(a.model, harness) : undefined;
  const facts: [string, string][] = [];
  if (a.agentType) facts.push(["Agent", a.agentType]);
  if (model) facts.push(["Model", model.name]);
  if (a.toolUses) facts.push(["Tool uses", String(a.toolUses)]);
  if (a.tokens) facts.push(["Tokens", tokens(a.tokens)]);
  if (a.worktree) facts.push(["Worktree", a.worktree.branch ?? a.worktree.path ?? "isolated copy"]);
  if (a.schedule) facts.push(["Schedule", a.schedule]);
  if (a.nextAt && a.status === "waiting") facts.push(["Next", fmtClock(a.nextAt)]);
  if (a.watching && a.watching !== a.command && a.watching !== a.description) facts.push(["Watching", a.watching]);
  if (parent) facts.push(["Started by", parent]);
  if (a.background === false && isActive(a)) facts.push(["Runs", "in the turn (the agent waits for it)"]);
  facts.push(["Started", fmtClock(a.startedAt)]);
  return (
    <VStack gap={2} paddingInlineStart={6} paddingBlock={1.5} paddingInlineEnd={1}>
      <MetadataList label={{ position: "start", width: "35%" }}>
        {facts.map(([k, v]) => (
          <MetadataListItem key={k} label={k}>
            <Text type="supporting">{v}</Text>
          </MetadataListItem>
        ))}
      </MetadataList>
      {a.command && <CodeBlock code={a.command} language="bash" size="sm" width="100%" isWrapped hasLanguageLabel={false} />}
      {a.steps?.length ? (
        <VStack>
          <Text type="label" color="secondary">
            Tool calls{a.toolUses && a.toolUses > a.steps.length ? ` (last ${a.steps.length} of ${a.toolUses})` : ""}
          </Text>
          {a.steps.map((s) => (
            <Item
              key={s.id}
              density="compact"
              layout="inline"
              startContent={
                s.status === "running" ? <Spinner size="sm" /> : <StatusDot variant={s.status === "error" ? "error" : "neutral"} label={s.status === "error" ? "Failed" : "Done"} />
              }
              label={<Text type="supporting">{s.label}</Text>}
            />
          ))}
        </VStack>
      ) : null}
      {a.output && <CodeBlock code={a.output} title="Output (latest lines)" size="sm" width="100%" maxHeight="40vh" isWrapped />}
      {a.summary && (
        <VStack gap={1}>
          <Text type="label" color="secondary">
            {a.status === "failed" ? "Error" : a.kind === "subagent" ? "Report" : "Result"}
          </Text>
          <Markdown density="compact">{a.summary}</Markdown>
        </VStack>
      )}
      {a.description && a.description !== a.title && (
        <Collapsible defaultIsOpen={false} trigger={<Text type="label" color="secondary">{a.kind === "schedule" ? "Prompt" : "Task"}</Text>}>
          <Text type="supporting" style={preWrap}>
            {a.description}
          </Text>
        </Collapsible>
      )}
    </VStack>
  );
}
