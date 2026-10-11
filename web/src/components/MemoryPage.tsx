// The Memory & Skills page (docs/master-context.md, UI): one page for the memory and skill library
// every harness shares. Top to bottom: whether shared memory is on (turning it on or off), open
// conflicts (only when there are some), the memory list (global and per repo, searchable; a row
// opens in a side panel, full screen on phones) and the skills with their on/off switches.
// Frame: Astryx's settings template (header + one scrolling column of sections), plus the
// table-grouped template's resizable detail panel.

import React, { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutHeader, LayoutPanel, VStack, HStack, StackItem } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Markdown } from "@astryxdesign/core/Markdown";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { ArrowsRightLeftIcon, MagnifyingGlassIcon, PencilSquareIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { ContextActivity, ContextImportPreview, ContextSkill, ContextStatus, ContextTurnedOff, MemoryCommit, MemoryConflict, MemoryEntry, MemoryType } from "../shared/protocol";
import { act, markNoticeRead, refreshContext, resolveConflict, rpc, useStore } from "../store";
import { Patch } from "./Changes";
import { HarnessBadge } from "./HarnessBadge";
import { scopeLabel, sourceHarness, sourceLabel, ts } from "./MemoryConflicts";

const capped: CSSProperties = { maxWidth: "calc(var(--spacing-12) * 20)", width: "100%" };
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
const mutedBox: CSSProperties = { backgroundColor: "var(--color-background-muted)", borderRadius: "var(--radius-container)", overflow: "hidden" };

const TYPE_COLOR: Record<MemoryType, "blue" | "purple" | "green" | "gray"> = {
  user: "blue",
  feedback: "purple",
  project: "green",
  reference: "gray",
};
const TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];
const TYPE_LABEL: Record<MemoryType, string> = { user: "User", feedback: "Feedback", project: "Project", reference: "Reference" };

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Source harness tokens for a list of provenance strings ("claude:…", "codex:…"), one per harness. */
function SourceBadges({ sources }: { sources: string[] }) {
  const kinds = [...new Set(sources.map((s) => (s.includes(":") ? s.slice(0, s.indexOf(":")) : s)))];
  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
      {kinds.map((k) => {
        const h = sourceHarness(k);
        const paths = sources.filter((s) => s.startsWith(k + ":")).map((s) => s.slice(k.length + 1));
        return (
          <Tooltip key={k} content={paths.join("\n") || k} hasHoverIndication={false}>
            {h ? <HarnessBadge harness={h} /> : <Token size="sm" label={k === "mcp" ? "MCP" : k} />}
          </Tooltip>
        );
      })}
    </HStack>
  );
}

