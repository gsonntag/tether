// Home: every connected runner's sessions at a glance, live (runner pulses, no polling). What needs
// you (approve, answer, review), what's running, and what finished recently. Phones land here.
// Frame from Astryx's dashboard-alert-rail template: header | content | triage rail (Needs you),
// with the rail folded to the top of the content on narrow screens.

import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { BottomSheet } from "@astryxdesign/core/BottomSheet";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { Item } from "@astryxdesign/core/Item";
import { HStack, Layout, LayoutContent, LayoutHeader, LayoutPanel, StackItem, VStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { BellAlertIcon, BoltIcon, CheckCircleIcon, PlusIcon, StopIcon } from "@heroicons/react/24/outline";
import type { MemoryConflict, SessionPulse, UiRequest, UiResponse } from "../shared/protocol";
import { activityLine, answerRequest, contextPercent, diffLabel, elapsed, groupDashboard, oneTapQuestion, requestLine, type NeedRow, type PulseRow } from "../dashboard";
import { openOnRunner, openPage, patchPulse, resolveConflict, rpcTo, toast, useStore } from "../store";
import { ago } from "../util";
import { HarnessBadge } from "./HarnessBadge";
import { ModelName } from "./ModelName";
import { WorkIndicator } from "./WorkIndicator";
import { pulseWork, workState } from "../workState";
import { removeSession } from "./Sidebar";

const project = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Re-renders every second while something on screen counts up. */
function useNow(on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Press and hold (touch) or right-click: the row's actions. The click that ends a hold is swallowed. */
function useLongPress(onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fired = useRef(false);
  const cancel = () => clearTimeout(timer.current);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      fired.current = false;
      timer.current = setTimeout(() => {
        fired.current = true;
        navigator.vibrate?.(10);
        onLong();
      }, 500);
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      cancel();
      onLong();
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (fired.current) {
        fired.current = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
  };
}

async function call<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e: any) {
    toast("error", e?.message ?? String(e));
    return undefined;
  }
}

/**
 * Approve / deny / answer from Home: exactly this request (runner, session and request id), once;
 * the row leaves when the runner took it or says it's no longer waiting.
 */
async function respond(row: NeedRow, response: Omit<UiResponse, "id">) {
  const r = await call(answerRequest(row, response, (runnerId, args) => rpcTo(runnerId, "uiRespond", args)));
  if (r === "stale") toast("info", "That request was already answered or has expired.");
  if (r === "ok" || r === "stale") {
    const { runnerId, pulse, request } = row;
    patchPulse(runnerId, pulse.session.id, (p) => ({ ...p, pendingUi: p.pendingUi?.filter((x) => x.id !== request.id) }));
  }
}

async function stop(row: PulseRow) {
  await call(rpcTo(row.runnerId, "abort", { sessionId: row.pulse.session.id }));
}

async function remove(row: PulseRow) {
  const s = row.pulse.session;
  if (row.runnerId === useStore.getState().runnerId) await removeSession(s);
  else if ((await call(rpcTo(row.runnerId, "removeSession", { sessionId: s.id }))) === undefined) return;
  patchPulse(row.runnerId, s.id, () => undefined);
}

