// Home, the main page: one ranked inbox of what waits on you across every connected runner
// (dashboard.ts rankInbox: approvals, questions and plans, blocked calls, memory conflicts, then
// finished turns you haven't opened), answerable in place; then what's working, and a few
// sessions to continue. Live (runner pulses, no polling).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useContainerReveal, useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Layout, LayoutContent, LayoutHeader, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Timer } from "@astryxdesign/core/Timer";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ChatBubbleLeftRightIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { listPath, NOTIFY_KINDS, type SessionPulse, type SessionSummary, type UiResponse } from "../shared/protocol";
import {
  answerRequest,
  blockedLine,
  contextPercent,
  diffLabel,
  firstLine,
  guardNote,
  INBOX_ROWS,
  inboxTitle,
  isShellCall,
  oneTapQuestion,
  permissionVerb,
  requestCall,
  requestLine,
  requestTruncated,
  type InboxRow,
  type NeedRow,
  type PulseRow,
} from "../dashboard";
import type { Entry } from "../recentSessions";
import { useInbox, useSessionGroups } from "../sessionLists";
import { markNoticeRead, markViewed, openLeader, openOnRunner, openPage, patchPulse, refreshNotices, resolveConflict, rpcTo, toast, useStore } from "../store";
import { enablePush, needsHomeScreen, pushOnHere, pushState, pushSupported } from "../push";
import { ago, harnessLabel } from "../util";
import { pulseWork, workState } from "../workState";
import { WorkIndicator } from "./WorkIndicator";
import { HarnessGlyph } from "./HarnessBadge";
import { AgoWithAction, RowMenus, rowMenuKey, TitleLink, type RowMenuItems } from "./RowMenu";
import { archive, removeSession } from "./Sidebar";

/** Continue: the most recently active other sessions. */
const CONTINUE = { desktop: 5, phone: 3 };

const project = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

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

const isLocal = (runnerId: string) => runnerId === useStore.getState().runnerId;

/** A finished turn (or a blocked call that's been dealt with) read without opening it: on this runner, everywhere. */
function markRead(row: { runnerId: string; entry?: Entry; notice?: { id: string } }) {
  const s = row.entry?.session;
  if (!s) return;
  if (isLocal(row.runnerId)) {
    if (row.notice) markNoticeRead(row.notice.id);
    markViewed(s.id);
    return;
  }
  // Another runner's: what's read there is what its pulse says.
  void call(rpcTo(row.runnerId, "markViewed", { sessionId: s.id, projectPath: s.projectPath })).then(
    (r) => r && patchPulse(row.runnerId, s.id, (p) => ({ ...p, session: { ...p.session, viewedAt: Math.max(r.viewedAt, p.session.viewedAt ?? 0) } })),
  );
}

/** A blocked call: approved (the agent retries it) or run by Tether (the agent gets its output). The notice goes. */
async function actOnBlocked(row: InboxRow, op: "approveBlocked" | "runBlocked") {
  const s = row.entry?.session;
  const toolId = row.notice?.toolId;
  if (!s || !toolId) return;
  if ((await call(rpcTo(row.runnerId, op, { sessionId: s.id, toolId }))) === undefined) return;
  markRead(row);
  if (isLocal(row.runnerId)) refreshNotices();
}

async function stop(row: PulseRow) {
  await call(rpcTo(row.runnerId, "abort", { sessionId: row.pulse.session.id }));
}

async function remove(row: PulseRow) {
  const s = row.pulse.session;
  if (isLocal(row.runnerId)) await removeSession(s);
  else if ((await call(rpcTo(row.runnerId, "removeSession", { sessionId: s.id }))) === undefined) return;
  patchPulse(row.runnerId, s.id, () => undefined);
}

async function markDone(row: PulseRow) {
  const s = row.pulse.session;
  if (isLocal(row.runnerId)) await archive(s, true);
  else if ((await call(rpcTo(row.runnerId, "archiveSession", { sessionId: s.id, archived: true }))) === undefined) return;
  patchPulse(row.runnerId, s.id, () => undefined);
}