export function MemoryPage({ narrow }: { narrow: boolean }) {
  const status = useStore((s) => s.contextStatus);
  const conflicts = useStore((s) => s.conflicts);
  const runnerId = useStore((s) => s.runnerId);
  const focus = useStore((s) => s.memoryFocus);
  const [importing, setImporting] = useState(false);
  /** when the last "Turn on" started: errors the runner reported since then are shown */
  const [importedSince, setImportedSince] = useState<number>();
  const [turnedOff, setTurnedOff] = useState<ContextTurnedOff>();
  const [highlight, setHighlight] = useState<string>();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<MemoryEntry[]>();
  const [selected, setSelected] = useState<string>();
  const panel = useResizable({ defaultSize: 420, minSize: 320, maxSize: 640 });
  const live = useStore((s) => s.contextLive);

  useEffect(() => {
    document.title = "Memory & Skills · Tether";
    refreshContext();
    return () => void (document.title = "Tether");
  }, [runnerId]);

  // "Turning on" lasts until the first import's merge pass has finished.
  useEffect(() => {
    if (importing && status?.enabled && !status.busy) setImporting(false);
  }, [importing, status?.enabled, status?.busy]);
  const on = !!status?.enabled && !importing;

  // Reload on search, and when the runner reports a change to memory (merges, edits, deletes).
  const memoryChanges = live.filter((a) => a.memoryId).length;
  useEffect(() => {
    if (!on) return;
    const q = query.trim();
    const t = setTimeout(
      () =>
        rpc("listMemories", q ? { query: q } : {})
          .then(setEntries)
          .catch(() => setEntries([])),
      q ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [on, query, memoryChanges, runnerId]);

  // Links into the page (a notification, the bell, Needs-you): scroll to the conflict.
  useEffect(() => {
    if (!focus || !status) return;
    const id = focus === "conflicts" ? undefined : focus;
    if (id) for (const n of useStore.getState().notices) if (n.conflictId === id) markNoticeRead(n.id);
    const t = setTimeout(() => {
      useStore.setState({ memoryFocus: undefined });
      const target = id && conflicts.some((c) => c.id === id) ? `conflict-${id}` : "memory-conflicts";
      document.getElementById(target)?.scrollIntoView({ block: "start", behavior: "smooth" });
      if (id) setHighlight(id);
    }, 50);
    return () => clearTimeout(t);
  }, [focus, status, conflicts]);
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(undefined), 4000);
    return () => clearTimeout(t);
  }, [highlight]);

  const current = entries?.find((e) => e.id === selected);
  const onChanged = (next?: MemoryEntry) => {
    if (!selected) return;
    setEntries((list) => (next ? list?.map((e) => (e.id === selected ? next : e)) : list?.filter((e) => e.id !== selected)));
    if (!next) setSelected(undefined);
  };
  // Side panel (desktop): opening it moves focus into it, Escape closes it and focus goes back to
  // where it was (the row). Phones get the full-screen Dialog, which does this itself.
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openId = !narrow && on ? current?.id : undefined;
  useEffect(() => {
    if (!openId) return;
    if (!panelRef.current?.contains(document.activeElement)) returnFocus.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
  }, [openId]);
  const closePanel = () => {
    setSelected(undefined);
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el?.isConnected) requestAnimationFrame(() => el.focus({ preventScroll: true }));
  };

  const detail = on && current && <MemoryDetail key={current.id} entry={current} onClose={closePanel} onChanged={onChanged} />;

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider padding={4}>
          {/* Room on phones (and with the sidebar hidden) for the floating sidebar button. */}
          <HStack gap={3} vAlign="center" paddingInlineStart={narrow ? 8 : 0}>
            <Heading level={1}>Memory & Skills</Heading>
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent role="main" padding={4}>
          <VStack gap={6} style={capped}>
            {!status ? (
              <Spinner label="Loading…" />
            ) : (
              <StatusSection
                status={status}
                importing={importing}
                turnedOff={turnedOff}
                importErrors={importedSince ? live.filter((a) => a.kind === "error" && a.ts >= importedSince) : []}
                onDismissErrors={() => setImportedSince(undefined)}
                onImport={() => {
                  setTurnedOff(undefined);
                  setImporting(true);
                  setImportedSince(Date.now() - 1000);
                }}
                onFailed={() => setImporting(false)}
                onTurnedOff={(off) => {
                  setTurnedOff(off);
                  setImportedSince(undefined);
                  setSelected(undefined);
                  setEntries(undefined);
                }}
              />
            )}
            {on && conflicts.length > 0 && <ConflictsSection conflicts={conflicts} highlight={highlight} narrow={narrow} />}
            {on && (
              <MemorySection
                narrow={narrow}
                entries={entries}
                query={query}
                onQuery={setQuery}
                selected={selected}
                onSelect={(id) => setSelected(id === selected ? undefined : id)}
              />
            )}
            {on && <SkillsSection narrow={narrow} />}
          </VStack>
          {narrow && (
            <Dialog isOpen={!!detail} onOpenChange={(o) => !o && setSelected(undefined)} purpose="info" variant="fullscreen" padding={4} aria-label="Memory details">
              {detail}
            </Dialog>
          )}
        </LayoutContent>
      }
      end={
        !narrow &&
        detail && (
          <>
            <ResizeHandle resizable={panel.props} isReversed isAlwaysVisible={false} />
            <LayoutPanel
              ref={panelRef}
              tabIndex={-1}
              onKeyDown={(e) => {
                // Not from a field (an edit in progress) or an open menu: those handle Escape themselves.
                const t = e.target as HTMLElement;
                if (e.key === "Escape" && !e.defaultPrevented && !t.closest("input, textarea, select, [aria-expanded='true'], [role='listbox']")) {
                  e.preventDefault();
                  closePanel();
                }
              }}
              style={{ outline: "none" }}
              hasDivider
              resizable={panel.props}
              padding={4}
              role="complementary"
              label="Memory details"
            >
              {detail}
            </LayoutPanel>
          </>
        )
      }
    />
  );
}

