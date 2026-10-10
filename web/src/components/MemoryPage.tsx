// The Memory & Skills page (docs/master-context.md, UI): one store of memory and skills shared by
// every harness. Before the first import it is the import wizard; after, four tabs: memory (global
// and per-repo, searchable, editable), the quiet activity feed, conflicts, and the skill library.
// Frame: Astryx's table-grouped template (header + grouped table + resizable detail panel).

import React, { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent, LayoutFooter, LayoutHeader, LayoutPanel, VStack, HStack, StackItem } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Markdown } from "@astryxdesign/core/Markdown";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { ResizeHandle, useResizable, type ResizableProps } from "@astryxdesign/core/Resizable";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Table, TableBody, TableCell, TableRow, pixel, proportional, resolveColumnWidths, type TableColumn } from "@astryxdesign/core/Table";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  ArrowUpTrayIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PlusCircleIcon,
  PuzzlePieceIcon,
  TrashIcon,
  XCircleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import type {
  ContextActivity,
  ContextActivityKind,
  ContextImportPreview,
  ContextSkill,
  ContextStatus,
  MemoryCommit,
  MemoryConflict,
  MemoryEntry,
  MemoryType,
} from "../shared/protocol";
import { act, refreshContext, rpc, useStore } from "../store";
import { Patch } from "./Changes";
import { HarnessBadge } from "./HarnessBadge";
import { ConflictView, scopeLabel, sourceHarness, sourceLabel, ts } from "./MemoryConflicts";

type TabId = "memory" | "activity" | "conflicts" | "skills";

const groupHeaderCell: CSSProperties = {
  cursor: "pointer",
  backgroundColor: "var(--color-background-muted)",
  padding: "var(--spacing-3) var(--spacing-4)",
};
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
const capped: CSSProperties = { maxWidth: "calc(var(--spacing-12) * 16)", width: "100%" };

const TYPE_COLOR: Record<MemoryType, "blue" | "purple" | "green" | "gray"> = {
  user: "blue",
  feedback: "purple",
  project: "green",
  reference: "gray",
};
const TYPES: MemoryType[] = ["user", "feedback", "project", "reference"];
const TYPE_LABEL: Record<MemoryType, string> = { user: "User", feedback: "Feedback", project: "Project", reference: "Reference" };

