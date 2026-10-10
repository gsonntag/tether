// The Changes view: what the agent changed in the project, for the whole session or one turn.
// The runner computes the diffs from its git checkpoints (runner/src/checkpoint.ts).

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Item } from "@astryxdesign/core/Item";
import { HStack, Layout, LayoutContent, LayoutPanel, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { ArrowPathIcon, DocumentTextIcon } from "@heroicons/react/24/outline";
import { diffWordsWithSpace } from "diff";
import { create } from "zustand";
import type { DiffStat, LiveState, Msg, SessionDiff, SessionFileDiff } from "../shared/protocol";
import { rpc } from "../store";
import { fmtClock } from "../util";

/** Which session's changes are on screen, and the scope: the whole session, or a checkpoint id (one turn). */
const useChanges = create<{ sessionId?: string; scope: string }>(() => ({ scope: "session" }));
export const openChanges = (sessionId: string, scope = "session") => useChanges.setState({ sessionId, scope });
const closeChanges = () => useChanges.setState({ sessionId: undefined });

const SESSION = "session";
const addText: CSSProperties = { color: "var(--color-success)", whiteSpace: "nowrap" };
const delText: CSSProperties = { color: "var(--color-error)", whiteSpace: "nowrap" };
const minZero: CSSProperties = { minWidth: 0 };
const diffBox: CSSProperties = {
  overflowX: "auto",
  background: "var(--color-background-muted)",
  borderRadius: "var(--radius-inner)",
  paddingBlock: "var(--spacing-1)",
};
/** Rows as wide as the longest line, so the add/remove backgrounds run the full width when scrolled. */
const diffRows: CSSProperties = { width: "max-content", minWidth: "100%" };
const lineBase: CSSProperties = { whiteSpace: "pre", minHeight: "1.5em", paddingInlineEnd: "var(--spacing-3)" };
const LINE: Record<"add" | "del" | "ctx" | "hunk" | "meta", CSSProperties> = {
  add: { ...lineBase, background: "var(--color-success-muted)", color: "var(--color-text-green)" },
  del: { ...lineBase, background: "var(--color-error-muted)", color: "var(--color-text-red)" },
  ctx: lineBase,
  hunk: { ...lineBase, color: "var(--color-text-secondary)" },
  meta: { ...lineBase, color: "var(--color-text-secondary)", fontStyle: "italic" },
};
const gutter: CSSProperties = { color: "var(--color-text-secondary)", userSelect: "none", opacity: 0.7 };
/** Words that changed inside a changed line. */
const EMPH: Record<"add" | "del", CSSProperties> = {
  add: { background: "color-mix(in srgb, var(--color-success) 28%, transparent)", borderRadius: "var(--radius-inner)" },
  del: { background: "color-mix(in srgb, var(--color-error) 28%, transparent)", borderRadius: "var(--radius-inner)" },
};
const STATUS: Record<SessionFileDiff["status"], { label: string; color: "green" | "red" | "blue" | "orange" | "gray" }> = {
  added: { label: "A", color: "green" },
  deleted: { label: "D", color: "red" },
  modified: { label: "M", color: "blue" },
  typechanged: { label: "T", color: "orange" },
  unknown: { label: "?", color: "gray" },
};

/** "+12 −3": added lines in green, removed in red. */
export function StatText({ stat, type = "supporting" }: { stat: Pick<DiffStat, "additions" | "deletions">; type?: "supporting" | "inherit" }) {
  return (
    <>
      <Text type={type} hasTabularNumbers style={addText}>
        +{stat.additions}
      </Text>{" "}
      <Text type={type} hasTabularNumbers style={delText}>
        −{stat.deletions}
      </Text>
    </>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** In the session bar: what the whole session changed so far; opens the Changes view. */
export function ChangesButton({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const stat = state.diffStat;
  if (!stat && !state.checkpoints?.length) return null;
  return (
    <Button
      label={stat ? `Changes: ${plural(stat.files, "file")}, +${stat.additions} −${stat.deletions}` : "Changes"}
      tooltip="See what changed in this session"
      variant="ghost"
      size="sm"
      icon={<Icon icon={DocumentTextIcon} />}
      onClick={() => openChanges(sessionId)}
    >
      {stat ? <StatText stat={stat} type="inherit" /> : "Changes"}
    </Button>
  );
}

/**
 * Where each turn that changed files ends in the transcript, with a link to its changes. A turn
 * starts at its checkpoint (taken just before the prompt goes out) and runs until the next one.
 */
export function turnChangeMarkers(sessionId: string, messages: Msg[], state: LiveState): Map<string, ReactNode> {
  const out = new Map<string, ReactNode>();
  const cps = state.checkpoints ?? [];
  cps.forEach((cp, i) => {
    if (!cp.stat?.files) return;
    const next = cps[i + 1];
    if (!next && state.status !== "idle") return; // still running: its count isn't in yet
    const end = next?.ts ?? Infinity;
    let last: Msg | undefined;
    for (const m of messages) if (m.ts < end) last = m;
    if (!last || last.ts < cp.ts) return;
    out.set(
      last.id,
      <HStack key={`changes-${cp.id}`} gap={1} vAlign="center">
        <Button
          label={`View changes: ${plural(cp.stat.files, "file")}, +${cp.stat.additions} −${cp.stat.deletions}`}
          variant="ghost"
          size="sm"
          icon={<Icon icon={DocumentTextIcon} />}
          onClick={() => openChanges(sessionId, cp.id)}
        >
          <Text type="inherit" color="secondary">
            {plural(cp.stat.files, "file")} changed
          </Text>{" "}
          <StatText stat={cp.stat} type="inherit" />
        </Button>
      </HStack>,
    );
  });
  return out;
}

/** The Changes view: a large dialog on desktop (file list beside the diffs), a full-screen sheet on phones. */
export function ChangesDialog({ sessionId, state }: { sessionId: string; state: LiveState }) {
  const open = useChanges((s) => s.sessionId === sessionId);
  const narrow = useMediaQuery("(max-width: 760px)");
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(o) => !o && closeChanges()}
      purpose="info"
      variant={narrow ? "fullscreen" : "standard"}
      width={narrow ? undefined : "min(1200px, 94vw)"}
      maxHeight={narrow ? undefined : "92dvh"}
    >
      {open && <ChangesBody sessionId={sessionId} state={state} narrow={narrow} />}
    </Dialog>
  );
}

function ChangesBody({ sessionId, state, narrow }: { sessionId: string; state: LiveState; narrow: boolean }) {
  const scope = useChanges((s) => s.scope);
  const [diff, setDiff] = useState<SessionDiff>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const cps = state.checkpoints ?? [];
  const turnIndex = cps.findIndex((c) => c.id === scope);

  // Fetch again when the scope changes, on Refresh, and when a turn ends (the counts move then).
  const stamp = `${state.diffStat?.additions}/${state.diffStat?.deletions}/${state.diffStat?.files}/${cps.length}/${state.status === "idle"}`;
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(undefined);
    rpc("getSessionDiff", { sessionId, ...(scope !== SESSION ? { checkpoint: scope } : {}) })
      .then((d) => live && setDiff(d))
      .catch((e) => live && (setError(e?.message ?? String(e)), setDiff(undefined)))
      .finally(() => live && setLoading(false));
    return () => void (live = false);
  }, [sessionId, scope, reload, stamp]);

  const options = [
    { value: SESSION, label: "Whole session", description: state.diffStat ? statLine(state.diffStat) : "From the first turn to now" },
    ...cps
      .map((c, i) => ({
        value: c.id,
        label: `Turn ${i + 1}: ${c.label || "(no prompt)"}`,
        description: `${fmtClock(c.ts)}${c.stat ? ` · ${statLine(c.stat)}` : i === cps.length - 1 && state.status !== "idle" ? " · running" : ""}`,
      }))
      .reverse(),
  ];

  const subtitle =
    scope === SESSION
      ? diff?.base === "HEAD"
        ? "Since the last commit (this session has no checkpoint)"
        : "Since the session's first turn, up to the working tree now"
      : turnIndex < 0
        ? "That turn is no longer kept"
        : turnIndex === cps.length - 1
          ? "This turn, up to the working tree now"
          : "From the start of this turn to the start of the next";

  const bodyRef = useRef<HTMLElement>(null);
  const jump = (path: string) => bodyRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });

  const files = diff?.files ?? [];
  const toolbar = (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <StackItem size="fill" style={minZero}>
        <Selector
          label="Show changes from"
          isLabelHidden
          size="sm"
          width="100%"
          presentation="adaptive"
          options={options}
          value={scope}
          onChange={(v) => useChanges.setState({ scope: v })}
        />
      </StackItem>
      {diff && (
        <Text type="supporting" hasTabularNumbers>
          {plural(diff.fileCount, "file")} · <StatText stat={diff} />
        </Text>
      )}
      <IconButton label="Refresh" tooltip="Refresh" variant="ghost" size="sm" icon={<Icon icon={ArrowPathIcon} />} onClick={() => setReload((n) => n + 1)} />
    </HStack>
  );

  return (
    <Layout
      height="fill"
      style={narrow ? undefined : { height: "88dvh" }}
      header={<DialogHeader title="Changes" subtitle={subtitle} onOpenChange={(o) => !o && closeChanges()} />}
      start={
        !narrow && files.length > 1 ? (
          <LayoutPanel width={300} hasDivider padding={2} label="Changed files">
            <VStack gap={0.5}>
              {files.map((f) => (
                <Item
                  key={f.path}
                  density="compact"
                  label={basename(f.path)}
                  description={dirname(f.path)}
                  descriptionLines={1}
                  labelLines={1}
                  startContent={<Token size="sm" label={STATUS[f.status].label} color={STATUS[f.status].color} />}
                  endContent={<StatText stat={f} />}
                  onClick={() => jump(f.path)}
                />
              ))}
            </VStack>
          </LayoutPanel>
        ) : undefined
      }
      content={
        <LayoutContent padding={narrow ? 3 : 4}>
          <VStack gap={3} ref={bodyRef}>
            {toolbar}
            {error && <Banner status="error" title="Couldn't load the changes" description={error} />}
            {loading && !diff && !error && <EmptyState title="Reading the changes…" icon={<Spinner />} isCompact />}
            {diff && !files.length && <EmptyState title="No changes" description={scope === SESSION ? "Nothing in the project differs from the start of this session." : "This turn didn't change any files."} isCompact />}
            {diff?.truncated && (
              <Banner
                status="info"
                title="Some changes are not shown in full"
                description={
                  files.length < diff.fileCount ? `Showing ${files.length} of ${diff.fileCount} files. Large files and patches are cut short.` : "Large files and patches are cut short."
                }
              />
            )}
            {files.map((f, i) => (
              <FileDiff key={`${scope}:${f.path}`} f={f} defaultOpen={i < 40 && f.additions + f.deletions <= 600} />
            ))}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

const statLine = (s: DiffStat) => (s.files ? `${plural(s.files, "file")}, +${s.additions} −${s.deletions}` : "no changes");
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : undefined);

function FileDiff({ f, defaultOpen }: { f: SessionFileDiff; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const s = STATUS[f.status];
  const header = (
    <HStack as="span" gap={2} vAlign="center" width="100%">
      <Token size="sm" label={s.label} color={s.color} />
      <StackItem as="span" size="fill" style={minZero}>
        <Text type="code" maxLines={1}>
          {f.path}
        </Text>
      </StackItem>
      <StackItem as="span" size="static">
        <StatText stat={f} />
      </StackItem>
    </HStack>
  );
  const note = f.binary ? "Binary file, not shown" : f.skipped ? f.skipped : !f.patch ? (f.status === "typechanged" ? "File type changed" : "No line changes (empty file or mode change)") : undefined;
  return (
    <VStack data-path={f.path}>
      <Collapsible isOpen={open} onOpenChange={setOpen} trigger={header}>
        {open && (
          <VStack gap={1} paddingBlockStart={1}>
            {note ? (
              <Text type="supporting">{note}</Text>
            ) : (
              <>
                <Patch patch={f.patch} />
                {f.truncated && <Text type="supporting">Cut short: the rest of this file's diff is too large to show.</Text>}
              </>
            )}
          </VStack>
        )}
      </Collapsible>
    </VStack>
  );
}

type Row = { kind: keyof typeof LINE; text: string; old?: number; new?: number; words?: { value: string; changed: boolean }[] };

/** Parses unified-diff hunks into rows with line numbers, and marks the changed words in paired lines. */
export function parsePatch(patch: string): Row[] {
  const rows: Row[] = [];
  let o = 0;
  let n = 0;
  for (const line of patch.split("\n")) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), new: n++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), old: o++ });
    else if (line.startsWith("\\")) rows.push({ kind: "meta", text: line.slice(2) });
    else if (line.startsWith(" ")) rows.push({ kind: "ctx", text: line.slice(1), old: o++, new: n++ });
  }
  // A run of removed lines followed by as many added ones reads as edits: mark the words that changed.
  for (let i = 0; i < rows.length; ) {
    if (rows[i]!.kind !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < rows.length && rows[d]!.kind === "del") d++;
    let a = d;
    while (a < rows.length && rows[a]!.kind === "add") a++;
    if (a - d === d - i)
      for (let k = 0; k < d - i; k++) {
        const del = rows[i + k]!;
        const add = rows[d + k]!;
        if (del.text.length > 400 || add.text.length > 400) continue;
        const parts = diffWordsWithSpace(del.text, add.text);
        const same = parts.filter((p) => !p.added && !p.removed).reduce((sum, p) => sum + p.value.length, 0);
        if (same < Math.min(del.text.length, add.text.length) / 3) continue; // mostly rewritten: no word marks
        del.words = parts.filter((p) => !p.added).map((p) => ({ value: p.value, changed: !!p.removed }));
        add.words = parts.filter((p) => !p.removed).map((p) => ({ value: p.value, changed: !!p.added }));
      }
    i = Math.max(a, i + 1);
  }
  return rows;
}