// ---------------- status: on / off / turning on ----------------

const PHASE_LABEL: Record<NonNullable<ContextStatus["progress"]>["phase"], string> = {
  skills: "Importing skills",
  scan: "Reading memory sources",
  merge: "Merging memories",
  export: "Updating each harness's files",
  disable: "Turning off",
};

const TURN_OFF_CONFIRM =
  "Turn off shared memory? Tether stops syncing and removes what it added to every harness: the managed blocks in CLAUDE.md / AGENTS.md / GEMINI.md, its own memory files, the tether-context MCP entries (~/.claude.json, opencode, Codex, pi, Kiro, Antigravity) and its skill links (skills it had replaced become real copies again). The store, its history and the backups are kept; turning it on again picks up where it left off.";

function StatusSection({
  status,
  importing,
  turnedOff,
  importErrors,
  onDismissErrors,
  onImport,
  onFailed,
  onTurnedOff,
}: {
  status: ContextStatus;
  importing: boolean;
  turnedOff?: ContextTurnedOff;
  importErrors: ContextActivity[];
  onDismissErrors: () => void;
  onImport: () => void;
  onFailed: () => void;
  onTurnedOff: (off?: ContextTurnedOff) => void;
}) {
  const [busy, setBusy] = useState(false);
  // What went wrong while turning on (the import keeps going past a source it can't read).
  const errors = importErrors.length > 0 && (
    <Banner status="warning" title="Some things couldn't be imported" collapsible={false} isDismissable onDismiss={onDismissErrors}>
      <List density="compact">
        {importErrors.slice(0, 20).map((a) => (
          <ListItem key={a.id} label={a.text} />
        ))}
      </List>
    </Banner>
  );

  if (importing) {
    const p = status.progress;
    const known = !!p && p.total > 0;
    return (
      <VStack gap={2}>
        <HStack gap={2} vAlign="center">
          <Spinner size="sm" aria-label="Turning on" />
          <Text type="body" weight="semibold">
            Turning on shared memory
          </Text>
        </HStack>
        <ProgressBar
          label={p ? PHASE_LABEL[p.phase] : "Starting"}
          isIndeterminate={!known}
          value={known ? p!.done : 0}
          max={known ? p!.total : 100}
          hasValueLabel={known}
          formatValueLabel={(v, max) => `${v} of ${max}`}
        />
        <Text type="supporting" color="secondary">
          You can leave this page; it keeps going on the runner.
        </Text>
        {errors}
      </VStack>
    );
  }

  if (status.enabled)
    return (
      <VStack gap={2}>
        <HStack gap={3} vAlign="center" wrap="wrap">
          <StackItem size="fill">
            <HStack gap={2} vAlign="center">
              <StatusDot variant="success" label="On" />
              <Text type="body" weight="semibold">
                {`Shared memory is on · ${plural(status.memories, "memory", "memories")} · ${plural(status.skills, "skill")}`}
              </Text>
            </HStack>
          </StackItem>
          <Button
            label="Turn off"
            size="sm"
            isLoading={busy}
            onClick={async () => {
              if (!confirm(TURN_OFF_CONFIRM)) return;
              setBusy(true);
              const st = await act("contextDisable", {});
              setBusy(false);
              if (!st) return;
              const { turnedOff: off, ...rest } = st;
              onTurnedOff(off);
              useStore.setState({ contextStatus: rest });
            }}
          />
        </HStack>
        {errors}
      </VStack>
    );

  const turnOn = async () => {
    onImport();
    const st = await act("contextImport", {});
    if (st) useStore.setState({ contextStatus: st });
    else onFailed();
  };

  return (
    <VStack gap={3}>
      {turnedOff && <TurnedOffBanner off={turnedOff} />}
      <HStack gap={2} vAlign="center">
        <StatusDot variant="neutral" label="Off" />
        <Text type="body" weight="semibold">
          Shared memory is off
        </Text>
      </HStack>
      <Text>
        Turning it on gives every agent you run (Claude Code, Codex, pi, opencode, Kiro and Antigravity) one memory and one skill library. Tether imports what
        they already remember, merges it, and keeps it in sync from then on, including CLI sessions you start outside Tether. It adds a marked Tether section
        to each harness's global instructions file (CLAUDE.md, AGENTS.md, GEMINI.md, Kiro steering) and never edits your text around it, registers its
        tether-context memory server in each harness's MCP settings, and backs up each skill folder before replacing it with a link to one shared copy. Every
        change is a git commit in {status.dir}.
      </Text>
      <HStack>
        <Button label="Turn on shared memory" variant="primary" onClick={turnOn} />
      </HStack>
      <ImportPreview />
    </VStack>
  );
}

