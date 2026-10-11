// Clickable file references in the transcript: paths in assistant text, inline code, markdown
// links, tool cards and tool output. A path only becomes a link once the runner says it's a file in
// the project or one this session changed (checkPaths, batched and cached per session); anything
// else stays plain text. Clicking opens the file panel (FilePanel.tsx).

import { createContext, useContext, useEffect, useMemo, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Code } from "@astryxdesign/core/Code";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { VStack } from "@astryxdesign/core/Layout";
import { Link } from "@astryxdesign/core/Link";
import type { MarkdownComponents, MarkdownInlinePlugin } from "@astryxdesign/core/Markdown";
import { Text } from "@astryxdesign/core/Text";
import { DocumentMagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { create } from "zustand";
import { findRefs, matchRef, parseRefToken, REF_SOURCE, refFromHref, type FileRef } from "../fileRefs";
import type { PathCheck } from "../shared/protocol";
import { rpc } from "../store";
import { openFile } from "./FilePanel";

/** Which session the references belong to; `beforeOpen` runs before the panel opens (e.g. closing a dialog over it). */
const Scope = createContext<{ sessionId: string; beforeOpen?: () => void } | undefined>(undefined);
export const FileRefScope = Scope.Provider;
export const useFileRefScope = () => useContext(Scope);

// ---------------- checks (cached per session) ----------------

type Entry = { check: PathCheck | null; gen: number };
const useChecks = create<{ gen: Record<string, number>; checks: Record<string, Record<string, Entry>> }>(() => ({ gen: {}, checks: {} }));

const queued = new Map<string, Set<string>>();
const inflight = new Map<string, Set<string>>();
let timer: ReturnType<typeof setTimeout> | undefined;
const BATCH = 300;

function want(sessionId: string, path: string) {
  if (inflight.get(sessionId)?.has(path)) return;
  let q = queued.get(sessionId);
  if (!q) queued.set(sessionId, (q = new Set()));
  q.add(path);
  // Everything a render asks for goes out together.
  timer ??= setTimeout(flush, 30);
}

function flush() {
  timer = undefined;
  for (const [sessionId, set] of queued) {
    queued.delete(sessionId);
    const paths = [...set];
    const busy = inflight.get(sessionId) ?? new Set<string>();
    inflight.set(sessionId, busy);
    for (let i = 0; i < paths.length; i += BATCH) {
      const batch = paths.slice(i, i + BATCH);
      const gen = useChecks.getState().gen[sessionId] ?? 0;
      batch.forEach((p) => busy.add(p));
      rpc("checkPaths", { sessionId, paths: batch })
        .then(
          (res) => {
            // No longer in flight before anyone re-renders: an answer that's already stale is asked again.
            batch.forEach((p) => busy.delete(p));
            useChecks.setState((s) => {
              const mine = { ...s.checks[sessionId] };
              for (const p of batch) mine[p] = { check: res[p] ?? null, gen };
              return { checks: { ...s.checks, [sessionId]: mine } };
            });
          },
          // Not connected, or an older runner without checkPaths: stay plain text; asked again on the next change.
          () => batch.forEach((p) => busy.delete(p)),
        );
    }
  }
}

/** Files may have appeared or changed (a turn ended): check what's on screen again, keeping the old answers meanwhile. */
export function refreshFileChecks(sessionId: string) {
  useChecks.setState((s) => ({ gen: { ...s.gen, [sessionId]: (s.gen[sessionId] ?? 0) + 1 } }));
}

/** The runner's answer for these paths: a check, null (not a project file), or undefined (not known yet). */
function useChecksFor(sessionId: string | undefined, paths: string[]): Record<string, PathCheck | null | undefined> {
  const mine = useChecks((s) => (sessionId ? s.checks[sessionId] : undefined));
  const gen = useChecks((s) => (sessionId ? (s.gen[sessionId] ?? 0) : 0));
  const stale = paths.filter((p) => !mine?.[p] || mine[p]!.gen < gen);
  // Each stale path with the generation of its answer: an answer that arrives already stale (a turn
  // ended while it was in flight) changes the key, so the path is asked again.
  const key = `${gen}\0${stale.map((p) => `${mine?.[p]?.gen ?? -1}:${p}`).join("\0")}`;
  useEffect(() => {
    if (sessionId) for (const p of stale) want(sessionId, p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, key]);
  return Object.fromEntries(paths.map((p) => [p, mine?.[p]?.check]));
}

function usePathCheck(path: string | undefined): PathCheck | null | undefined {
  const scope = useFileRefScope();
  const paths = useMemo(() => (path ? [path] : []), [path]);
  const checks = useChecksFor(scope?.sessionId, paths);
  return path ? checks[path] : undefined;
}

// ---------------- links ----------------

const linkCode: CSSProperties = { cursor: "pointer" };

function describe(check: PathCheck, ref: FileRef) {
  const at = ref.line ? `${check.path}:${ref.line}${ref.endLine && ref.endLine !== ref.line ? `-${ref.endLine}` : ""}` : check.path;
  return `Open ${at}${check.changed ? (check.exists ? " (changed in this session)" : " (deleted in this session)") : ""}`;
}

function useOpener(check: PathCheck | null | undefined, ref: FileRef) {
  const scope = useFileRefScope();
  return (e: MouseEvent<HTMLElement>) => {
    if (!check || !scope) return;
    e.preventDefault();
    e.stopPropagation();
    scope.beforeOpen?.();
    openFile(scope.sessionId, { path: check.path, line: ref.line, endLine: ref.endLine }, { changed: check.changed, exists: check.exists, anchor: e.currentTarget });
  };
}

/** A reference in prose: a link once the runner knows the file, plain text until then (and for good if it isn't one). */
function RefText({ text, fileRef }: { text: string; fileRef: FileRef }) {
  const check = usePathCheck(fileRef.path);
  const open = useOpener(check, fileRef);
  if (!check) return <>{text}</>;
  return (
    <Link href={`#file=${encodeURI(check.path)}`} onClick={open} tooltip={describe(check, fileRef)} hasUnderline>
      {text}
    </Link>
  );
}

/** Inline code that is exactly a file reference (`src/a.ts:42`) links; any other code stays code. */
function InlineCode({ children }: { children: string }) {
  const fileRef = useMemo(() => parseRefToken(children), [children]);
  const check = usePathCheck(fileRef?.path);
  const open = useOpener(check, fileRef ?? { path: "" });
  if (!check || !fileRef) return <Code>{children}</Code>;
  return (
    <Link href={`#file=${encodeURI(check.path)}`} onClick={open} tooltip={describe(check, fileRef)} hasUnderline style={linkCode}>
      <Code>{children}</Code>
    </Link>
  );
}

/** Markdown links to local files (`[the parser](src/parse.ts#L10)`, `file:///…`) open the panel; others are ordinary links. */
function MarkdownLink({ href, children }: { href: string; children: ReactNode }) {
  const fileRef = useMemo(() => refFromHref(href), [href]);
  const check = usePathCheck(fileRef?.path);
  const open = useOpener(check, fileRef ?? { path: "" });
  if (check && fileRef)
    return (
      <Link href={`#file=${encodeURI(check.path)}`} onClick={open} tooltip={describe(check, fileRef)} hasUnderline>
        {children}
      </Link>
    );
  // As Markdown's own links: web links in a new tab, without an opener or the session's URL as referrer.
  const external = /^https?:\/\//i.test(href);
  return (
    <Link href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
      {children}
    </Link>
  );
}

const inlinePlugin: MarkdownInlinePlugin = {
  pattern: new RegExp(REF_SOURCE, "g"),
  getEndIndex: (_text, m) => {
    const f = matchRef(m);
    return f ? (m.index ?? 0) + f.length : false;
  },
  render: (m, key) => {
    const f = matchRef(m)!;
    return <RefText key={key} text={m[0].slice(0, f.length)} fileRef={f.ref} />;
  },
};

/** Spread onto <Markdown> wherever agent text is shown. Stable objects, so memoized rows stay memoized. */
export const fileRefMarkdown: { components: MarkdownComponents; inlinePlugins: MarkdownInlinePlugin[] } = {
  components: { inlineCode: InlineCode, link: MarkdownLink },
  inlinePlugins: [inlinePlugin],
};

// ---------------- tool cards ----------------

/** Beside a tool card's file path (Read, Edit, Write…): opens that file, once the runner knows it. */
export function FileOpenButton({ path, line }: { path: string; line?: number }) {
  const fileRef = useMemo(() => ({ path, ...(line && line > 0 ? { line } : {}) }), [path, line]);
  const check = usePathCheck(path);
  const open = useOpener(check, fileRef);
  if (!check) return null;
  return <IconButton label={describe(check, fileRef)} tooltip={describe(check, fileRef)} variant="ghost" size="sm" icon={<Icon icon={DocumentMagnifyingGlassIcon} />} onClick={open} />;
}

const outputBox: CSSProperties = {
  maxHeight: "50vh",
  background: "var(--color-background-muted)",
  borderRadius: "var(--radius-element)",
  padding: "var(--spacing-2) var(--spacing-3)",
};
const outputText: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
const MAX_LINKED_OUTPUT = 20_000;

/**
 * Tool output (shell, grep, …): a code block, with its file references (`src/foo.ts:12:3`) as links
 * once at least one of them is a real project file.
 */
export function ToolOutput({ text }: { text: string }) {
  const scope = useFileRefScope();
  const shown = text.length > MAX_LINKED_OUTPUT ? text.slice(0, MAX_LINKED_OUTPUT) + "\n…" : text;
  const found = useMemo(() => (text.length > MAX_LINKED_OUTPUT ? [] : findRefs(text).slice(0, 500)), [text]);
  const paths = useMemo(() => [...new Set(found.map((f) => f.ref.path))], [found]);
  const checks = useChecksFor(scope?.sessionId, paths);
  const linked = found.filter((f) => checks[f.ref.path]);
  if (!linked.length) return <CodeBlock code={shown} isWrapped width="100%" size="sm" maxHeight="50vh" />;
  const parts: ReactNode[] = [];
  let at = 0;
  linked.forEach((f, i) => {
    if (f.index > at) parts.push(text.slice(at, f.index));
    parts.push(<RefText key={i} text={text.slice(f.index, f.index + f.length)} fileRef={f.ref} />);
    at = f.index + f.length;
  });
  parts.push(text.slice(at));
  return (
    <VStack isScrollable style={outputBox}>
      <Text type="code" display="block" style={outputText}>
        {parts}
      </Text>
    </VStack>
  );
}
