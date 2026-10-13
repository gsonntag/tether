// Everything a session has going on besides the transcript: subagents, background shells,
// monitors, workflows, cron jobs and wakeups.
//  - The strip above the message box: one live row per running item (what it's doing now, how
//    long), a workflow's step, children under their parent; armed items as one quiet line.
//  - The history panel (a side panel on desktop, a sheet on phones): finished items with their
//    reports and output, opened from the settings bar.

import { useEffect, useMemo, useState, type ComponentType, type CSSProperties, type SVGProps } from "react";
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
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Text } from "@astryxdesign/core/Text";
import { Timer } from "@astryxdesign/core/Timer";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { CheckCircleIcon, ClockIcon, CommandLineIcon, CpuChipIcon, EyeIcon, QueueListIcon, Squares2X2Icon, WrenchScrewdriverIcon } from "@heroicons/react/24/outline";
import { modelDisplay } from "../models";
import { activityOf, childrenOf, currentPhase, historyItems, nowLine, phaseLabel, STRIP_ROWS, stripModel } from "../activity";
import { isActive, type ActivityItem, type ActivityKind, type ActivityStatus, type LiveState } from "../shared/protocol";
import { act, setActivityOpen, useStore } from "../store";
import { fmtClock } from "../util";

const NARROW = "(max-width: 767px)";
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
/** The strip: a quiet bordered list right above the composer. */
const strip: CSSProperties = { border: "var(--border-width) solid var(--color-border)", borderRadius: "var(--radius-container)", background: "var(--color-background-surface)", overflow: "hidden" };
/** An opened row's details scroll inside the strip, so the composer doesn't fly up the screen. */
const stripDetails: CSSProperties = { maxHeight: "40vh", overflowY: "auto" };
const titleCap: CSSProperties = { display: "block", maxWidth: "min(50vw, calc(var(--spacing-4) * 24))" };
const indent = (depth: number): CSSProperties | undefined => (depth ? { paddingInlineStart: `calc(var(--spacing-4) * ${depth})` } : undefined);

const KIND_ICON: Record<ActivityKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  subagent: CpuChipIcon,
  shell: CommandLineIcon,
  monitor: EyeIcon,
  workflow: QueueListIcon,
  schedule: ClockIcon,
  tool: WrenchScrewdriverIcon,
  other: Squares2X2Icon,
};

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

/** What an agent is, for a finished row with nothing else to say. */
const what = (a: ActivityItem, harness?: string) => [a.agentType, a.model ? modelDisplay(a.model, harness).name : undefined].filter(Boolean).join(" · ");

/** The second line of a history row: its result. */
function resultLine(a: ActivityItem, harness?: string): string {
  if (a.kind === "workflow" && a.phases?.length) {
    const done = a.phases.filter((p) => p.status === "done").length;
    const end = a.summary?.split("\n").find((l) => l.trim());
    return end ?? `${done} of ${a.phases.length} steps done`;
  }
  return a.summary?.split("\n").find((l) => l.trim()) ?? what(a, harness);
}

function stopItem(sessionId: string, a: ActivityItem, setStopping: (b: boolean) => void) {
  setStopping(true);
  act("stopActivity", { sessionId, id: a.id }).then((r) => r === undefined && setStopping(false));
}

// ---------- the strip ----------

/** Above the message box: what's running besides the main agent, live. Nothing when nothing is. */
export function ActivityStrip({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const harness = useStore((s) => s.open[sessionId]?.session?.harness);
  const items = activityOf(state);
  const { rows, waiting } = useMemo(() => stripModel(items), [items]);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [waitOpen, setWaitOpen] = useState(false);
  if (!rows.length && !waiting.length) return null;
  // Never "1 more": a fifth row shows itself.
  const capped = rows.length > STRIP_ROWS + 1;
  const shown = all || !capped ? rows : rows.slice(0, STRIP_ROWS);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
  const openItem = open ? items.find((a) => a.id === open) : undefined;
  return (
    <VStack style={strip} role="region" aria-label="Running now">
      {shown.map(({ item, depth }) =>
        // An opened workflow shows its agents in its step track.
        open && item.parentId === open && openItem?.phases?.length ? null : (
          <VStack key={item.id} style={indent(depth)}>
            <LiveRow item={item} harness={harness} isOpen={open === item.id} onToggle={() => toggle(item.id)} />
            {open === item.id && (
              <VStack style={stripDetails}>
                <ActivityDetails sessionId={sessionId} item={item} all={items} harness={harness} />
              </VStack>
            )}
          </VStack>
        ),
      )}
      {capped ? (
        <Button label={all ? "Show fewer" : `${rows.length - shown.length} more running`} variant="ghost" size="sm" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `${rows.length - shown.length} more`}
        </Button>
      ) : null}
      {waiting.length > 0 && (
        <>
          <WaitingLine items={waiting} isOpen={waitOpen} onToggle={() => setWaitOpen(!waitOpen)} />
          {waitOpen && (
            <VStack style={stripDetails} paddingInlineStart={4}>
              {waiting.map((a) => (
                <ActivityRow key={a.id} sessionId={sessionId} item={a} all={items} harness={harness} />
              ))}
            </VStack>
          )}
        </>
      )}
    </VStack>
  );
}