/** A Home row from a session entry: its pulse (or just its summary, from an older runner), with the freshest summary. */
const rowOf = (e: Entry): PulseRow => ({ runnerId: e.runnerId!, pulse: { ...e.pulse, session: e.session } });

/** A session row's menu (right-click, long-press): Open, Activity, Stop while working, Mark done, Remove. */
function sessionMenu(row: PulseRow): RowMenuItems {
  const s = row.pulse.session;
  return {
    title: s.title,
    items: [
      { label: "Open", onClick: () => openOnRunner(row.runnerId, s) },
      { label: "Activity", onClick: () => openOnRunner(row.runnerId, s, { activity: true }) },
      ...(s.live && s.status !== "idle" ? [{ label: "Stop", onClick: () => void stop(row) }] : []),
      { type: "divider" as const },
      ...(s.status === "idle" ? [{ label: "Mark done", onClick: () => void markDone(row) }] : []),
      { label: s.live ? "Stop and remove" : "Remove", variant: "destructive" as const, onClick: () => void remove(row) },
    ],
  };
}

const rowKey = (e: Entry) => `${e.runnerId}:${e.session.id}`;

export function Dashboard({ focus }: { focus?: "running" }) {
  const pulses = useStore((s) => s.pulses);
  const runners = useStore((s) => s.runners);
  const runnersKnown = useStore((s) => s.runnersKnown);
  const sidebarHidden = useStore((s) => s.sidebarHidden);
  const phone = useMediaQuery("(max-width: 767px)");
  const online = runners.filter((r) => r.connected);
  const multi = online.length > 1;
  const { needs, working, recent } = useSessionGroups("all");
  const inbox = useInbox(needs);
  const [allInbox, setAllInbox] = useState(false);
  const loaded = online.length > 0 && online.every((r) => pulses[r.id]);

  // What's in the bell (finished, blocked) may have moved on since the last session event.
  useEffect(() => refreshNotices(), []);
  useEffect(() => {
    if (focus === "running") document.getElementById("home-working")?.scrollIntoView({ block: "start" });
  }, [focus]);

  const ctx: RowCtx = { multi, phone };
  const continueRows = recent.slice(0, phone ? CONTINUE.phone : CONTINUE.desktop);

  // Every session row on the page, by key, for the shared right-click / long-press menu.
  const byKey = new Map<string, Entry>();
  for (const e of [...needs, ...working, ...continueRows]) byKey.set(rowKey(e), e);
  const menuFor = (key: string) => {
    const e = byKey.get(key);
    return e && sessionMenu(rowOf(e));
  };

  const header = (
    <LayoutHeader padding={phone ? 4 : 6} hasDivider>
      {/* Room for the floating sidebar button on phones (and with the sidebar hidden). */}
      <HStack gap={3} vAlign="center" hAlign="between" paddingInlineStart={phone || sidebarHidden ? 8 : 0}>
        <Heading level={1}>{loaded ? inboxTitle(inbox.length) : "Home"}</Heading>
        <HStack gap={2} vAlign="center">
          <Button
            label="Leader"
            tooltip="Ask your leader where things are at, or tell it what to pass on"
            size={phone ? "lg" : "md"}
            icon={<Icon icon={ChatBubbleLeftRightIcon} />}
            isIconOnly={phone}
            onClick={openLeader}
          />
          <Button
            label="New session"
            variant="primary"
            size={phone ? "lg" : "md"}
            icon={<Icon icon={PlusIcon} />}
            isIconOnly={phone}
            onClick={() => useStore.setState({ dialog: "new", newSessionProject: undefined })}
          />
        </HStack>
      </HStack>
    </LayoutHeader>
  );

  if (runnersKnown && online.length === 0)
    return (
      <Layout
        height="fill"
        header={header}
        content={
          <LayoutContent padding={6} role="main">
            <EmptyState
              title="No runner connected"
              description="Start the runner on a machine (systemctl --user start tether-runner) and its sessions show here; the README's “Production” section sets one up."
            />
          </LayoutContent>
        }
      />
    );

  const shown = allInbox ? inbox : inbox.slice(0, INBOX_ROWS);
  return (
    <Layout
      height="fill"
      contentWidth={phone ? undefined : 960}
      header={header}
      content={
        <LayoutContent padding={phone ? 0 : 6} role="main">
          <RowMenus itemsFor={menuFor}>
            <VStack gap={phone ? 4 : 6} paddingBlockEnd={6}>
              <NotifyBanner hasInbox={inbox.length > 0} />
              {!loaded ? (
                <VStack padding={4}>
                  <Spinner label="Loading…" />
                </VStack>
              ) : (
                inbox.length > 0 && (
                  <VStack gap={1}>
                    <List density="compact" hasDividers>
                      {shown.map((row) => (
                        <InboxItem key={row.key} row={row} ctx={ctx} />
                      ))}
                    </List>
                    {inbox.length > INBOX_ROWS && (
                      <HStack paddingInline={phone ? 2 : 0}>
                        <Button label={allInbox ? "Show fewer" : `Show all ${inbox.length}`} variant="ghost" onClick={() => setAllInbox(!allInbox)} />
                      </HStack>
                    )}
                  </VStack>
                )
              )}
              {working.length > 0 && (
                <VStack id="home-working">
                  <Collapsible defaultIsOpen={!phone || focus === "running"} trigger={<SectionLabel phone={phone}>{`Working · ${working.length}`}</SectionLabel>}>
                    <List density="compact" hasDividers>
                      {working.map((e) => (
                        <WorkingItem key={rowKey(e)} entry={e} ctx={ctx} />
                      ))}
                    </List>
                  </Collapsible>
                </VStack>
              )}
              {continueRows.length > 0 && (
                <Collapsible trigger={<SectionLabel phone={phone}>Continue</SectionLabel>}>
                  <List density="compact" hasDividers>
                    {continueRows.map((e) => (
                      <ContinueItem key={rowKey(e)} entry={e} ctx={ctx} />
                    ))}
                  </List>
                </Collapsible>
              )}
            </VStack>
          </RowMenus>
        </LayoutContent>
      }
    />
  );
}