export function Dashboard({ focus }: { focus?: "running" }) {
  const pulses = useStore((s) => s.pulses);
  const runners = useStore((s) => s.runners);
  const runnerId = useStore((s) => s.runnerId);
  const conflicts = useStore((s) => s.conflicts);
  const sidebarHidden = useStore((s) => s.sidebarHidden);
  const narrow = useMediaQuery("(max-width: 1024px)");
  const phone = useMediaQuery("(max-width: 767px)");
  const online = runners.filter((r) => r.connected);
  const multi = online.length > 1;
  const { needs, running, finished } = groupDashboard(pulses);
  const now = useNow(running.length > 0);
  const loaded = online.every((r) => pulses[r.id]);

  useEffect(() => {
    if (focus === "running") document.getElementById("home-running")?.scrollIntoView({ block: "start" });
  }, [focus]);

  const needCount = needs.length + conflicts.length;
  const ctx: RowCtx = { multi, phone, now };

  const needsSection = (
    <Section
      icon={BellAlertIcon}
      title="Needs you"
      count={needCount}
      countVariant="error"
      empty={<EmptyState isCompact title="Nothing needs you" description="Approvals, questions and plans to review show here." icon={<Icon icon={CheckCircleIcon} size="lg" color="success" />} />}
    >
      {needs.map((n) => (
        <NeedItem key={`${n.runnerId}:${n.request.id}`} row={n} ctx={ctx} />
      ))}
      {conflicts.map((c) => runnerId && <ConflictItem key={c.id} c={c} runnerId={runnerId} ctx={ctx} />)}
    </Section>
  );

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader padding={phone ? 4 : 6} hasDivider>
          {/* Room for the floating sidebar button on phones (and with the sidebar hidden). */}
          <HStack gap={3} vAlign="center" hAlign="between" wrap="wrap" paddingInlineStart={phone || sidebarHidden ? 8 : 0}>
            <VStack gap={0} vAlign="center">
              <Heading level={1}>Home</Heading>
              <HStack gap={2} vAlign="center">
                <StatusDot variant={online.length ? "success" : "neutral"} label={online.length ? "Live" : "No runner"} isPulsing={running.length > 0} />
                <Text type="supporting">
                  {[`${running.length} running`, needCount ? `${needCount} need${needCount === 1 ? "s" : ""} you` : "", multi ? `${online.length} runners` : ""].filter(Boolean).join(" · ")}
                </Text>
              </HStack>
            </VStack>
            <Button
              label="New session"
              variant="primary"
              size={phone ? "lg" : "md"}
              icon={<Icon icon={PlusIcon} />}
              isIconOnly={phone}
              onClick={() => useStore.setState({ dialog: "new", newSessionProject: undefined })}
            />
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={phone ? 0 : 6} role="main">
          <VStack gap={phone ? 4 : 8} paddingBlock={phone ? 2 : 0}>
            {narrow && needCount > 0 && needsSection}
            <VStack id="home-running">
              <Section
                icon={BoltIcon}
                title="Running"
                count={running.length}
                countVariant="info"
                empty={
                  loaded ? (
                    <EmptyState isCompact title="Nothing running" description="Agents keep running on your runners when you close this page." />
                  ) : (
                    <Spinner label="Loading…" />
                  )
                }
              >
                {running.map((r) => (
                  <RunningItem key={`${r.runnerId}:${r.pulse.session.id}`} row={r} ctx={ctx} />
                ))}
              </Section>
            </VStack>
            <Section icon={CheckCircleIcon} title="Recently finished" count={0} empty={loaded ? <Text type="supporting">No finished turns since the runner started.</Text> : null}>
              {finished.map((r) => (
                <FinishedItem key={`${r.runnerId}:${r.pulse.session.id}`} row={r} ctx={ctx} />
              ))}
            </Section>
            {narrow && needCount === 0 && needsSection}
          </VStack>
        </LayoutContent>
      }
      end={
        narrow ? undefined : (
          <LayoutPanel width={400} padding={0} hasDivider role="complementary" label="Needs you" isScrollable>
            {needsSection}
          </LayoutPanel>
        )
      }
    />
  );
}

interface RowCtx {
  multi: boolean;
  phone: boolean;
  now: number;
}

function Section({
  icon,
  title,
  count,
  countVariant = "neutral",
  empty,
  children,
}: {
  icon: typeof BoltIcon;
  title: string;
  count: number;
  countVariant?: "neutral" | "info" | "error";
  empty: ReactNode;
  children: ReactNode;
}) {
  const rows = Children.toArray(children);
  return (
    <VStack gap={0}>
      <HStack gap={2} vAlign="center" paddingInline={4} paddingBlock={3}>
        <Icon icon={icon} size="sm" color="secondary" />
        <StackItem size="fill">
          <Heading level={2}>{title}</Heading>
        </StackItem>
        {count > 0 && <Badge label={count} variant={countVariant} />}
      </HStack>
      <Divider />
      {rows.length ? (
        rows.map((row, i) => (
          <VStack key={(row as { key?: string }).key ?? i} gap={0}>
            {i > 0 && <Divider />}
            {row}
          </VStack>
        ))
      ) : (
        <VStack padding={4}>{empty}</VStack>
      )}
    </VStack>
  );
}