/** One running item on one line: icon, title, what it's doing now, elapsed time. */
function LiveRow({ item: a, harness, isOpen, onToggle }: { item: ActivityItem; harness?: string; isOpen: boolean; onToggle: () => void }) {
  const step = a.kind === "workflow" ? phaseLabel(a) : undefined;
  const now = nowLine(a);
  const line = step ? (now && !now.startsWith(currentPhase(a)!.title) ? `${step} · ${now}` : step) : (now ?? what(a, harness));
  return (
    <Item
      density="compact"
      layout="inline"
      isSelected={isOpen}
      onClick={onToggle}
      startContent={<Icon icon={KIND_ICON[a.kind]} size="sm" color="accent" />}
      // An inline Item never shrinks its label: cap it so a long title leaves room for the rest.
      label={
        <Text maxLines={1} style={titleCap}>
          {a.title}
        </Text>
      }
      description={line || undefined}
      descriptionLines={1}
      endContent={<Timer startTime={a.startedAt} />}
    />
  );
}

/** Armed wakeups and cron jobs: one quiet line ("Next 14:30"), opened into their rows. */
function WaitingLine({ items, isOpen, onToggle }: { items: ActivityItem[]; isOpen: boolean; onToggle: () => void }) {
  const next = items.find((a) => a.nextAt)?.nextAt;
  const label = items.length === 1 ? items[0]!.title : `${items.length} scheduled`;
  const when = next ? `Next ${fmtClock(next)}` : items.length === 1 ? items[0]!.schedule : undefined;
  return (
    <Item
      density="compact"
      layout="inline"
      isSelected={isOpen}
      onClick={onToggle}
      startContent={<Icon icon={ClockIcon} size="sm" color="secondary" />}
      label={<Text type="supporting">{label}</Text>}
      description={when}
    />
  );
}

// ---------- the history panel ----------

/** In the settings bar: opens the finished work, when there is some. */
export function ActivityButton({ state }: { state: LiveState }) {
  const open = useStore((s) => s.activityOpen);
  const n = historyItems(activityOf(state)).length;
  if (!n) return null;
  return (
    <Button
      label={`Finished work: ${n}`}
      tooltip={open ? "Hide finished work" : "Finished subagents, shells and workflows, with their reports and output"}
      variant="ghost"
      size="sm"
      icon={<Icon icon={CheckCircleIcon} />}
      onClick={() => setActivityOpen(!open)}
    >
      {`${n} finished`}
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
      <BottomSheet isOpen={open} onOpenChange={setActivityOpen} label="Finished" height="tall" padding={3}>
        <ActivityList sessionId={sessionId} items={items} harness={harness} />
      </BottomSheet>
    );
  if (!open) return null;
  return (
    <LayoutPanel width={400} hasDivider isScrollable label="Finished" padding={3}>
      <ActivityList sessionId={sessionId} items={items} harness={harness} onClose={() => setActivityOpen(false)} />
    </LayoutPanel>
  );
}

/** Finished items, newest first; a workflow's agents and a subagent's shells open inside it. */
export function ActivityList({ sessionId, items, harness, onClose }: { sessionId: string; items: ActivityItem[]; harness?: string; onClose?: () => void }) {
  const done = historyItems(items);
  return (
    <VStack gap={3}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Heading level={2}>Finished</Heading>
        </StackItem>
        {onClose && <IconButton label="Close" tooltip="Close" variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={onClose} />}
      </HStack>
      {!done.length ? (
        <EmptyState isCompact title="Nothing finished yet" description="Subagents, shells and workflows land here with their reports and output once they end." />
      ) : (
        <VStack>
          {done.map((a) => (
            <ActivityRow key={a.id} sessionId={sessionId} item={a} all={items} harness={harness} />
          ))}
        </VStack>
      )}
    </VStack>
  );
}

/** A row that opens into its details: history, armed items, a workflow's agents. */
export function ActivityRow({ sessionId, item: a, all, harness }: { sessionId: string; item: ActivityItem; all: ActivityItem[]; harness?: string }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[a.status];
  const live = isActive(a);
  const line =
    a.status === "waiting" ? (a.nextAt ? `Next ${fmtClock(a.nextAt)}${a.schedule ? ` · ${a.schedule}` : ""}` : a.schedule) : live ? (nowLine(a) ?? what(a, harness)) : resultLine(a, harness);
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
        description={line || undefined}
        descriptionLines={open ? 3 : 1}
        endContent={
          a.status === "running" ? (
            <Timer startTime={a.startedAt} />
          ) : a.endedAt ? (
            <Tooltip content={`${st.label} ${fmtClock(a.endedAt)}`}>
              <Text type="supporting" hasTabularNumbers>
                {duration(a.endedAt - a.startedAt)}
              </Text>
            </Tooltip>
          ) : undefined
        }
      />
      {open && <ActivityDetails sessionId={sessionId} item={a} all={all} harness={harness} />}
    </VStack>
  );
}