/** A collapsible group's label; on a phone, in line with the rows' text. */
function SectionLabel({ phone, children }: { phone: boolean; children: ReactNode }) {
  return (
    <HStack paddingInlineStart={phone ? 2 : 0}>
      <Text type="label">{children}</Text>
    </HStack>
  );
}

interface RowCtx {
  multi: boolean;
  phone: boolean;
}

/** Line 2: project · harness · runner (with several) · what it does. */
function Where({ s, runnerId, ctx, verb }: { s: SessionSummary; runnerId: string; ctx: RowCtx; verb: string }) {
  return (
    <HStack gap={1.5} vAlign="center" wrap="wrap">
      <Text type="supporting" maxLines={1}>
        {[project(listPath(s)), harnessLabel(s.harness), verb].join(" · ")}
      </Text>
      {ctx.multi && <Token size="sm" color="gray" label={runnerId} />}
    </HStack>
  );
}

const when = (at: number) => (
  <Tooltip content={new Date(at).toLocaleString()}>
    <Text type="supporting" hasTabularNumbers>
      {ago(at)}
    </Text>
  </Tooltip>
);

/** "waiting 4m", counting. */
const waiting = (at: number) => (
  <Text type="supporting" hasTabularNumbers>
    waiting <Timer startTime={at} type="inherit" color="inherit" />
  </Text>
);

const DOT: Record<InboxRow["kind"], { variant: "error" | "success" | "warning"; label: string }> = {
  permission: { variant: "error", label: "Needs you" },
  ask: { variant: "error", label: "Needs you" },
  blocked: { variant: "error", label: "Blocked" },
  memory: { variant: "warning", label: "Memory conflict" },
  finished: { variant: "success", label: "Finished" },
};

