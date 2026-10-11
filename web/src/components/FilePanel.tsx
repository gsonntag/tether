// The file panel: opened from a file reference in the transcript (FileRefs.tsx). Beside the chat
// on desktop (resizable), full screen with a back button on phones. Shows the file's diff for the
// whole session or one turn (Diff), or the file as it is now (File), at the referenced line.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, Layout, LayoutContent, LayoutHeader, LayoutPanel, StackItem, VStack } from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { ArrowLeftIcon, ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { create } from "zustand";
import { FILE_VIEW_LIMITS, type FileContents, type FileDiffResult, type LiveState, type SessionFileDiff } from "../shared/protocol";
import { rpc } from "../store";
import { fmtClock } from "../util";
import { openChanges, Patch, StatText } from "./Changes";

export interface FileTarget {
  sessionId: string;
  /** relative to the project */
  path: string;
  line?: number;
  endLine?: number;
  /** what the runner said when the reference was checked */
  changed?: boolean;
  exists?: boolean;
  /** a new id per click, so clicking the same reference again jumps to its line again */
  nonce: number;
}

const usePanel = create<{ target?: FileTarget }>(() => ({}));
let nonce = 0;

/**
 * Where the chat should stay put while the panel opens and the transcript reflows: the clicked
 * reference, at its place on screen (SessionView keeps it there).
 */
export let scrollAnchor: { node: Element; top: number } | undefined;
export const takeScrollAnchor = () => {
  const a = scrollAnchor;
  scrollAnchor = undefined;
  return a;
};

export function openFile(sessionId: string, ref: { path: string; line?: number; endLine?: number }, opts: { changed?: boolean; exists?: boolean; anchor?: Element } = {}) {
  if (opts.anchor) scrollAnchor = { node: opts.anchor, top: opts.anchor.getBoundingClientRect().top };
  usePanel.setState({ target: { sessionId, ...ref, changed: opts.changed, exists: opts.exists, nonce: ++nonce } });
}
export const closeFile = () => usePanel.setState({ target: undefined });
export const useFileTarget = (sessionId: string) => usePanel((s) => (s.target?.sessionId === sessionId ? s.target : undefined));

const SESSION = "session";
const minZero: CSSProperties = { minWidth: 0 };
const fillHeight: CSSProperties = { height: "100%" };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const STATUS: Record<SessionFileDiff["status"], { label: string; color: "green" | "red" | "blue" | "orange" | "gray" }> = {
  added: { label: "Added", color: "green" },
  deleted: { label: "Deleted", color: "red" },
  modified: { label: "Modified", color: "blue" },
  typechanged: { label: "Type changed", color: "orange" },
  unknown: { label: "Changed", color: "gray" },
};

/** CodeBlock's languages, by extension. */
const LANGS: Record<string, string> = {
  ts: "ts", mts: "ts", cts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx", json: "json", jsonc: "json",
  html: "html", htm: "html", xml: "xml", svg: "svg", css: "css", scss: "scss", less: "less", py: "python",
  sh: "bash", bash: "bash", zsh: "bash", php: "php", hack: "hack", yaml: "yaml", yml: "yaml", md: "markdown", markdown: "markdown",
};
const languageOf = (path: string) => LANGS[basename(path).split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";

/** Desktop: the panel at the session's end edge, resizable. Escape closes it (unless something else wants that Escape). */
export function FilePanel({ target, state }: { target: FileTarget; state: LiveState }) {
  const panel = useResizable({ defaultSize: 600, minSize: 360, maxSize: 1200, autoSaveId: "tether.filePanel" });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], dialog")) return;
      if (document.querySelector("dialog[open]")) return;
      closeFile();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <ResizeHandle resizable={panel.props} isReversed isAlwaysVisible={false} />
      <LayoutPanel hasDivider resizable={panel.props} padding={0} role="complementary" label={`File ${target.path}`}>
        <FileView key={`${target.path}#${target.nonce}`} target={target} state={state} narrow={false} />
      </LayoutPanel>
    </>
  );
}