/** project · runner · model */
function Where({ p, runnerId, ctx, extra }: { p: SessionPulse; runnerId: string; ctx: RowCtx; extra?: ReactNode }) {
  return (
    <HStack gap={1.5} vAlign="center" wrap="wrap">
      <Text type="supporting" maxLines={1}>
        {project(p.session.projectPath)}
      </Text>
      {ctx.multi && <Token size="sm" color="gray" label={runnerId} />}
      {p.model && (
        <Text type="supporting">
          <ModelName id={p.model} harness={p.session.harness} />
        </Text>
      )}
      {extra}
    </HStack>
  );
}

function StatusOf({ p }: { p: SessionPulse }) {
  if (p.pendingUi?.length) return <StatusDot variant="error" label="Needs you" tooltip="Waiting for you" isPulsing />;
  return <WorkIndicator work={pulseWork(p)} />;
}

/** The Running row's status line: what it's doing now, or that only background work or a wakeup is left. */
function statusLine(p: SessionPulse): string {
  const state = workState(pulseWork(p));
  // A subagent asking for approval while the main agent is idle: the ask is what matters.
  if (p.pendingUi?.length) return p.action ?? "Waiting for you";
  if (state === "background") return ["Background", p.action].filter(Boolean).join(" · ");
  if (state === "scheduled") return "Waiting for a scheduled wakeup";
  return p.action ?? (state === "idle" ? "" : "Working");
}

function ContextMini({ p }: { p: SessionPulse }) {
  const pct = contextPercent(p);
  if (pct === undefined) return null;
  const variant = pct >= 95 ? "error" : pct >= 80 ? "warning" : "accent";
  return (
    <HStack gap={1} vAlign="center">
      <ProgressBar label="Context window used" isLabelHidden value={pct} variant={variant} style={{ width: "var(--spacing-10)" }} />
      <Text type="supporting" hasTabularNumbers>
        {Math.round(pct)}%
      </Text>
    </HStack>
  );
}

/** The row's actions, from its ⋯ menu or a long press. */
function rowActions(row: PulseRow, running: boolean) {
  const s = row.pulse.session;
  return [
    { label: "Open", onClick: () => openOnRunner(row.runnerId, s) },
    { label: "Activity", onClick: () => openOnRunner(row.runnerId, s, { activity: true }) },
    ...(running && s.status !== "idle" ? [{ label: "Stop", onClick: () => stop(row) }] : []),
    { type: "divider" as const },
    { label: s.live ? "Stop and remove" : "Remove", variant: "destructive" as const, onClick: () => remove(row) },
  ];
}

/** A row: the tappable session (opens it) with its controls beside it, plus a long-press sheet. */
function Row({ row, running, ctx, children, controls }: { row: PulseRow; running: boolean; ctx: RowCtx; children: ReactNode; controls?: ReactNode }) {
  const [sheet, setSheet] = useState(false);
  const press = useLongPress(() => setSheet(true));
  const actions = rowActions(row, running);
  return (
    <HStack gap={1} vAlign="center" paddingInlineEnd={2} {...press}>
      <StackItem size="fill">{children}</StackItem>
      {/* static: a long title truncates instead of squeezing Stop to "S…" */}
      {controls && <StackItem>{controls}</StackItem>}
      <MoreMenu label="Session actions" size={ctx.phone ? "lg" : "md"} alignment="end" presentation="adaptive" items={actions} />
      <BottomSheet isOpen={sheet} onOpenChange={setSheet} label={row.pulse.session.title} height="hug">
        <VStack gap={0} padding={2}>
          <VStack padding={2}>
            <Text type="label" weight="semibold" maxLines={1}>
              {row.pulse.session.title}
            </Text>
          </VStack>
          {actions.map((a, i) =>
            "type" in a ? (
              <Divider key={i} />
            ) : (
              <Button
                key={a.label}
                label={a.label}
                variant={"variant" in a && a.variant === "destructive" ? "destructive" : "ghost"}
                size="lg"
                width="100%"
                onClick={() => {
                  setSheet(false);
                  a.onClick();
                }}
              />
            ),
          )}
        </VStack>
      </BottomSheet>
    </HStack>
  );
}