/** One inbox row: what it is, what it's about, and what can be answered right here. */
function InboxItem({ row, ctx }: { row: InboxRow; ctx: RowCtx }) {
  const link = useRef<HTMLButtonElement>(null);
  const reveal = useContainerReveal();
  const [busy, setBusy] = useState("");
  const size = ctx.phone ? "lg" : "md";
  const dot = DOT[row.kind];
  const e = row.entry;

  // While one answer is in flight the others can't be sent (answerRequest also drops repeats).
  const run = (key: string, f: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    f().finally(() => setBusy(""));
  };
  const state = (key: string) => ({ isLoading: busy === key, isDisabled: !!busy && busy !== key });

  if (row.conflict) {
    const c = row.conflict;
    return (
      <ListItem
        {...({ align: "start" } as {})}
        interactiveRef={link}
        startContent={<DotOnFirstLine variant={dot.variant} label={dot.label} />}
        label={<TitleLink title={c.name} onOpen={() => openPage("memory", c.id)} linkRef={link} />}
        endContent={when(c.ts)}
        description={
          <VStack gap={1}>
            <HStack gap={1.5} vAlign="center">
              <Text type="supporting">Memory conflict</Text>
              {ctx.multi && <Token size="sm" color="gray" label={row.runnerId} />}
            </HStack>
            <Text type="body" maxLines={2}>
              Now: {c.newClaim ?? c.newBody}
            </Text>
            <Text type="supporting" maxLines={2}>
              Before: {c.oldClaim ?? c.oldBody}
            </Text>
            <Actions>
              <Button label="Keep new" variant="primary" size={size} {...state("new")} onClick={() => run("new", () => resolveConflict(c.id, "keep-new"))} />
              <Button label="Keep old" variant="secondary" size={size} {...state("old")} onClick={() => run("old", () => resolveConflict(c.id, "keep-old"))} />
            </Actions>
          </VStack>
        }
      />
    );
  }
  if (!e) return null;
  const s = e.session;
  const open = () => openOnRunner(row.runnerId, s);
  const r = row.request;
  const n = row.notice;
  const need: NeedRow | undefined = r && { ...rowOf(e), request: r };
  const answer = (key: string, response: Omit<UiResponse, "id">) => need && run(key, () => respond(need, response));

  let verb: string;
  let payload: ReactNode = null;
  let actions: ReactNode = null;
  if (r?.kind === "permission") {
    const c = requestCall(r);
    const note = guardNote(r);
    verb = permissionVerb(r);
    payload = (
      <>
        <Text type="code" maxLines={2}>
          {c.text ?? requestLine(r)}
        </Text>
        {note && (
          <Text type="supporting" maxLines={2} style={{ color: "var(--color-warning)" }}>
            Guard: {note}
          </Text>
        )}
      </>
    );
    actions = requestTruncated(r) ? (
      // Too long to show here: approved from the session, where it's shown in full.
      <>
        <Button label="Review" variant="primary" size={size} isDisabled={!!busy} onClick={open} />
        <Button label="Deny" variant="secondary" size={size} {...state("deny")} onClick={() => answer("deny", { allow: false })} />
      </>
    ) : (
      <>
        <Button label="Approve" variant="primary" size={size} {...state("allow")} onClick={() => answer("allow", { allow: true })} />
        <Button label="Deny" variant="secondary" size={size} {...state("deny")} onClick={() => answer("deny", { allow: false })} />
        <Button label="Always allow" variant="ghost" size={size} {...state("always")} onClick={() => answer("always", { allow: true, always: true })} />
      </>
    );
  } else if (r) {
    const q = oneTapQuestion(r);
    verb = r.kind === "plan" ? "proposes a plan" : "asks";
    payload = (
      <Text type="body" maxLines={2}>
        {requestLine(r)}
      </Text>
    );
    if (q)
      actions = q.options.map((o) => (
        <Button key={o.label} label={o.label} variant="secondary" size={size} {...state(o.label)} onClick={() => answer(o.label, { answers: { [q.question]: o.label } })} />
      ));
    else if (r.kind === "confirm")
      actions = (
        <>
          <Button label="Yes" variant="primary" size={size} {...state("yes")} onClick={() => answer("yes", { confirmed: true })} />
          <Button label="No" variant="secondary" size={size} {...state("no")} onClick={() => answer("no", { confirmed: false })} />
        </>
      );
    else actions = <Button label={r.kind === "plan" ? "Review plan" : "Answer"} variant="primary" size={size} onClick={open} />;
  } else if (row.kind === "ask") {
    // Asking, but the request isn't here (an older runner, or a process that has since closed).
    verb = "asks";
    payload = (
      <Text type="body" maxLines={2}>
        {n?.body || "Waiting for your answer"}
      </Text>
    );
  } else if (row.kind === "blocked") {
    verb = "blocked";
    payload = (
      <>
        {n?.call && (
          <Text type="code" maxLines={2}>
            {n.call}
          </Text>
        )}
        {n && (
          <Text type="supporting" maxLines={2}>
            {blockedLine(n)}
          </Text>
        )}
      </>
    );
    if (n?.toolId)
      actions = (
        <>
          <Button label="Approve & retry" variant="primary" size={size} {...state("approve")} onClick={() => run("approve", () => actOnBlocked(row, "approveBlocked"))} />
          {isShellCall(n.call) && <Button label="Run it myself" variant="secondary" size={size} {...state("run")} onClick={() => run("run", () => actOnBlocked(row, "runBlocked"))} />}
        </>
      );
  } else {
    verb = "finished";
    const last = firstLine(e.pulse?.lastText) ?? e.pulse?.lastText;
    const diff = e.pulse && diffLabel(e.pulse);
    if (last || diff)
      payload = (
        <Text type="body" maxLines={2}>
          {last}
          {diff && (
            <Text type="supporting" hasTabularNumbers>
              {last ? `  ${diff}` : diff}
            </Text>
          )}
        </Text>
      );
  }

  const time = row.request ? waiting(row.at) : when(row.at);
  const end =
    row.kind === "finished" ? (
      <AgoWithAction
        reveal={reveal}
        ago={time}
        action={<IconButton label="Mark read" tooltip="Mark read" variant="ghost" size="sm" icon={<Icon icon={XMarkIcon} />} onClick={() => markRead(row)} />}
      />
    ) : (
      time
    );

  return (
    <ListItem
      {...rowMenuKey(rowKey(e))}
      {...reveal.getContainerProps()}
      {...({ align: "start" } as {})}
      interactiveRef={link}
      startContent={<DotOnFirstLine variant={dot.variant} label={dot.label} isPulsing={row.kind === "permission"} />}
      label={<TitleLink title={s.title} onOpen={open} linkRef={link} />}
      endContent={end}
      description={
        <VStack gap={1}>
          <Where s={s} runnerId={row.runnerId} ctx={ctx} verb={verb} />
          {payload}
          {actions && <Actions>{actions}</Actions>}
        </VStack>
      }
    />
  );
}