// ---------- details ----------

function ActivityDetails({ sessionId, item: a, all, harness }: { sessionId: string; item: ActivityItem; all: ActivityItem[]; harness?: string }) {
  const [stopping, setStopping] = useState(false);
  const live = isActive(a);
  useEffect(() => {
    if (!live) setStopping(false);
  }, [live]);
  const model = a.model ? modelDisplay(a.model, harness) : undefined;
  const parent = a.parentId ? all.find((p) => p.id === a.parentId)?.title : undefined;
  const children = childrenOf(all, a.id);
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
  if (a.background === false && live) facts.push(["Runs", "in the turn (the agent waits for it)"]);
  facts.push(["Started", fmtClock(a.startedAt)]);
  return (
    <VStack gap={2} paddingInlineStart={6} paddingBlock={1.5} paddingInlineEnd={1}>
      {live && a.stoppable && (
        <HStack>
          <Button label={`Stop ${a.title}`} size="sm" icon={<Icon icon="stop" />} isLoading={stopping} onClick={() => stopItem(sessionId, a, setStopping)}>
            Stop
          </Button>
        </HStack>
      )}
      {a.phases?.length ? <PhaseTrack sessionId={sessionId} item={a} kids={children} all={all} harness={harness} /> : null}
      {!a.phases?.length && children.length > 0 && (
        <VStack>
          <Text type="label" color="secondary">
            {a.kind === "workflow" ? "Agents" : "Started"}
          </Text>
          {children.map((c) => (
            <ActivityRow key={c.id} sessionId={sessionId} item={c} all={all} harness={harness} />
          ))}
        </VStack>
      )}
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
              startContent={s.status === "running" ? <Spinner size="sm" /> : <StatusDot variant={s.status === "error" ? "error" : "neutral"} label={s.status === "error" ? "Failed" : "Done"} />}
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
        <Collapsible
          defaultIsOpen={false}
          trigger={
            <Text type="label" color="secondary">
              {a.kind === "schedule" ? "Prompt" : a.kind === "workflow" ? "Script" : "Task"}
            </Text>
          }
        >
          <Text type="supporting" style={preWrap}>
            {a.description}
          </Text>
        </Collapsible>
      )}
    </VStack>
  );
}

/**
 * A workflow's phases as a step track: done ✓, the one it's on, the ones to come. Under each
 * phase, its agents; the current and failed phases show them open, finished ones fold them.
 */
function PhaseTrack({ sessionId, item: a, kids, all, harness }: { sessionId: string; item: ActivityItem; kids: ActivityItem[]; all: ActivityItem[]; harness?: string }) {
  const phases = a.phases!;
  const cur = currentPhase(a);
  const active = cur?.index ?? phases.length;
  const loose = kids.filter((c) => c.phase === undefined || c.phase >= phases.length);
  return (
    <VStack gap={1}>
      <Stepper activeStep={active} orientation="vertical" density="compact" label={`${a.title} steps`}>
        {phases.map((p, i) => {
          const mine = kids.filter((c) => c.phase === i);
          const openAgents = p.status === "running" || p.status === "failed" || i === active;
          return (
            <Step
              key={i}
              step={i}
              label={p.title}
              description={p.detail}
              status={p.status === "failed" ? "error" : p.status === "running" ? "accent" : undefined}
              indicator={
                p.status === "running" ? <Spinner size="sm" /> : p.status === "failed" ? <Icon icon="error" size="sm" /> : p.status === "done" && i > active ? <Icon icon="check" size="sm" /> : "auto"
              }
            >
              {mine.length > 0 &&
                (openAgents ? (
                  <VStack>
                    {mine.map((c) => (
                      <ActivityRow key={c.id} sessionId={sessionId} item={c} all={all} harness={harness} />
                    ))}
                  </VStack>
                ) : (
                  <Collapsible defaultIsOpen={false} trigger={<Text type="supporting">{`${mine.length} ${mine.length === 1 ? "agent" : "agents"}`}</Text>}>
                    <VStack>
                      {mine.map((c) => (
                        <ActivityRow key={c.id} sessionId={sessionId} item={c} all={all} harness={harness} />
                      ))}
                    </VStack>
                  </Collapsible>
                ))}
            </Step>
          );
        })}
      </Stepper>
      {loose.map((c) => (
        <ActivityRow key={c.id} sessionId={sessionId} item={c} all={all} harness={harness} />
      ))}
    </VStack>
  );
}