/** What "Turn off" just undid (shown until it's turned on again). */
function TurnedOffBanner({ off }: { off: ContextTurnedOff }) {
  const skills = [
    off.skillLinks ? `${plural(off.skillLinks, "skill link")} removed` : "",
    off.restoredSkills ? `${plural(off.restoredSkills, "skill copy", "skill copies")} put back` : "",
  ].filter(Boolean);
  const description = [
    off.files.length ? `Tether's blocks and tether-context entries came out of ${plural(off.files.length, "file")}.` : "No harness files needed cleaning.",
    skills.length ? skills.join(", ") + "." : "",
    "Your memory store and its history are kept; turning it on again picks up where it left off.",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <VStack gap={2}>
      <Banner status="success" title="Shared memory is off" description={description} collapsible={false} isDismissable>
        {off.files.length > 0 && (
          <List density="compact">
            {off.files.map((f) => (
              <ListItem key={f} label={f} />
            ))}
          </List>
        )}
      </Banner>
      {off.warnings.length > 0 && (
        <Banner status="warning" title="Some files couldn't be cleaned" collapsible={false}>
          <List density="compact">
            {off.warnings.map((w) => (
              <ListItem key={w} label={w} />
            ))}
          </List>
        </Banner>
      )}
    </VStack>
  );
}

const FIRST = 12;