/** Phones: the same view full screen, with a back button. */
export function FileSheet({ target, state }: { target?: FileTarget; state: LiveState }) {
  return (
    <Dialog isOpen={!!target} onOpenChange={(o) => !o && closeFile()} purpose="info" variant="fullscreen">
      {target && <FileView key={`${target.path}#${target.nonce}`} target={target} state={state} narrow />}
    </Dialog>
  );
}

type Tab = "diff" | "file";

function FileView({ target, state, narrow }: { target: FileTarget; state: LiveState; narrow: boolean }) {
  const { sessionId, path, line } = target;
  const range = useMemo<[number, number] | undefined>(() => (line ? [line, Math.max(line, target.endLine ?? line)] : undefined), [line, target.endLine]);
  // Diff first when the session changed the file; otherwise the file itself (decided once the diff is in when unknown).
  const [tab, setTab] = useState<Tab | undefined>(target.changed ? "diff" : target.changed === false ? "file" : undefined);
  const [scope, setScope] = useState(SESSION);
  const [diff, setDiff] = useState<FileDiffResult>();
  const [diffError, setDiffError] = useState<string>();
  const [file, setFile] = useState<FileContents>();
  const [fileError, setFileError] = useState<string>();

  // Fetch again when the scope changes and when a turn ends (the file may have changed).
  const cps = state.checkpoints ?? [];
  const stamp = `${state.diffStat?.additions}/${state.diffStat?.deletions}/${state.diffStat?.files}/${cps.length}/${state.status === "idle"}`;
  useEffect(() => {
    let live = true;
    setDiffError(undefined);
    rpc("fileDiff", { sessionId, path, ...(scope !== SESSION ? { checkpoint: scope } : {}) })
      .then((d) => {
        if (!live) return;
        setDiff(d);
        setTab((t) => t ?? (d.file ? "diff" : "file"));
      })
      .catch((e) => {
        if (!live) return;
        setDiffError(e?.message ?? String(e));
        setDiff(undefined);
        setTab((t) => t ?? "file");
      });
    return () => void (live = false);
  }, [sessionId, path, scope, stamp]);

  useEffect(() => {
    if (tab !== "file") return;
    let live = true;
    setFileError(undefined);
    rpc("readFile", { sessionId, path, maxBytes: FILE_VIEW_LIMITS.bytes })
      .then((f) => live && setFile(f))
      .catch((e) => live && (setFileError(e?.message ?? String(e)), setFile(undefined)));
    return () => void (live = false);
  }, [sessionId, path, tab, stamp]);

  const f = diff?.file;
  const turns = diff?.turns ?? [];
  const scopeOptions = [
    { value: SESSION, label: "Whole session", description: "From the session's first turn to now" },
    ...turns
      .map((t) => ({
        value: t.checkpoint,
        label: `Turn ${t.index + 1}: ${t.label || "(no prompt)"}`,
        description: `${fmtClock(t.ts)} · ${t.binary ? "binary" : `+${t.additions} −${t.deletions}`}`,
      }))
      .reverse(),
  ];
  // A turn picked earlier that no longer changed it still shows in the list.
  if (scope !== SESSION && !scopeOptions.some((o) => o.value === scope)) scopeOptions.push({ value: scope, label: "That turn", description: "" });

  const status = f ? STATUS[f.status] : undefined;
  const name = `${basename(path)}${line ? `:${line}${range && range[1] !== range[0] ? `-${range[1]}` : ""}` : ""}`;
  const title = (
    <VStack gap={0.5} style={minZero}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="code" weight="semibold" maxLines={1}>
          {name}
        </Text>
        {status && <Token size="sm" label={status.label} color={status.color} />}
        {f && <StatText stat={f} />}
      </HStack>
      {dirname(path) && (
        <Text type="supporting" maxLines={1}>
          {dirname(path)}
        </Text>
      )}
    </VStack>
  );
  const openInChanges = (
    <Button
      label="Open in Changes"
      tooltip="See this file among everything the session changed"
      variant="ghost"
      size="sm"
      icon={<Icon icon={ArrowTopRightOnSquareIcon} />}
      onClick={() => openChanges(sessionId, scope, path)}
    >
      {narrow ? "Changes" : "Open in Changes"}
    </Button>
  );

  const header = narrow ? (
    <DialogHeader
      title={
        <Text type="code" weight="semibold" maxLines={1}>
          {name}
        </Text>
      }
      subtitle={
        <>
          {dirname(path) || "."}
          {f && (
            <>
              {" · "}
              <StatText stat={f} />
            </>
          )}
        </>
      }
      startContent={<IconButton label="Back to the chat" tooltip="Back" variant="ghost" size="sm" icon={<Icon icon={ArrowLeftIcon} />} onClick={closeFile} />}
      endContent={openInChanges}
      hasDivider
    />
  ) : (
    <LayoutHeader hasDivider label="File">
      <HStack gap={2} vAlign="center" paddingInline={3} paddingBlock={2}>
        <StackItem size="fill" style={minZero}>
          {title}
        </StackItem>
        {openInChanges}
        <IconButton label="Close file" tooltip="Close (Esc)" variant="ghost" size="sm" icon={<Icon icon="close" />} onClick={closeFile} />
      </HStack>
    </LayoutHeader>
  );

  const toolbar = (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <SegmentedControl label="Show" size="sm" value={tab ?? "diff"} onChange={(v) => setTab(v as Tab)}>
        <SegmentedControlItem value="diff" label="Diff" />
        <SegmentedControlItem value="file" label="File" />
      </SegmentedControl>
      {tab === "diff" && turns.length > 0 && (
        <StackItem size="fill" style={minZero}>
          <Selector label="Show changes from" isLabelHidden size="sm" width="100%" presentation="adaptive" options={scopeOptions} value={scope} onChange={setScope} />
        </StackItem>
      )}
    </HStack>
  );

  return (
    <Layout
      height="fill"
      style={narrow ? undefined : fillHeight}
      header={header}
      content={
        <LayoutContent padding={3}>
          <VStack gap={3}>
            {toolbar}
            {!tab && <EmptyState title="Opening…" icon={<Spinner />} isCompact />}
            {tab === "diff" && <DiffTab diff={diff} error={diffError} scope={scope} range={range} exists={diff?.exists ?? target.exists} onShowFile={() => setTab("file")} />}
            {tab === "file" && <FileTab file={file} error={fileError} path={path} range={range} deleted={diff ? !diff.exists : target.exists === false} />}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

/** Scrolls the first element matching `selector` under `box` to the middle, once it's rendered. */
function useScrollTo(box: RefObject<HTMLElement | null>, selector: string | undefined, ready: unknown) {
  const done = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (!selector || !ready || done.current === selector) return;
    const el = box.current?.querySelector(selector);
    if (!el) return;
    done.current = selector;
    centerIn(el);
  }, [box, selector, ready]);
}

/**
 * Scrolls `el` to the middle of its nearest vertically scrolling ancestor, and nothing else:
 * scrollIntoView would also scroll the containers around the panel, moving the chat beside it.
 */
function centerIn(el: Element) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) {
      const r = el.getBoundingClientRect();
      const box = p.getBoundingClientRect();
      p.scrollTop += r.top - box.top - (p.clientHeight - r.height) / 2;
      return;
    }
  }
}