function RunningItem({ row, ctx }: { row: PulseRow; ctx: RowCtx }) {
  const p = row.pulse;
  const s = p.session;
  const acts = activityLine(p);
  const [stopping, setStopping] = useState(false);
  const busy = s.status !== "idle";
  return (
    <Row
      row={row}
      running
      ctx={ctx}
      controls={
        busy ? (
          <Button
            label="Stop"
            variant="secondary"
            size={ctx.phone ? "lg" : "md"}
            icon={<Icon icon={StopIcon} />}
            isIconOnly={ctx.phone}
            isLoading={stopping}
            onClick={() => {
              setStopping(true);
              stop(row).finally(() => setStopping(false));
            }}
          />
        ) : undefined
      }
    >
      <Item
        align="start"
        onClick={() => openOnRunner(row.runnerId, s)}
        startContent={
          <VStack gap={1.5} hAlign="center" paddingBlockStart={0.5}>
            <HarnessBadge harness={s.harness} />
            <StatusOf p={p} />
          </VStack>
        }
        label={s.title}
        labelLines={1}
        description={
          <VStack gap={0.5}>
            <Where p={p} runnerId={row.runnerId} ctx={ctx} />
            <Text type="supporting" maxLines={1} color="primary">
              {[statusLine(p), busy && p.turnStartedAt ? elapsed(ctx.now - p.turnStartedAt) : ""].filter(Boolean).join(" · ")}
            </Text>
            {(acts || contextPercent(p) !== undefined) && (
              <HStack gap={2} vAlign="center" wrap="wrap">
                {acts && <Text type="supporting">{acts}</Text>}
                <ContextMini p={p} />
              </HStack>
            )}
          </VStack>
        }
      />
    </Row>
  );
}

function FinishedItem({ row, ctx }: { row: PulseRow; ctx: RowCtx }) {
  const p = row.pulse;
  const s = p.session;
  const diff = diffLabel(p);
  return (
    <Row row={row} running={false} ctx={ctx}>
      <Item
        align="start"
        onClick={() => openOnRunner(row.runnerId, s)}
        startContent={<HarnessBadge harness={s.harness} />}
        label={s.title}
        labelLines={1}
        description={
          <VStack gap={0.5}>
            <Where
              p={p}
              runnerId={row.runnerId}
              ctx={ctx}
              extra={
                <>
                  {diff && (
                    <Text type="supporting" hasTabularNumbers>
                      {diff}
                    </Text>
                  )}
                  <Text type="supporting">{ago(p.finishedAt!)}</Text>
                </>
              }
            />
            {p.lastText && (
              <Text type="supporting" color="primary" maxLines={2}>
                {p.lastText}
              </Text>
            )}
          </VStack>
        }
      />
    </Row>
  );
}