/** "See exactly what will change": the import's dry run (contextImportPreview) as one compact list. */
function ImportPreview() {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ContextImportPreview>();
  const [err, setErr] = useState<string>();
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (open && !preview)
      rpc("contextImportPreview", {})
        .then(setPreview)
        .catch((e) => setErr(e?.message ?? String(e)));
  }, [open, preview]);

  const rows = useMemo(() => {
    if (!preview) return [];
    const out: { key: string; label: string; description?: string; start?: React.ReactNode }[] = [];
    const byHarness = new Map<string, ContextImportPreview["memories"]>();
    for (const m of preview.memories) byHarness.set(m.harness, [...(byHarness.get(m.harness) ?? []), m]);
    for (const [h, list] of byHarness) {
      const id = sourceHarness(h);
      out.push({
        key: `m:${h}`,
        label: `Import ${plural(list.length, "memory", "memories")} from ${sourceLabel(`${h}:`)}`,
        description: list.map((m) => m.title).join(" · "),
        start: id ? <HarnessBadge harness={id} /> : <Token size="sm" label={h} />,
      });
    }
    if (preview.skills.length)
      out.push({
        key: "skills",
        label: `Share ${plural(preview.skills.length, "skill")} with every harness`,
        description: preview.skills.map((s) => (s.drift.length ? `${s.name} (newest copy kept)` : s.name)).join(", "),
      });
    // MCP configs are listed among the managed files too: those only get the server entry.
    for (const f of preview.managedFiles.filter((f) => !preview.mcpConfigs.includes(f))) out.push({ key: `f:${f}`, label: `Add a Tether section to ${f}` });
    for (const f of preview.mcpConfigs) out.push({ key: `c:${f}`, label: `Register the tether-context memory server in ${f}` });
    for (const b of preview.backups) out.push({ key: `b:${b.path}`, label: `Back up ${b.path}, then link it to the shared copy`, description: `Backup: ${b.to}` });
    return out;
  }, [preview]);

  const shown = all ? rows : rows.slice(0, FIRST);
  return (
    <Collapsible trigger={<Text type="label">See exactly what will change</Text>} isOpen={open} onOpenChange={setOpen}>
      <VStack gap={2} paddingBlockStart={2}>
        {err && <Banner status="error" title="Couldn't read what would change" description={err} collapsible={false} />}
        {!preview && !err && <Spinner size="sm" label="Looking at your harnesses…" />}
        {preview?.warnings.length ? <Banner status="warning" title="Some sources couldn't be read" description={preview.warnings.join("\n")} collapsible={false} /> : null}
        {preview && !rows.length && <Text type="supporting">Nothing to import and no files to change.</Text>}
        {shown.length > 0 && (
          <List density="compact" hasDividers>
            {shown.map((r) => (
              // The label wraps (a plain string is cut to one line): on a phone the path is the point.
              <ListItem key={r.key} label={<Text style={preWrap}>{r.label}</Text>} description={r.description} startContent={r.start} />
            ))}
          </List>
        )}
        {rows.length > FIRST && (
          <HStack>
            <Button label={all ? "Show fewer" : `Show all ${rows.length}`} variant="ghost" size="sm" onClick={() => setAll(!all)} />
          </HStack>
        )}
      </VStack>
    </Collapsible>
  );
}

// ---------------- conflicts ----------------

const claimStyle = (tone: "old" | "new"): CSSProperties => ({
  ...preWrap,
  borderInlineStart: `calc(var(--border-width) * 2) solid var(${tone === "old" ? "--color-border-red" : "--color-border-green"})`,
  paddingInlineStart: "var(--spacing-2)",
});

function ConflictsSection({ conflicts, highlight, narrow }: { conflicts: MemoryConflict[]; highlight?: string; narrow: boolean }) {
  const n = conflicts.length;
  return (
    <VStack id="memory-conflicts" gap={2}>
      <HStack gap={2} vAlign="center">
        <StatusDot variant="warning" label="Needs a look" />
        <Text type="body" weight="semibold">
          {n === 1 ? "1 memory conflict: the newest was kept" : `${n} memory conflicts: the newest was kept`}
        </Text>
      </HStack>
      <VStack style={mutedBox}>
        {conflicts.map((c, i) => (
          <React.Fragment key={c.id}>
            {i > 0 && <Divider />}
            <ConflictRow c={c} isHighlighted={c.id === highlight} narrow={narrow} />
          </React.Fragment>
        ))}
      </VStack>
    </VStack>
  );
}

function ConflictRow({ c, isHighlighted, narrow }: { c: MemoryConflict; isHighlighted: boolean; narrow: boolean }) {
  const [busy, setBusy] = useState<string>();
  const run = async (action: "keep-new" | "keep-old") => {
    setBusy(action);
    await resolveConflict(c.id, action);
    setBusy(undefined);
  };
  return (
    <VStack
      id={`conflict-${c.id}`}
      gap={2}
      padding={3}
      style={{ scrollMarginTop: "var(--spacing-4)", backgroundColor: isHighlighted ? "var(--color-background-yellow)" : undefined, transition: "background-color 0.6s" }}
    >
      <HStack gap={2} vAlign="center" wrap="wrap">
        <StackItem size="fill">
          <Text type="body" weight="semibold" maxLines={1}>
            {c.name}
          </Text>
        </StackItem>
        <Text type="supporting" color="secondary">
          {scopeLabel(c.scope)} · {sourceLabel(c.source)} · <Timestamp value={ts(c.ts)} format="relative_short" type="inherit" />
        </Text>
      </HStack>
      <Grid columns={narrow ? 1 : 2} gap={3}>
        <VStack gap={0.5} style={claimStyle("old")}>
          <Text type="supporting" color="secondary">
            Old
          </Text>
          <Text maxLines={4}>{c.oldClaim || c.oldBody}</Text>
        </VStack>
        <VStack gap={0.5} style={claimStyle("new")}>
          <Text type="supporting" color="secondary">
            New, in use
          </Text>
          <Text maxLines={4}>{c.newClaim || c.newBody}</Text>
        </VStack>
      </Grid>
      <HStack gap={2}>
        <Button label="Keep new" variant="primary" size="sm" isLoading={busy === "keep-new"} isDisabled={!!busy} onClick={() => run("keep-new")} />
        <Button label="Keep old" size="sm" isLoading={busy === "keep-old"} isDisabled={!!busy || !c.commit} onClick={() => run("keep-old")} />
      </HStack>
    </VStack>
  );
}