/** Source harness tokens for a list of provenance strings ("claude:…", "codex:…"), one per harness. */
function SourceBadges({ sources }: { sources: string[] }) {
  const kinds = [...new Set(sources.map((s) => (s.includes(":") ? s.slice(0, s.indexOf(":")) : s)))];
  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
      {kinds.map((k) => {
        const h = sourceHarness(k);
        const paths = sources.filter((s) => s.startsWith(k + ":")).map((s) => s.slice(k.length + 1));
        return h ? (
          <Tooltip key={k} content={paths.join("\n") || k} hasHoverIndication={false}>
            <HarnessBadge harness={h} />
          </Tooltip>
        ) : (
          <Tooltip key={k} content={paths.join("\n") || k} hasHoverIndication={false}>
            <Token size="sm" label={k === "mcp" ? "MCP" : k} />
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
  const [tab, setTab] = useState<TabId>("memory");
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<string>();
  const wantTab = useStore((s) => s.memoryTab);
  useEffect(() => {
    if (!wantTab) return;
    setTab(wantTab);
    useStore.setState({ memoryTab: undefined });
  }, [wantTab]);

  useEffect(() => {
    document.title = "Memory & Skills · Tether";
    refreshContext();
    return () => void (document.title = "Tether");
  }, [runnerId]);

  // The wizard stays up (showing progress) until the first import's merge pass has finished.
  const wizard = !status?.enabled || importing;
  useEffect(() => {
    if (importing && status?.enabled && !status.busy) setImporting(false);
  }, [importing, status?.enabled, status?.busy]);

  const openMemory = (id: string) => {
    setTab("memory");
    setSelected(id);
  };

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider padding={4} paddingBlockEnd={wizard ? undefined : 0}>
          <VStack gap={4}>
            {/* Room on phones (and with the sidebar hidden) for the floating sidebar button. */}
            <HStack gap={3} vAlign="center" paddingInlineStart={narrow ? 8 : 0}>
              <StackItem size="fill">
                <Heading level={1}>Memory & Skills</Heading>
              </StackItem>
              {status?.busy && !wizard && <Spinner size="sm" label="Merging…" />}
              {!wizard && (
                <Button
                  label="Turn off"
                  size="sm"
                  onClick={async () => {
                    if (
                      !confirm(
                        "Turn the master context off? Tether removes its managed blocks, MCP entries and skill links from every harness (skills it had replaced become real copies again). The store, its history and the backups are kept; importing again turns it back on.",
                      )
                    )
                      return;
                    const st = await act("contextDisable", {});
                    if (st) useStore.setState({ contextStatus: st });
                  }}
                />
              )}
            </HStack>
            {!wizard && (
              <TabList value={tab} onChange={(v) => setTab(v as TabId)} role="tablist" hasDivider isFullBleed>
                <Tab
                  value="memory"
                  label="Memory"
                  panelId="memory-panel"
                  endContent={status ? <Badge variant="neutral" label={String(status.memories)} /> : undefined}
                />
                <Tab value="activity" label="Activity" panelId="memory-panel" />
                <Tab
                  value="conflicts"
                  label="Conflicts"
                  panelId="memory-panel"
                  endContent={conflicts.length ? <Badge variant="warning" label={String(conflicts.length)} /> : undefined}
                />
                <Tab
                  value="skills"
                  label="Skills"
                  panelId="memory-panel"
                  endContent={status ? <Badge variant="neutral" label={String(status.skills)} /> : undefined}
                />
              </TabList>
            )}
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent role="main" padding={0}>
          <VStack id="memory-panel" role={wizard ? undefined : "tabpanel"} height="100%">
            {!status ? (
              <VStack padding={6} hAlign="center">
                <Spinner label="Loading…" />
              </VStack>
            ) : wizard ? (
              <ImportWizard importing={importing} onImport={() => setImporting(true)} onFailed={() => setImporting(false)} />
            ) : tab === "memory" ? (
              <MemoryTab narrow={narrow} selected={selected} onSelect={setSelected} />
            ) : tab === "activity" ? (
              <ActivityTab onOpenMemory={openMemory} />
            ) : tab === "conflicts" ? (
              <ConflictsTab />
            ) : (
              <SkillsTab narrow={narrow} />
            )}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

// ---------------- first-run import wizard ----------------

const PHASE_LABEL: Record<NonNullable<ContextStatus["progress"]>["phase"], string> = {
  skills: "Importing skills…",
  scan: "Reading memory sources…",
  merge: "Merging memories…",
  export: "Updating each harness's files…",
  disable: "Turning off…",
};

function ImportWizard({ importing, onImport, onFailed }: { importing: boolean; onImport: () => void; onFailed: () => void }) {
  const [preview, setPreview] = useState<ContextImportPreview>();
  const [err, setErr] = useState<string>();
  const live = useStore((s) => s.contextLive);
  const status = useStore((s) => s.contextStatus);
  const startedAt = useRef(0);

  useEffect(() => {
    rpc("contextImportPreview", {})
      .then(setPreview)
      .catch((e) => setErr(e?.message ?? String(e)));
  }, []);

  const start = async () => {
    startedAt.current = Date.now();
    onImport();
    const st = await act("contextImport", {});
    if (st) useStore.setState({ contextStatus: st });
    else onFailed();
  };

  const byHarness = useMemo(() => {
    const g = new Map<string, ContextImportPreview["memories"]>();
    for (const m of preview?.memories ?? []) g.set(m.harness, [...(g.get(m.harness) ?? []), m]);
    return [...g];
  }, [preview]);

  if (importing) {
    const progress = live.filter((a) => a.ts >= startedAt.current - 1000);
    const merged = progress.filter((a) => a.kind === "new" || a.kind === "update" || a.kind === "duplicate" || a.kind === "contradicts").length;
    const skills = progress.filter((a) => a.kind === "skill").length;
    const p = status?.progress;
    const known = !!p && p.total > 0;
    return (
      <VStack padding={4} gap={4} style={capped}>
        <VStack gap={2}>
          <Text type="label">{p ? PHASE_LABEL[p.phase] : "Importing…"}</Text>
          <ProgressBar
            label="Import progress"
            isLabelHidden
            isIndeterminate={!known}
            value={known ? p!.done : 0}
            max={known ? p!.total : 100}
            hasValueLabel={known}
            formatValueLabel={(v, max) => `${v} of ${max}`}
          />
          <Text type="supporting" color="secondary">
            {`${merged} ${merged === 1 ? "memory" : "memories"} merged, ${skills} skill ${skills === 1 ? "change" : "changes"} so far.`} You can leave this
            page; the import keeps going on the runner.
          </Text>
        </VStack>
        <List density="compact">
          {progress.slice(0, 40).map((a) => (
            <ActivityRow key={a.id} a={a} />
          ))}
        </List>
      </VStack>
    );
  }

  return (
    <Layout
      height="fill"
      content={
        <LayoutContent padding={4}>
          <VStack gap={5} style={capped}>
            <VStack gap={2}>
              <Text>
                Tether can keep one memory and one skill library for every agent you run: Claude Code, Codex, pi, opencode, Kiro and Antigravity. What any of
                them learns is merged into a shared store and synced back out to the others, including CLI sessions you start outside Tether.
              </Text>
              <Text color="secondary">
                Nothing is changed until you press Import. After that it runs on its own: new memories are merged as they appear, and every change is a git
                commit you can inspect or revert.
              </Text>
            </VStack>

            {err && <Banner status="error" title="Couldn't read what would be imported" description={err} collapsible={false} />}
            {!preview && !err && <Spinner label="Looking at your harnesses…" />}

            {preview && (
              <>
                {preview.warnings.length > 0 && (
                  <Banner status="warning" title="Some sources couldn't be read" description={preview.warnings.join("\n")} collapsible={false} />
                )}

                <WizardGroup title="Memories to import" count={preview.memories.length} empty="No memories found.">
                  {byHarness.map(([h, list]) => (
                    <Collapsible
                      key={h}
                      defaultIsOpen={byHarness.length === 1}
                      trigger={
                        <HStack gap={2} vAlign="center">
                          {sourceHarness(h) ? <HarnessBadge harness={sourceHarness(h)!} /> : <Token size="sm" label={h} />}
                          <Text type="label">{sourceLabel(`${h}:`)}</Text>
                          <Badge variant="neutral" label={String(list.length)} />
                        </HStack>
                      }
                    >
                      <List density="compact">
                        {list.map((m, i) => (
                          <ListItem key={m.path + i} label={m.title} description={`${scopeLabel(m.scope)} · ${m.path}`} />
                        ))}
                      </List>
                    </Collapsible>
                  ))}
                </WizardGroup>

                <WizardGroup
                  title="Skills for every harness"
                  count={preview.skills.length}
                  empty="No skills found."
                  rows={preview.skills.map((s) => ({
                    key: s.name,
                    label: s.exposedAs ? `${s.name} (as ${s.exposedAs})` : s.name,
                    description: s.drift.length ? `From ${s.from}. Newest copy kept; ${s.drift.join(", ")} differed.` : `From ${s.from}`,
                    end: s.drift.length ? <Token size="sm" color="yellow" label="Drift" /> : undefined,
                  }))}
                />

                <WizardGroup
                  title="Skill folders backed up, then replaced by links"
                  count={preview.backups.length}
                  empty="None: no skill folder needs moving."
                  note={`Each folder moves to the backup, and a link to the shared copy takes its place (${preview.symlinks.length} links in all).`}
                  rows={preview.backups.map((b) => ({ key: b.path, label: b.path, description: `→ ${b.to}` }))}
                />

                <WizardGroup
                  title="Files that get a Tether block"
                  count={preview.managedFiles.length}
                  empty="None."
                  note="Tether only writes inside its own marked block (or its own file) and never edits your text around it."
                  rows={preview.managedFiles.map((f) => ({
                    key: f,
                    label: f,
                    description: preview.mcpConfigs.includes(f) ? "Registers the tether-context MCP server" : undefined,
                  }))}
                />
              </>
            )}
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter hasDivider>
          <HStack gap={3} vAlign="center" wrap="wrap">
            <Button label="Import" variant="primary" isDisabled={!preview} onClick={start} />
            <Text type="supporting" color="secondary">
              Stored in {status?.dir ?? "the runner's config folder"}, a git repo.
            </Text>
          </HStack>
        </LayoutFooter>
      }
    />
  );
}

const FIRST = 5;

/** A titled list in the wizard; long ones show the first few rows until expanded. */
function WizardGroup({
  title,
  count,
  empty,
  note,
  rows,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  note?: string;
  rows?: { key: string; label: string; description?: string; end?: React.ReactNode }[];
  children?: React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = rows && (all ? rows : rows.slice(0, FIRST));
  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <Text type="label" weight="semibold">
          {title}
        </Text>
        <Badge variant="neutral" label={String(count)} />
      </HStack>
      {note && count > 0 && (
        <Text type="supporting" color="secondary">
          {note}
        </Text>
      )}
      {!count && <Text type="supporting">{empty}</Text>}
      {children}
      {shown && shown.length > 0 && (
        <List density="compact">
          {shown.map((r) => (
            <ListItem key={r.key} label={r.label} description={r.description} endContent={r.end} />
          ))}
        </List>
      )}
      {rows && rows.length > FIRST && (
        <HStack>
          <Button label={all ? "Show fewer" : `Show all ${rows.length}`} variant="ghost" size="sm" onClick={() => setAll(!all)} />
        </HStack>
      )}
    </VStack>
  );
}

// ---------------- memory ----------------

const memoryColumns: TableColumn<Record<string, unknown>>[] = [
  { key: "type", header: "", width: pixel(104) },
  { key: "memory", header: "Memory", width: proportional(1) },
  { key: "sources", header: "From", width: pixel(120) },
  { key: "updated", header: "Updated", width: pixel(88) },
];
const narrowColumns = memoryColumns.filter((c) => c.key === "memory" || c.key === "updated");

function MemoryTab({ narrow, selected, onSelect }: { narrow: boolean; selected?: string; onSelect: (id: string | undefined) => void }) {
  const [entries, setEntries] = useState<MemoryEntry[]>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const live = useStore((s) => s.contextLive);
  const panel = useResizable({ defaultSize: 420, minSize: 320, maxSize: 640 });

  // Reload on search, and when the runner reports a change to memory (merges, edits, deletes).
  const memoryChanges = live.filter((a) => a.memoryId).length;
  useEffect(() => {
    const q = query.trim();
    const t = setTimeout(
      () =>
        rpc("listMemories", q ? { query: q } : {})
          .then(setEntries)
          .catch(() => setEntries([])),
      q ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [query, memoryChanges]);

  const scopes = useMemo(() => {
    const s = [...new Set((entries ?? []).map((e) => e.scope))];
    return s.sort((a, b) => (a === "global" ? -1 : b === "global" ? 1 : scopeLabel(a).localeCompare(scopeLabel(b))));
  }, [entries]);
  const groups = useMemo(() => {
    const g = new Map<string, MemoryEntry[]>();
    for (const s of scopes) if (scope === "all" || scope === s) g.set(s, []);
    for (const e of entries ?? []) g.get(e.scope)?.push(e);
    if (!query.trim()) for (const list of g.values()) list.sort((a, b) => b.updated.localeCompare(a.updated));
    return [...g].filter(([, l]) => l.length);
  }, [entries, scopes, scope, query]);

  const columns = narrow ? narrowColumns : memoryColumns;
  const widths = resolveColumnWidths(columns);
  const current = entries?.find((e) => e.id === selected);
  const toggle = (k: string) => setCollapsed((c) => (c.has(k) ? new Set([...c].filter((x) => x !== k)) : new Set([...c, k])));
  const onChanged = (next?: MemoryEntry) => {
    if (!selected) return;
    setEntries((list) => (next ? list?.map((e) => (e.id === selected ? next : e)) : list?.filter((e) => e.id !== selected)));
    if (!next) onSelect(undefined);
  };

  const detail = current && <MemoryDetail key={current.id} entry={current} onClose={() => onSelect(undefined)} onChanged={onChanged} />;

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader padding={4} hasDivider>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <StackItem size="fill">
              <TextInput
                label="Search memory"
                isLabelHidden
                size="sm"
                placeholder="Search memory"
                startIcon={MagnifyingGlassIcon}
                hasClear
                value={query}
                onChange={setQuery}
              />
            </StackItem>
            <Selector
              label="Scope"
              isLabelHidden
              size="sm"
              width={narrow ? "100%" : 200}
              value={scope}
              options={[
                { value: "all", label: "Global and all repos" },
                ...scopes.map((s) => ({ value: s, label: scopeLabel(s), description: s === "global" ? undefined : s.slice(5) })),
              ]}
              onChange={setScope}
            />
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          {!entries ? (
            <VStack padding={6} hAlign="center">
              <Spinner label="Loading memory…" />
            </VStack>
          ) : groups.length === 0 ? (
            <VStack padding={6}>
              <EmptyState title={query.trim() ? `Nothing matches “${query.trim()}”` : "No memories yet"} isCompact />
            </VStack>
          ) : (
            <Table columns={columns} density="balanced" dividers="rows" textOverflow="truncate" hasHover>
              <colgroup>
                {columns.map((col) => (
                  <col key={col.key} style={widths.columns.get(col.key)?.style} />
                ))}
              </colgroup>
              <TableBody>
                {groups.map(([key, list]) => {
                  const open = !collapsed.has(key);
                  return (
                    <React.Fragment key={key}>
                      <TableRow
                        role="button"
                        tabIndex={0}
                        onClick={() => toggle(key)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            toggle(key);
                          }
                        }}
                      >
                        <TableCell colSpan={columns.length} style={groupHeaderCell}>
                          <HStack gap={2} vAlign="center">
                            <Icon icon={open ? ChevronDownIcon : ChevronRightIcon} size="sm" color="secondary" />
                            <Text type="body" weight="bold">
                              {scopeLabel(key)}
                            </Text>
                            <Badge variant="neutral" label={String(list.length)} />
                            {key !== "global" && !narrow && (
                              <Text type="supporting" color="secondary" maxLines={1}>
                                {key.slice(5)}
                              </Text>
                            )}
                          </HStack>
                        </TableCell>
                      </TableRow>
                      {open &&
                        list.map((m) => (
                          <TableRow key={m.id} onClick={() => onSelect(m.id === selected ? undefined : m.id)} aria-selected={m.id === selected}>
                            {!narrow && (
                              <TableCell>
                                <Token size="sm" color={TYPE_COLOR[m.type]} label={TYPE_LABEL[m.type]} />
                              </TableCell>
                            )}
                            <TableCell>
                              <VStack gap={0}>
                                <Text type="body" maxLines={1} weight={m.id === selected ? "semibold" : undefined}>
                                  {m.description || m.name}
                                </Text>
                                <Text type="supporting" color="secondary" maxLines={1}>
                                  {m.name}
                                </Text>
                              </VStack>
                            </TableCell>
                            {!narrow && (
                              <TableCell>
                                <SourceBadges sources={m.sources} />
                              </TableCell>
                            )}
                            <TableCell>
                              <Timestamp value={m.updated} format="relative_short" />
                            </TableCell>
                          </TableRow>
                        ))}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {narrow && (
            <Dialog isOpen={!!detail} onOpenChange={(o) => !o && onSelect(undefined)} purpose="info" width={560} maxHeight="90dvh">
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
            <DetailPanel resizable={panel.props}>{detail}</DetailPanel>
          </>
        )
      }
    />
  );
}

function DetailPanel({ resizable, children }: { resizable: ResizableProps; children: React.ReactNode }) {
  return (
    <LayoutPanel hasDivider resizable={resizable} padding={4} role="complementary" label="Memory details">
      {children}
    </LayoutPanel>
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
    if (!confirm(`Delete “${entry.description || entry.name}” from every harness's memory? It stays in the git history.`)) return;
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
      <Collapsible trigger={<Text type="label">History</Text>} isOpen={showHistory} onOpenChange={setShowHistory}>
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

// ---------------- activity ----------------

const ACTIVITY_ICON: Record<ContextActivityKind, typeof PlusCircleIcon> = {
  new: PlusCircleIcon,
  duplicate: DocumentDuplicateIcon,
  update: ArrowPathIcon,
  contradicts: ExclamationTriangleIcon,
  edit: PencilSquareIcon,
  delete: TrashIcon,
  resolve: CheckCircleIcon,
  import: ArrowDownTrayIcon,
  export: ArrowUpTrayIcon,
  skill: PuzzlePieceIcon,
  drift: ArrowsRightLeftIcon,
  error: XCircleIcon,
};

function ActivityRow({ a, onOpenMemory }: { a: ContextActivity; onOpenMemory?: (id: string) => void }) {
  const source = a.source && a.source !== "you" ? (a.source.includes(":") ? sourceLabel(a.source) : a.source) : a.source === "you" ? "You" : undefined;
  return (
    <ListItem
      label={a.text}
      description={[source, a.commit?.slice(0, 8)].filter(Boolean).join(" · ") || undefined}
      startContent={
        <Icon
          icon={ACTIVITY_ICON[a.kind] ?? PlusCircleIcon}
          size="sm"
          color={a.kind === "error" ? "error" : a.kind === "contradicts" ? "warning" : "secondary"}
        />
      }
      endContent={<Timestamp value={ts(a.ts)} format="relative_short" />}
      onClick={a.memoryId && onOpenMemory ? () => onOpenMemory(a.memoryId!) : undefined}
    />
  );
}

const PAGE = 100;

function ActivityTab({ onOpenMemory }: { onOpenMemory: (id: string) => void }) {
  const [items, setItems] = useState<ContextActivity[]>();
  const [more, setMore] = useState(false);
  const live = useStore((s) => s.contextLive);
  useEffect(() => {
    rpc("contextActivity", { limit: PAGE })
      .then((list) => {
        setItems(list);
        setMore(list.length >= PAGE);
      })
      .catch(() => setItems([]));
  }, []);
  const all = useMemo(() => {
    const by = new Map<string, ContextActivity>();
    for (const a of [...(items ?? []), ...live]) by.set(a.id, a);
    return [...by.values()].sort((a, b) => b.ts - a.ts);
  }, [items, live]);
  const older = async () => {
    const before = all[all.length - 1]?.ts;
    const list = await act("contextActivity", { limit: PAGE, before });
    if (!list) return;
    setItems((cur) => [...(cur ?? []), ...list]);
    setMore(list.length >= PAGE);
  };

  if (!items)
    return (
      <VStack padding={6} hAlign="center">
        <Spinner label="Loading activity…" />
      </VStack>
    );
  if (!all.length)
    return (
      <VStack padding={6}>
        <EmptyState title="No activity yet" isCompact />
      </VStack>
    );
  return (
    <VStack padding={2} gap={2}>
      <List density="compact">
        {all.map((a) => (
          <ActivityRow key={a.id} a={a} onOpenMemory={onOpenMemory} />
        ))}
      </List>
      {more && (
        <HStack paddingInline={2}>
          <Button label="Show older" variant="ghost" size="sm" clickAction={older} />
        </HStack>
      )}
    </VStack>
  );
}

// ---------------- conflicts ----------------

function ConflictsTab() {
  const open = useStore((s) => s.conflicts);
  const [show, setShow] = useState<"open" | "all">("open");
  const [all, setAll] = useState<MemoryConflict[]>();
  useEffect(() => {
    if (show === "all")
      rpc("listConflicts", { status: "all" })
        .then(setAll)
        .catch(() => setAll([]));
  }, [show, open.length]);
  const list = show === "open" ? open : (all ?? []);
  return (
    <VStack padding={4} gap={4}>
      <HStack>
        <SegmentedControl label="Show" size="sm" value={show} onChange={(v) => setShow(v as "open" | "all")}>
          <SegmentedControlItem value="open" label={`Open (${open.length})`} />
          <SegmentedControlItem value="all" label="All" />
        </SegmentedControl>
      </HStack>
      {list.length === 0 ? (
        <EmptyState
          title={show === "open" ? "No conflicts" : "No conflicts yet"}
          description="When a new memory contradicts an old one, the newest wins and it shows up here so you can keep the old one instead."
          isCompact
        />
      ) : (
        <VStack gap={4} style={capped}>
          {list.map((c, i) => (
            <VStack key={c.id} gap={4}>
              {i > 0 && <Divider />}
              <ConflictView c={c} />
            </VStack>
          ))}
        </VStack>
      )}
    </VStack>
  );
}

// ---------------- skills ----------------

const skillColumns: TableColumn<Record<string, unknown>>[] = [
  { key: "skill", header: "Skill", width: proportional(1) },
  { key: "sources", header: "Found in", width: pixel(180) },
  { key: "drift", header: "", width: pixel(88) },
  { key: "enabled", header: "On", width: pixel(64) },
];
const narrowSkillColumns = skillColumns.filter((c) => c.key === "skill" || c.key === "enabled");

function SkillsTab({ narrow }: { narrow: boolean }) {
  const [skills, setSkills] = useState<ContextSkill[]>();
  const [busy, setBusy] = useState<string>();
  const [query, setQuery] = useState("");
  useEffect(() => {
    rpc("listSkills", {})
      .then(setSkills)
      .catch(() => setSkills([]));
  }, []);
  const toggle = async (s: ContextSkill, enabled: boolean) => {
    setBusy(s.name);
    const next = await act("setSkillEnabled", { name: s.name, enabled });
    setBusy(undefined);
    if (next) setSkills(next);
  };
  const columns = narrow ? narrowSkillColumns : skillColumns;
  const widths = resolveColumnWidths(columns);
  const q = query.trim().toLowerCase();
  const shown = (skills ?? []).filter((s) => !q || `${s.name} ${s.description ?? ""}`.toLowerCase().includes(q));
  const groups: [string, ContextSkill[]][] = [
    ["Library", shown.filter((s) => !s.repo)],
    ...[...new Set(shown.filter((s) => s.repo).map((s) => s.repo!))].map((r): [string, ContextSkill[]] => [r, shown.filter((s) => s.repo === r)]),
  ].filter(([, l]) => l.length) as [string, ContextSkill[]][];

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader padding={4} hasDivider>
          <TextInput
            label="Filter skills"
            isLabelHidden
            size="sm"
            placeholder="Filter skills"
            startIcon={MagnifyingGlassIcon}
            hasClear
            value={query}
            onChange={setQuery}
          />
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0}>
          {!skills ? (
            <VStack padding={6} hAlign="center">
              <Spinner label="Loading skills…" />
            </VStack>
          ) : !groups.length ? (
            <VStack padding={6}>
              <EmptyState title={q ? `No skill matches “${query.trim()}”` : "No skills yet"} isCompact />
            </VStack>
          ) : (
            <Table columns={columns} density="balanced" dividers="rows" textOverflow="wrap" verticalAlign="top">
              <colgroup>
                {columns.map((col) => (
                  <col key={col.key} style={widths.columns.get(col.key)?.style} />
                ))}
              </colgroup>
              <TableBody>
                {groups.map(([group, list]) => (
                  <React.Fragment key={group}>
                    <TableRow>
                      <TableCell colSpan={columns.length} style={{ ...groupHeaderCell, cursor: "default" }}>
                        <HStack gap={2} vAlign="center">
                          <Text type="body" weight="bold">
                            {group === "Library" ? "Library" : scopeLabel(`repo:${group}`)}
                          </Text>
                          <Badge variant="neutral" label={String(list.length)} />
                          {group !== "Library" && (
                            <Text type="supporting" color="secondary" maxLines={1}>
                              In the repo, left in place
                            </Text>
                          )}
                        </HStack>
                      </TableCell>
                    </TableRow>
                    {list.map((s) => (
                      <TableRow key={`${group}:${s.name}`}>
                        <TableCell>
                          <VStack gap={0.5}>
                            <HStack gap={1.5} vAlign="center">
                              <Text type="body" weight="semibold" maxLines={1}>
                                {s.name}
                              </Text>
                              {s.exposedAs && (
                                <Tooltip
                                  content={`A built-in already uses “${s.name}”, so harnesses see this one as “${s.exposedAs}”.`}
                                  hasHoverIndication={false}
                                >
                                  <Token size="sm" label={`as ${s.exposedAs}`} />
                                </Tooltip>
                              )}
                            </HStack>
                            {s.description && (
                              <Text type="supporting" color="secondary" maxLines={2}>
                                {s.description}
                              </Text>
                            )}
                            {narrow && <SkillSources s={s} />}
                            {s.drift?.length ? (
                              <Text type="supporting" color="secondary" maxLines={narrow ? 3 : 2}>
                                Kept the newest copy; {s.drift.join(", ")} differed (originals are in the backup).
                              </Text>
                            ) : null}
                          </VStack>
                        </TableCell>
                        {!narrow && (
                          <TableCell>
                            <SkillSources s={s} />
                          </TableCell>
                        )}
                        {!narrow && <TableCell>{s.drift?.length ? <Token size="sm" color="yellow" label="Drift" /> : null}</TableCell>}
                        <TableCell>
                          <Switch
                            label={`Use ${s.name} in every harness`}
                            isLabelHidden
                            value={s.enabled}
                            isLoading={busy === s.name}
                            isDisabled={!!s.repo || !!busy}
                            onChange={(v) => toggle(s, v)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </LayoutContent>
      }
    />
  );
}

function SkillSources({ s }: { s: ContextSkill }) {
  const by = new Map<string, string[]>();
  for (const x of s.sources) by.set(x.harness, [...(by.get(x.harness) ?? []), x.path]);
  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
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