/** The row's dot, level with its title (the row's content starts at the top). */
function DotOnFirstLine(props: { variant: "error" | "success" | "warning"; label: string; isPulsing?: boolean }) {
  return (
    <VStack paddingBlockStart={1.5}>
      <StatusDot {...props} />
    </VStack>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return (
    <HStack gap={2} wrap="wrap" paddingBlock={1}>
      {children}
    </HStack>
  );
}

/** What a working row says it's doing: the current action, or that only background work or a wakeup is left. */
function statusLine(p: SessionPulse): string {
  const state = workState(pulseWork(p));
  if (p.pendingUi?.length) return p.action ?? "Waiting for you";
  if (state === "background") return ["Background", p.action].filter(Boolean).join(" · ");
  if (state === "scheduled") return "Scheduled";
  if (state === "waiting") return ["Waiting", p.action].filter(Boolean).join(" · ");
  return p.action ?? "Working";
}

function ContextMini({ p }: { p: SessionPulse }) {
  const pct = contextPercent(p);
  if (pct === undefined) return null;
  const variant = pct >= 95 ? "error" : pct >= 80 ? "warning" : "accent";
  return (
    <Tooltip content={`Context window ${Math.round(pct)}% used`}>
      <ProgressBar label="Context window used" isLabelHidden value={pct} variant={variant} style={{ width: "var(--spacing-10)" }} />
    </Tooltip>
  );
}

/** One line: what it's doing, for how long, and how full its context is. Stop is in its menu. */
function WorkingItem({ entry, ctx }: { entry: Entry; ctx: RowCtx }) {
  const p: SessionPulse = { ...entry.pulse, session: entry.session };
  const s = entry.session;
  const busy = s.status !== "idle" && !!p.turnStartedAt;
  return (
    <ListItem
      {...rowMenuKey(rowKey(entry))}
      onClick={() => openOnRunner(entry.runnerId!, s)}
      startContent={<WorkIndicator work={pulseWork(p)} />}
      label={
        <OneLine title={s.title}>
          {[project(listPath(s)), statusLine(p)].join(" · ")}
          {busy && (
            <>
              {" · "}
              <Timer startTime={p.turnStartedAt} type="inherit" color="inherit" />
            </>
          )}
        </OneLine>
      }
      endContent={
        <HStack gap={2} vAlign="center">
          {ctx.multi && <Token size="sm" color="gray" label={entry.runnerId!} />}
          <ContextMini p={p} />
        </HStack>
      }
    />
  );
}

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

/** A one-line row's text: the title, then quieter detail; the detail gives way first, then the title truncates. */
function OneLine({ title, children }: { title: string; children: ReactNode }) {
  return (
    <HStack gap={1.5} vAlign="center" style={{ minWidth: 0 }}>
      {/* Truncated by style, not maxLines: its tooltip would stick after a long press on touch. */}
      <Text display="block" style={{ ...ellipsis, flex: "0 1 auto", minWidth: "calc(var(--spacing-12) * 2)" }}>{title}</Text>
      <Text type="supporting" display="block" style={{ ...ellipsis, flex: "0 100 auto", minWidth: 0 }}>
        {children}
      </Text>
    </HStack>
  );
}

/** title · project · ago */
function ContinueItem({ entry, ctx }: { entry: Entry; ctx: RowCtx }) {
  const s = entry.session;
  return (
    <ListItem
      {...rowMenuKey(rowKey(entry))}
      onClick={() => openOnRunner(entry.runnerId!, s)}
      startContent={<HarnessGlyph harness={s.harness} />}
      label={<OneLine title={s.title}>{project(listPath(s))}</OneLine>}
      endContent={
        <HStack gap={2} vAlign="center">
          {ctx.multi && <Token size="sm" color="gray" label={entry.runnerId!} />}
          {when(Math.max(s.updatedAt, entry.pulse?.finishedAt ?? 0))}
        </HStack>
      }
    />
  );
}

/**
 * Offers push notifications once there's something worth a push (the inbox isn't empty), on a
 * device that can get them and doesn't yet from this runner. × is the answer "not now", for good.
 */
function NotifyBanner({ hasInbox }: { hasInbox: boolean }) {
  const runnerId = useStore((s) => s.runnerId);
  const [asked, setAsked] = useState(() => !!localStorage.getItem("tether.notifyAsked"));
  const [on, setOn] = useState(() => !!runnerId && pushOnHere(runnerId));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const homeScreen = needsHomeScreen();
  const can = homeScreen || (pushSupported() && Notification.permission !== "denied");
  useEffect(() => {
    if (!runnerId) return;
    setOn(pushOnHere(runnerId));
    // What this device last knew may be stale (turned off elsewhere, or never checked): ask the runner.
    if (can && !homeScreen && !asked) pushState().then((st) => setOn(!!st.kinds), () => {});
  }, [runnerId]);
  if (!runnerId || !hasInbox || asked || on || !can) return null;
  const dismiss = () => {
    localStorage.setItem("tether.notifyAsked", "1");
    setAsked(true);
  };
  const turnOn = async () => {
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
  };
  return (
    <Banner
      status={err ? "error" : "info"}
      container="section"
      collapsible={false}
      isDismissable
      onDismiss={dismiss}
      dismissLabel="Not now"
      title={homeScreen ? "Add Tether to your Home Screen to get pushes" : "Get a push when an agent needs you"}
      description={err}
      endContent={homeScreen ? undefined : <Button label="Turn on" variant="primary" size="sm" isLoading={busy} onClick={turnOn} />}
    />
  );
}