function DiffTab({
  diff,
  error,
  scope,
  range,
  exists,
  onShowFile,
}: {
  diff?: FileDiffResult;
  error?: string;
  scope: string;
  range?: [number, number];
  exists?: boolean;
  onShowFile: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const f = diff?.file;
  const shown = !!f?.patch && !f.binary && !f.skipped;
  // The referenced line, or the first changed line near it when the line itself has no row here.
  const inPatch = useMemo(() => {
    if (!range || !f?.patch) return false;
    for (const m of f.patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      if (range[0] <= start + len - 1 && range[1] >= start) return true;
    }
    return false;
  }, [range, f?.patch]);
  useScrollTo(box, shown && range && inPatch ? `[data-marked="true"]` : undefined, shown);

  if (error) return <Banner status="error" title="Couldn't load the diff" description={error} />;
  if (!diff) return <EmptyState title="Reading the diff…" icon={<Spinner />} isCompact />;
  if (!f)
    return (
      <EmptyState
        isCompact
        title={scope === SESSION ? "Not changed in this session" : "Not changed in this turn"}
        description={diff.base === "HEAD" ? "Compared with the last commit (this session has no checkpoint)." : undefined}
        actions={exists !== false ? <Button label="Show the file" size="sm" onClick={onShowFile} /> : undefined}
      />
    );
  const note = f.binary ? "Binary file, not shown" : f.skipped ? f.skipped : !f.patch ? (f.status === "typechanged" ? "File type changed" : "No line changes (empty file or mode change)") : undefined;
  return (
    <VStack gap={2} ref={box}>
      {range && shown && !inPatch && (
        <Banner
          status="info"
          title={`Line ${range[0]}${range[1] !== range[0] ? `–${range[1]}` : ""} isn't part of these changes`}
          endContent={exists !== false ? <Button label="Show in the file" size="sm" onClick={onShowFile} /> : undefined}
        />
      )}
      {note ? <Text type="supporting">{note}</Text> : <Patch patch={f.patch} highlight={range} />}
      {f.truncated && <Text type="supporting">Cut short: the rest of this file's diff is too large to show.</Text>}
    </VStack>
  );
}

function FileTab({ file, error, path, range, deleted }: { file?: FileContents; error?: string; path: string; range?: [number, number]; deleted: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => (range ? Array.from({ length: Math.min(range[1] - range[0] + 1, 500) }, (_, i) => range[0] + i) : undefined), [range]);
  const count = useMemo(() => (file?.content ? file.content.split("\n").length : 0), [file?.content]);
  // Highlighting tens of thousands of lines is slow: very long files show as plain text.
  const language = count > 5000 ? "plaintext" : languageOf(path);
  useScrollTo(box, file?.content !== undefined && range ? `[data-line="${range[0]}"]` : undefined, file?.content);

  if (deleted) return <EmptyState isCompact title="This file was deleted" description="The session removed it; the Diff tab shows what it had." />;
  if (error) return <Banner status="error" title="Couldn't read the file" description={error} />;
  if (!file) return <EmptyState title="Reading the file…" icon={<Spinner />} isCompact />;
  if (file.binary) return <EmptyState isCompact title="Binary file" description={`${fmtSize(file.size)}, not shown.`} />;
  return (
    <VStack gap={2} ref={box}>
      {file.truncated && (
        <Banner
          status="info"
          title="Only the start of this file is shown"
          description={file.truncated === "lines" ? `The first ${FILE_VIEW_LIMITS.lines.toLocaleString()} lines of a longer file.` : `The first ${fmtSize(FILE_VIEW_LIMITS.bytes)} of ${fmtSize(file.size)}.`}
        />
      )}
      {range && range[0] > count && <Banner status="warning" title={`The file has ${plural(count, "line")}, so line ${range[0]} isn't there now`} />}
      {file.content ? (
        <CodeBlock code={file.content.replace(/\n$/, "")} language={language} hasLanguageLabel={false} hasLineNumbers highlightLines={lines} size="sm" width="100%" />
      ) : (
        <Text type="supporting">Empty file</Text>
      )}
    </VStack>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / (1024 * 102.4)) / 10} MB`;
}