// ---------------- memory ----------------

function MemorySection({
  narrow,
  entries,
  query,
  onQuery,
  selected,
  onSelect,
}: {
  narrow: boolean;
  entries?: MemoryEntry[];
  query: string;
  onQuery: (q: string) => void;
  selected?: string;
  onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const searching = !!query.trim();

  // Global first, then repos by name; newest first inside a group unless it's a ranked search.
  const groups = useMemo(() => {
    const g = new Map<string, MemoryEntry[]>();
    for (const e of entries ?? []) g.set(e.scope, [...(g.get(e.scope) ?? []), e]);
    if (!searching) for (const list of g.values()) list.sort((a, b) => b.updated.localeCompare(a.updated));
    return [...g].sort(([a], [b]) => (a === "global" ? -1 : b === "global" ? 1 : scopeLabel(a).localeCompare(scopeLabel(b))));
  }, [entries, searching]);

  const setOpen = (k: string, open: boolean) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (open) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <Heading level={3}>Memory</Heading>
        {entries && !searching && <Badge variant="neutral" label={String(entries.length)} />}
      </HStack>
      <TextInput label="Search memory" isLabelHidden size="sm" placeholder="Search memory" startIcon={MagnifyingGlassIcon} hasClear value={query} onChange={onQuery} />
      {!entries ? (
        <Spinner size="sm" label="Loading memory…" />
      ) : groups.length === 0 ? (
        <EmptyState title={searching ? `Nothing matches “${query.trim()}”` : "No memories yet"} isCompact />
      ) : (
        <VStack gap={1}>
          {groups.map(([key, list]) => (
            <Collapsible
              key={key}
              isOpen={searching || !collapsed.has(key)}
              onOpenChange={(o) => setOpen(key, o)}
              trigger={
                <HStack gap={2} vAlign="center">
                  <Text type="label" weight="semibold">
                    {scopeLabel(key)}
                  </Text>
                  <Badge variant="neutral" label={String(list.length)} />
                  {key !== "global" && !narrow && (
                    <Text type="supporting" color="secondary" maxLines={1}>
                      {key.slice(5)}
                    </Text>
                  )}
                </HStack>
              }
            >
              <List density="compact" hasDividers>
                {list.map((m) => (
                  <ListItem
                    key={m.id}
                    label={m.description || m.name}
                    description={narrow ? `${TYPE_LABEL[m.type]} · ${m.name}` : m.name}
                    isSelected={m.id === selected}
                    onClick={() => onSelect(m.id)}
                    endContent={
                      <HStack gap={2} vAlign="center">
                        {!narrow && <Token size="sm" color={TYPE_COLOR[m.type]} label={TYPE_LABEL[m.type]} />}
                        {!narrow && <SourceBadges sources={m.sources} />}
                        <Timestamp value={m.updated} format="relative_short" />
                      </HStack>
                    }
                  />
                ))}
              </List>
            </Collapsible>
          ))}
        </VStack>
      )}
    </VStack>
  );
}