function Patch({ patch }: { patch: string }) {
  const rows = parsePatch(patch);
  const width = String(rows.reduce((m, r) => Math.max(m, r.old ?? 0, r.new ?? 0), 0)).length;
  const num = (v?: number) => (v === undefined ? "" : String(v)).padStart(width);
  return (
    <VStack style={diffBox}>
      <VStack style={diffRows}>
        {rows.map((r, i) => {
          const sign = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
          return (
            <Text key={i} type="code" as="div" display="block" style={LINE[r.kind]}>
              {r.kind === "hunk" || r.kind === "meta" ? (
                <Text type="inherit" style={gutter}>{` ${" ".repeat(width * 2 + 1)}  `}</Text>
              ) : (
                <Text type="inherit" style={gutter}>{` ${num(r.old)} ${num(r.new)} `}</Text>
              )}
              {r.kind === "hunk" || r.kind === "meta" ? r.text : sign + " "}
              {r.kind !== "hunk" &&
                r.kind !== "meta" &&
                (r.words
                  ? r.words.map((w, j) =>
                      w.changed ? (
                        <Text key={j} type="inherit" style={EMPH[r.kind as "add" | "del"]}>
                          {w.value}
                        </Text>
                      ) : (
                        w.value
                      ),
                    )
                  : r.text)}
            </Text>
          );
        })}
      </VStack>
    </VStack>
  );
}