/** One waiting approval, question or plan, with what can be answered right here. */
function NeedItem({ row, ctx }: { row: NeedRow; ctx: RowCtx }) {
  const { pulse: p, request: r } = row;
  const [busy, setBusy] = useState("");
  const size = ctx.phone ? "lg" : "md";
  const run = (key: string, response: Parameters<typeof respond>[1]) => {
    if (busy) return;
    setBusy(key);
    respond(row, response).finally(() => setBusy(""));
  };
  // While one answer is in flight the others can't be sent (answerRequest also drops repeats).
  const state = (key: string) => ({ isLoading: busy === key, isDisabled: !!busy && busy !== key });
  const open = () => openOnRunner(row.runnerId, p.session);
  const q = oneTapQuestion(r);
  let actions: ReactNode;
  if (r.kind === "permission")
    actions = (
      <>
        {/* A call too long to show here is approved from the session, where it's shown in full. */}
        {(r.tool?.input as { truncated?: boolean } | undefined)?.truncated ? (
          <Button label="Review" variant="primary" size={size} isDisabled={!!busy} onClick={open} />
        ) : (
          <Button label="Approve" variant="primary" size={size} {...state("allow")} onClick={() => run("allow", { allow: true })} />
        )}
        <Button label="Deny" variant="secondary" size={size} {...state("deny")} onClick={() => run("deny", { allow: false })} />
      </>
    );
  else if (q)
    actions = q.options.map((o) => (
      <Button key={o.label} label={o.label} variant="secondary" size={size} {...state(o.label)} onClick={() => run(o.label, { answers: { [q.question]: o.label } })} />
    ));
  else if (r.kind === "confirm")
    actions = (
      <>
        <Button label="Yes" variant="primary" size={size} {...state("yes")} onClick={() => run("yes", { confirmed: true })} />
        <Button label="No" variant="secondary" size={size} {...state("no")} onClick={() => run("no", { confirmed: false })} />
      </>
    );
  else actions = <Button label={r.kind === "plan" ? "Review plan" : "Answer"} variant="primary" size={size} onClick={open} />;
  return (
    <VStack gap={1.5} paddingBlockEnd={3}>
      <Item
        align="start"
        onClick={open}
        startContent={<HarnessBadge harness={p.session.harness} />}
        label={p.session.title}
        labelLines={1}
        description={
          <VStack gap={0.5}>
            <Where p={p} runnerId={row.runnerId} ctx={ctx} extra={<Text type="supporting">{kindLabel(r)}</Text>} />
            <Text type={r.kind === "permission" ? "code" : "body"} maxLines={3}>
              {requestLine(r)}
            </Text>
          </VStack>
        }
      />
      <HStack gap={2} wrap="wrap" paddingInline={3}>
        {actions}
        {(r.kind === "permission" || q || r.kind === "confirm") && <Button label="Open" variant="ghost" size={size} onClick={open} />}
      </HStack>
    </VStack>
  );
}

const kindLabel = (r: UiRequest) =>
  r.kind === "permission" ? "Approval" : r.kind === "plan" ? "Plan review" : r.kind === "question" ? "Question" : "Input";

function ConflictItem({ c, runnerId, ctx }: { c: MemoryConflict; runnerId: string; ctx: RowCtx }) {
  const [busy, setBusy] = useState("");
  const size = ctx.phone ? "lg" : "md";
  const run = (action: "keep-new" | "keep-old") => {
    setBusy(action);
    resolveConflict(c.id, action).finally(() => setBusy(""));
  };
  return (
    <VStack gap={1.5} paddingBlockEnd={3}>
      <Item
        align="start"
        onClick={() => openPage("memory", "conflicts")}
        startContent={<StatusDot variant="warning" label="Conflicting memory" />}
        label={`Memory conflict: ${c.name}`}
        labelLines={1}
        description={
          <VStack gap={0.5}>
            {ctx.multi && <Token size="sm" color="gray" label={runnerId} />}
            <Text type="supporting" maxLines={2}>
              Now: {c.newClaim ?? c.newBody}
            </Text>
            <Text type="supporting" maxLines={2}>
              Before: {c.oldClaim ?? c.oldBody}
            </Text>
          </VStack>
        }
      />
      <HStack gap={2} wrap="wrap" paddingInline={3}>
        <Button label="Keep new" variant="primary" size={size} isLoading={busy === "keep-new"} onClick={() => run("keep-new")} />
        <Button label="Keep old" variant="secondary" size={size} isLoading={busy === "keep-old"} onClick={() => run("keep-old")} />
      </HStack>
    </VStack>
  );
}