/** One memory: read it, edit it (a commit), delete it, and see every commit that touched it. */
function MemoryDetail({ entry, onClose, onChanged }: { entry: MemoryEntry; onClose: () => void; onChanged: (next?: MemoryEntry) => void }) {
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(entry.description);
  const [type, setType] = useState<MemoryType>(entry.type);
  const [body, setBody] = useState(entry.body);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<MemoryCommit[]>();
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (showHistory)
      rpc("memoryHistory", { id: entry.id })
        .then(setHistory)
        .catch(() => setHistory([]));
  }, [showHistory, entry.id, entry.updated]);

  const save = async () => {
    setBusy(true);
    const next = await act("editMemory", { id: entry.id, description, type, body });
    setBusy(false);
    if (next && "id" in next) {
      onChanged(next as MemoryEntry);
      setEditing(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    const r = await act("editMemory", { id: entry.id, remove: true });
    setBusy(false);
    if (r) onChanged(undefined);
  };

  return (
    <VStack gap={4}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <Text type="supporting" color="secondary" maxLines={1}>
            {entry.name}
          </Text>
        </StackItem>
        <Button label="Close" variant="ghost" size="sm" icon={<Icon icon={XMarkIcon} size="sm" />} isIconOnly onClick={onClose} />
      </HStack>

      {editing ? (
        <VStack gap={3}>
          <TextInput label="Description" value={description} onChange={setDescription} />
          <Selector label="Type" value={type} options={TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} onChange={(v) => setType(v as MemoryType)} />
          <TextArea label="Memory" rows={12} value={body} onChange={setBody} />
          <HStack gap={2}>
            <Button label="Save" variant="primary" size="sm" isLoading={busy} isDisabled={!body.trim()} onClick={save} />
            <Button
              label="Cancel"
              size="sm"
              onClick={() => {
                setEditing(false);
                setDescription(entry.description);
                setType(entry.type);
                setBody(entry.body);
              }}
            />
          </HStack>
        </VStack>
      ) : (
        <>
          <Heading level={3}>{entry.description || entry.name}</Heading>
          <MetadataList label={{ position: "start" }}>
            <MetadataListItem label="Type">
              <Token size="sm" color={TYPE_COLOR[entry.type]} label={TYPE_LABEL[entry.type]} />
            </MetadataListItem>
            <MetadataListItem label="Scope">
              <Tooltip content={entry.scope} hasHoverIndication={false}>
                {scopeLabel(entry.scope)}
              </Tooltip>
            </MetadataListItem>
            <MetadataListItem label="From">
              <VStack gap={1}>
                {entry.sources.map((s) => (
                  <HStack key={s} gap={1.5} vAlign="center">
                    <SourceBadges sources={[s]} />
                    <Text type="supporting" color="secondary" maxLines={1}>
                      {s.slice(s.indexOf(":") + 1)}
                    </Text>
                  </HStack>
                ))}
                {!entry.sources.length && <Text type="supporting">—</Text>}
              </VStack>
            </MetadataListItem>
            <MetadataListItem label="Updated">
              <Timestamp value={entry.updated} format="date_time" type="body" color="primary" />
            </MetadataListItem>
          </MetadataList>
          <Divider />
          <Markdown density="compact">{entry.body}</Markdown>
          <HStack gap={2}>
            <Button label="Edit" size="sm" icon={<Icon icon={PencilSquareIcon} size="sm" />} onClick={() => setEditing(true)} />
            <Button label="Delete" size="sm" variant="destructive" icon={<Icon icon={TrashIcon} size="sm" />} isLoading={busy} onClick={remove} />
          </HStack>
        </>
      )}

      <Divider />
      <Collapsible trigger={<Text type="supporting">History</Text>} isOpen={showHistory} onOpenChange={setShowHistory}>
        <VStack gap={3} paddingBlockStart={2}>
          {!history && <Spinner size="sm" label="Loading history…" />}
          {history?.length === 0 && <Text type="supporting">No commits yet.</Text>}
          {history?.map((c) => (
            <VStack key={c.sha} gap={1}>
              <HStack gap={2} vAlign="center">
                <StackItem size="fill">
                  <Text type="body" maxLines={2}>
                    {c.message.split("\n")[0]}
                  </Text>
                </StackItem>
                <Timestamp value={ts(c.ts)} format="relative_short" />
              </HStack>
              <Text type="supporting" color="secondary">
                {c.sha.slice(0, 8)}
              </Text>
              {c.patch?.includes("@@") && (
                <Collapsible trigger={<Text type="supporting">Changes</Text>} defaultIsOpen={false}>
                  {/* From the first hunk: the file headers would read as a removed and an added line. */}
                  <Patch patch={c.patch.slice(c.patch.indexOf("@@"))} />
                </Collapsible>
              )}
            </VStack>
          ))}
        </VStack>
      </Collapsible>
    </VStack>
  );
}

// ---------------- skills ----------------

function SkillsSection({ narrow }: { narrow: boolean }) {
  const [skills, setSkills] = useState<ContextSkill[]>();
  const [busy, setBusy] = useState<string>();
  const runnerId = useStore((s) => s.runnerId);
  useEffect(() => {
    rpc("listSkills", {})
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [runnerId]);
  const toggle = async (s: ContextSkill, enabled: boolean) => {
    setBusy(s.name);
    const next = await act("setSkillEnabled", { name: s.name, enabled });
    setBusy(undefined);
    if (next) setSkills(next);
  };
  // The shared library first, then skills that live in a repo (listed, left in place).
  const list = (skills ?? []).slice().sort((a, b) => (a.repo ? 1 : 0) - (b.repo ? 1 : 0) || a.name.localeCompare(b.name));
  const library = list.filter((s) => !s.repo).length;

  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <Heading level={3}>Skills</Heading>
        {skills && <Badge variant="neutral" label={String(library)} />}
      </HStack>
      {!skills ? (
        <Spinner size="sm" label="Loading skills…" />
      ) : !list.length ? (
        <EmptyState title="No skills yet" isCompact />
      ) : (
        <List density="compact" hasDividers>
          {list.map((s) => (
            <ListItem
              key={`${s.repo ?? ""}:${s.name}`}
              label={s.exposedAs ? `${s.name} (as ${s.exposedAs})` : s.name}
              description={
                narrow ? (
                  <VStack gap={1}>
                    {s.description && (
                      <Text type="supporting" color="secondary" maxLines={2}>
                        {s.description}
                      </Text>
                    )}
                    <SkillSources s={s} />
                  </VStack>
                ) : (
                  s.description
                )
              }
              endContent={
                <HStack gap={2} vAlign="center">
                  {!narrow && <SkillSources s={s} />}
                  {s.drift?.length ? (
                    <Tooltip content={`Kept the newest copy; ${s.drift.join(", ")} differed (originals are in the backup).`} hasHoverIndication={false}>
                      <Icon icon={ArrowsRightLeftIcon} size="sm" color="warning" />
                    </Tooltip>
                  ) : null}
                  <Switch
                    label={s.repo ? `${s.name} lives in ${scopeLabel(`repo:${s.repo}`)} and stays there` : `Use ${s.name} in every harness`}
                    isLabelHidden
                    value={s.enabled}
                    isLoading={busy === s.name}
                    isDisabled={!!s.repo || !!busy}
                    onChange={(v) => toggle(s, v)}
                  />
                </HStack>
              }
            />
          ))}
        </List>
      )}
    </VStack>
  );
}

function SkillSources({ s }: { s: ContextSkill }) {
  const by = new Map<string, string[]>();
  for (const x of s.sources) by.set(x.harness, [...(by.get(x.harness) ?? []), x.path]);
  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
      {s.repo && <Token size="sm" label={scopeLabel(`repo:${s.repo}`)} />}
      {[...by].map(([h, paths]) => {
        const id = sourceHarness(h);
        return (
          <Tooltip key={h} content={paths.join("\n")} hasHoverIndication={false}>
            {id ? <HarnessBadge harness={id} /> : <Token size="sm" label={h === "agents" ? "~/.agents" : h} />}
          </Tooltip>
        );
      })}
    </HStack>
  );
}
