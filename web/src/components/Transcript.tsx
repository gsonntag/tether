import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { ChatMessage, ChatMessageBubble, ChatMessageList, ChatSystemMessage } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  ArrowDownRightIcon,
  ArrowsPointingInIcon,
  ArrowUpLeftIcon,
  ArrowUturnLeftIcon,
  ChevronRightIcon,
  ClipboardDocumentCheckIcon,
  Cog6ToothIcon,
  EnvelopeIcon,
  LightBulbIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  SparklesIcon,
  Square2StackIcon,
} from "@heroicons/react/24/outline";
import { diffLines } from "diff";
import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { Msg, Part } from "../shared/protocol";
import { authorizeMcp, onMcpAuthorized } from "../mcpAuth";
import { act, selectSession, useStore } from "../store";
import { IconButton } from "@astryxdesign/core/IconButton";
import { canFork, forkTarget } from "../fork";
import { BRIEF_PREFIX, timedMessages } from "../msgTime";
import { REVIEW_PREFIX } from "../shared/review";
import { AttachmentChips } from "./Attachments";
import { FileOpenButton, fileRefMarkdown, ToolOutput } from "./FileRefs";
import { MsgTime } from "./MsgTime";
import { PlanCard } from "./PlanReview";

type ToolPart = Extract<Part, { type: "tool" }>;
type SkillPart = Extract<Part, { type: "skill" }>;
type FilePart = Extract<Part, { type: "file" }>;
type ImagePart = Extract<Part, { type: "image" }>;

/** While text streams in, half-typed paths ("src/ma") would be checked one prefix at a time: link once it's done. */
const noRefs = {};

// Static style objects (tokens only) so memoized rows don't get fresh props each render.
const listStyle: CSSProperties = { padding: "var(--spacing-0)" };
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
const imgStyle: CSSProperties = { display: "block", maxWidth: "100%", maxHeight: "40vh", borderRadius: "var(--radius-element)" };
const thinkBody: CSSProperties = {
  ...preWrap,
  display: "block",
  borderInlineStart: "var(--border-width) solid var(--color-border)",
  paddingInlineStart: "var(--spacing-2)",
};
const eventBody: CSSProperties = { maxHeight: "70vh" };
const errorText: CSSProperties = {
  ...preWrap,
  display: "block",
  color: "var(--color-error)",
  borderInlineStart: "var(--border-width) solid var(--color-error)",
  paddingInlineStart: "var(--spacing-2)",
};
const minZero: CSSProperties = { minWidth: 0 };
/** A fill item that never widens its row: long args truncate instead of pushing the badges out. */
const fillShrink: CSSProperties = { minWidth: 0, width: 0 };
const addText: CSSProperties = { color: "var(--color-success)", whiteSpace: "nowrap" };
const delText: CSSProperties = { color: "var(--color-error)", whiteSpace: "nowrap" };
const noWrap: CSSProperties = { whiteSpace: "nowrap" };
const blockText: CSSProperties = { color: "var(--color-text-red)" };
const diffBox: CSSProperties = {
  maxHeight: "60vh",
  background: "var(--color-background-muted)",
  borderRadius: "var(--radius-inner)",
  paddingBlock: "var(--spacing-1-5)",
};
const diffLineBase: CSSProperties = { whiteSpace: "pre", minHeight: "1.5em", paddingInline: "var(--spacing-3)" };
const wrapped: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
const diffLine: Record<"add" | "del" | "ctx", CSSProperties> = {
  add: { ...diffLineBase, background: "var(--color-success-muted)", color: "var(--color-text-green)" },
  del: { ...diffLineBase, background: "var(--color-error-muted)", color: "var(--color-text-red)" },
  ctx: { ...diffLineBase, color: "var(--color-text-secondary)" },
};

export const Transcript = memo(function Transcript({
  messages,
  running,
  amendable,
  after,
}: {
  messages: Msg[];
  running: boolean;
  amendable?: string[];
  /** extra rows after a message, by message id (e.g. the end of a turn that changed files) */
  after?: Map<string, ReactNode>;
}) {
  const timed = useMemo(() => timedMessages(messages), [messages]);
  return (
    <ChatMessageList align="top" isStreaming={running} style={listStyle}>
      {messages.flatMap((m, i) => {
        const row = <Message key={m.id} m={m} last={running && i === messages.length - 1} amendable={!!amendable?.includes(m.id)} timed={timed.has(m.id)} />;
        const extra = after?.get(m.id);
        return extra ? [row, extra] : [row];
      })}
    </ChatMessageList>
  );
});

/**
 * Open state that follows `want` whenever it changes (like `<details open={...}>`
 * re-applied by React), while still letting the user toggle in between.
 */
function useFollowOpen(want: boolean) {
  const [open, setOpen] = useState(want);
  const [prev, setPrev] = useState(want);
  if (prev !== want) {
    setPrev(want);
    setOpen(want);
  }
  return [open, setOpen] as const;
}

function StreamCursor() {
  return <StatusDot variant="accent" isPulsing label="Writing" />;
}

/** A steer the agent already has: it can't be taken back, so an edit goes in as a correction. */
/**
 * A skill that went with a user message (`/name`): a chip; open it to see what the agent got
 * (SKILL.md and the list of the skill's files).
 */
function SkillChip({ p }: { p: SkillPart }) {
  return (
    <Collapsible
      defaultIsOpen={false}
      chevronPosition="start"
      trigger={
        <HStack as="span" gap={1.5} vAlign="center">
          <Token size="sm" color="purple" icon={<Icon icon={SparklesIcon} size="sm" />} label={`/${p.name}`} />
          <Text type="supporting">skill</Text>
        </HStack>
      }
    >
      <CodeBlock code={p.content} isWrapped width="100%" size="sm" maxHeight="50vh" container="section" />
    </Collapsible>
  );
}

/** "Fork from here": opens the fork dialog for this message (the session's harness and model as defaults). */
function ForkButton({ m }: { m: Msg }) {
  const open = () => {
    const o = useStore.getState().open[sessionId];
    if (!o?.session) return;
    useStore.setState({ dialog: "fork", forkTarget: forkTarget(sessionId, m, o.session.harness, o.state.model) });
  };
  return <IconButton label="Fork from here" tooltip="Fork from here" variant="ghost" size="sm" icon={<Icon icon={Square2StackIcon} />} onClick={open} />;
}

/** A message's time and actions, in its metadata row. */
function Meta({ m, time, children }: { m: Msg; time?: ReactNode; children?: ReactNode }) {
  const fork = canFork(m);
  if (!fork && !children) return <>{time}</>;
  return (
    <HStack hAlign={m.role === "user" ? "end" : "start"} vAlign="center" gap={1}>
      {time}
      {children}
      {fork && <ForkButton m={m} />}
    </HStack>
  );
}

function AmendableUser({ m, text, chips, attached, typed = text, time }: { m: Msg; text: string; chips?: ReactNode; attached?: ReactNode; typed?: string; time?: ReactNode }) {
  const [draft, setDraft] = useState<string>();
  const save = async () => {
    if (draft !== undefined && draft.trim() && draft.trim() !== typed.trim()) await act("amendSteer", { sessionId, msgId: m.id, text: draft });
    setDraft(undefined);
  };
  if (draft === undefined)
    return (
      <ChatMessage sender="user">
        <ChatMessageBubble
          metadata={
            <Meta m={m} time={time}>
              <Button
                label="Edit"
                variant="ghost"
                size="sm"
                icon={<Icon icon={PencilSquareIcon} />}
                tooltip="The agent already has this message. Editing sends the change as a correction."
                onClick={() => setDraft(typed)}
              />
            </Meta>
          }
        >
          <VStack gap={1.5}>
            {chips}
            {text.trim() && <Text style={preWrap}>{text}</Text>}
            {attached}
          </VStack>
        </ChatMessageBubble>
      </ChatMessage>
    );
  return (
    <ChatMessage sender="user">
      <ChatMessageBubble width="80%">
        <VStack gap={2}>
          <TextArea
            label="Correction"
            isLabelHidden
            hasAutoFocus
            value={draft}
            rows={Math.min(10, draft.split("\n").length + 1)}
            onChange={(v) => setDraft(v)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(undefined);
              if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), save());
            }}
          />
          <Text type="supporting">The agent already has the original, so this goes in as a correction.</Text>
          <HStack gap={1.5} hAlign="end">
            <Button label="Cancel" size="sm" onClick={() => setDraft(undefined)} />
            <Button label="Send correction" variant="primary" size="sm" onClick={save} />
          </HStack>
        </VStack>
      </ChatMessageBubble>
    </ChatMessage>
  );
}

const EVENT_ICONS = {
  agent: ArrowUturnLeftIcon,
  task: Cog6ToothIcon,
  compaction: ArrowsPointingInIcon,
  channel: EnvelopeIcon,
  memory: LightBulbIcon,
} as const;

const Message = memo(function Message({ m, last, amendable, timed }: { m: Msg; last: boolean; amendable?: boolean; timed?: boolean }) {
  const time = timed ? <MsgTime ts={m.ts} /> : undefined;
  if (m.role === "user") {
    const text = m.parts
      .flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("\n")
      .trimEnd();
    if (text.startsWith(BRIEF_PREFIX) || text.startsWith(REVIEW_PREFIX))
      return (
        <Card width="100%" padding={3} variant="transparent">
          <Collapsible
            defaultIsOpen={false}
            chevronPosition="start"
            trigger={
              <Text type="supporting">
                {text.startsWith(REVIEW_PREFIX) ? "What this reviewer was asked (instructions + the session's changes)" : "Brief given to this agent (conversation + repository state)"}
              </Text>
            }
          >
            <CodeBlock code={text} isWrapped width="100%" size="sm" maxHeight="50vh" container="section" />
          </Collapsible>
        </Card>
      );
    const tools = m.parts.filter((p): p is ToolPart => p.type === "tool");
    const skills = m.parts.filter((p): p is SkillPart => p.type === "skill");
    const files = m.parts.filter((p): p is FilePart => p.type === "file");
    // A harness that stores images natively (Claude, pi) has them next to the attachment list
    // they came from: the attachment's thumbnail shows them once.
    const images = files.some((f) => f.mimeType.startsWith("image/")) ? [] : m.parts.filter((p): p is ImagePart => p.type === "image");
    const chips = skills.map((p, i) => <SkillChip key={i} p={p} />);
    const attached = files.length > 0 ? <AttachmentChips files={files} /> : undefined;
    const visible = text.trim() || skills.length > 0 || files.length > 0 || images.length > 0;
    return (
      <>
        {visible && amendable && (
          <AmendableUser m={m} text={text} chips={chips} attached={attached} typed={[...skills.map((s) => `/${s.name}`), text.trim()].filter(Boolean).join(" ")} time={time} />
        )}
        {visible && !amendable && (
          <ChatMessage sender="user">
            <ChatMessageBubble metadata={<Meta m={m} time={time} />}>
              <VStack gap={1.5}>
                {chips}
                {text.trim() && <Text style={preWrap}>{text}</Text>}
                {attached}
                {images.map((p, i) => (
                  <img key={i} src={`data:${p.mimeType};base64,${p.data}`} alt="" style={imgStyle} />
                ))}
              </VStack>
            </ChatMessageBubble>
          </ChatMessage>
        )}
        {tools.length > 0 && (
          <ChatMessage sender="assistant">
            <VStack gap={2} width="100%">
              {tools.map((t) => (
                <Tool key={t.id} t={t} />
              ))}
            </VStack>
          </ChatMessage>
        )}
      </>
    );
  }
  if (m.role === "notice") {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    if (m.title) {
      const icon = <Icon icon={(m.source && m.source in EVENT_ICONS ? EVENT_ICONS[m.source as keyof typeof EVENT_ICONS] : ChevronRightIcon)} size="sm" />;
      if (!text.trim())
        return (
          <ChatSystemMessage icon={icon}>
            {m.title}
            {time && <> · {time}</>}
          </ChatSystemMessage>
        );
      return <EventCard title={m.title} icon={icon} text={text} agent={m.source === "agent"} collapsed={!!m.collapsed} time={time} />;
    }
    const action = m.action;
    return (
      <NoticeCard level={m.level ?? "info"} time={time}>
        <VStack gap={1.5}>
          <Markdown density="compact" contentWidth="100%">
            {text}
          </Markdown>
          {action?.kind === "continueOn" && (
            <HStack>
              <Button label={action.label} size="sm" onClick={() => act("continueOn", { sessionId, msgId: m.id })} />
            </HStack>
          )}
          {action?.kind === "mcpAuth" && <McpAuthAction label={action.label} server={action.server} />}
        </VStack>
      </NoticeCard>
    );
  }
  return (
    <ChatMessage sender="assistant" metadata={<Meta m={m} time={time} />}>
      <VStack gap={2} width="100%">
        {m.parts.map((p, i) => {
          const tail = last && i === m.parts.length - 1 && m.streaming;
          switch (p.type) {
            case "text":
              return p.text ? (
                <VStack key={i} gap={1}>
                  <Markdown density="compact" contentWidth="100%" isStreaming={!!tail} {...(tail ? noRefs : fileRefMarkdown)}>
                    {p.text}
                  </Markdown>
                  {tail && <StreamCursor />}
                </VStack>
              ) : tail ? (
                <StreamCursor key={i} />
              ) : null;
            case "thinking":
              return p.text.trim() ? <Thinking key={i} text={p.text} live={!!tail} /> : null;
            case "tool":
              return <Tool key={p.id ?? i} t={p} />;
            case "plan":
              return <PlanCard key={p.id} part={p} />;
            case "image":
              return <img key={i} src={`data:${p.mimeType};base64,${p.data}`} alt="" style={imgStyle} />;
          }
        })}
        {m.error && m.error !== "aborted" && <Text style={errorText}>{m.error}</Text>}
        {m.error === "aborted" && <Text type="supporting">Stopped.</Text>}
        {last && m.streaming && m.parts.length === 0 && <StreamCursor />}
      </VStack>
    </ChatMessage>
  );
});

function EventCard({ title, icon, text, agent, collapsed, time }: { title: string; icon: ReactNode; text: string; agent: boolean; collapsed: boolean; time?: ReactNode }) {
  const [open, setOpen] = useFollowOpen(!collapsed);
  return (
    <Card width="100%" padding={3} variant={agent ? "blue" : "default"}>
      <Collapsible
        isOpen={open}
        onOpenChange={setOpen}
        chevronPosition="start"
        trigger={
          <HStack as="span" gap={2} vAlign="center" width="100%">
            {icon}
            <StackItem as="span" size="fill" style={minZero}>
              <Text type="label" color={agent ? "accent" : "secondary"}>
                {title}
              </Text>
            </StackItem>
            {time}
          </HStack>
        }
      >
        <VStack isScrollable style={eventBody}>
          <Markdown density="compact" contentWidth="100%" {...fileRefMarkdown}>
            {text}
          </Markdown>
        </VStack>
      </Collapsible>
    </Card>
  );
}

const NOTICE_VARIANT = { info: "muted", warning: "yellow", error: "red" } as const;

function NoticeCard({ level, children, time }: { level: "info" | "warning" | "error"; children: ReactNode; time?: ReactNode }) {
  return (
    <Card width="100%" padding={3} variant={NOTICE_VARIANT[level]}>
      <HStack gap={2} vAlign="start">
        <Icon icon={level} color={level === "info" ? "secondary" : level} size="sm" />
        <StackItem size="fill" style={minZero}>
          {children}
        </StackItem>
        {time}
      </HStack>
    </Card>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useFollowOpen(live);
  return (
    <Collapsible
      isOpen={open}
      onOpenChange={setOpen}
      chevronPosition="start"
      trigger={
        <Text type="supporting" color="secondary">
          {live ? "Thinking…" : "Thought"}
        </Text>
      }
    >
      <Text type="supporting" color="secondary" style={thinkBody}>
        {text}
      </Text>
    </Collapsible>
  );
}

// ---------------- tools ----------------

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2);
}

let projectRoot = "";
let sessionId = "";
/** Set by SessionView: tool paths show relative to the project; actions target this session. */
export function setProjectRoot(p: string, session: string) {
  projectRoot = p.replace(/\/$/, "");
  sessionId = session;
}

function relPath(p: unknown): string {
  const s = String(p ?? "");
  if (projectRoot && s.startsWith(projectRoot + "/")) return s.slice(projectRoot.length + 1);
  return s.replace(/^\/home\/[^/]+/, "~");
}

/** Normalizes the edit inputs of Claude Code (old_string/new_string), pi (edits[]) and Antigravity. */
function edits(input: any): { oldText: string; newText: string }[] {
  if (Array.isArray(input?.edits)) return input.edits.map((e: any) => ({ oldText: e.oldText ?? e.old_string ?? "", newText: e.newText ?? e.new_string ?? "" }));
  if (input?.old_string !== undefined || input?.new_string !== undefined) return [{ oldText: input.old_string ?? "", newText: input.new_string ?? "" }];
  if (input?.oldText !== undefined) return [{ oldText: input.oldText, newText: input.newText ?? "" }];
  // Antigravity: replace_file_content, multi_replace_file_content (ReplacementChunks), write_to_file
  const agy = (c: any) => ({ oldText: str(c?.TargetContent), newText: str(c?.ReplacementContent) });
  if (Array.isArray(input?.ReplacementChunks)) return input.ReplacementChunks.map(agy);
  if (input?.TargetContent !== undefined || input?.ReplacementContent !== undefined) return [agy(input)];
  if (typeof input?.CodeContent === "string" && !input.ArtifactMetadata) return [{ oldText: "", newText: input.CodeContent }];
  return [];
}

/** Line diffs, one block per pair; `wrap` wraps long lines (prose, like a plan) instead of scrolling. */
export function Diff({ pairs, wrap }: { pairs: { oldText: string; newText: string }[]; wrap?: boolean }) {
  return (
    <VStack isScrollable style={diffBox}>
      {pairs.map((e, k) => (
        <VStack key={k}>
          {k > 0 && (
            <Text type="code" color="secondary" display="block" style={diffLineBase}>
              ⋯
            </Text>
          )}
          {diffLines(e.oldText, e.newText).flatMap((part, j) => {
            const kind = part.added ? "add" : part.removed ? "del" : "ctx";
            return part.value
              .replace(/\n$/, "")
              .split("\n")
              .map((line, n) => (
                <Text key={`${j}-${n}`} type="code" as="div" display="block" style={wrap ? { ...diffLine[kind], ...wrapped } : diffLine[kind]}>
                  {(part.added ? "+ " : part.removed ? "- " : "  ") + line}
                </Text>
              ));
          })}
        </VStack>
      ))}
    </VStack>
  );
}

function countDiff(pairs: { oldText: string; newText: string }[]) {
  let add = 0;
  let del = 0;
  for (const e of pairs)
    for (const p of diffLines(e.oldText, e.newText)) {
      const n = p.count ?? 0;
      if (p.added) add += n;
      else if (p.removed) del += n;
    }
  return { add, del };
}

const GUARD_LABEL = { rule: "auto", judge: "judged ✓", user: "you ✓", hook: "hook ✓" } as const;
const GUARD_COLOR = { rule: "gray", judge: "blue", user: "green", hook: "gray" } as const;

function Tool({ t }: { t: ToolPart }) {
  const name = t.name;
  const lower = name.toLowerCase();
  const input: any = t.input ?? {};
  // The runner says what the call is (t.kind); transcripts from before that are guessed from names.
  const k = t.kind;
  const isEdit = k ? k === "edit" : ["edit", "multiedit", "str_replace_based_edit_tool"].includes(lower) || edits(input).length > 0;
  const isWrite = k ? k === "write" : lower === "write";
  const isShell = k ? k === "shell" : ["bash", "shell", "exec", "run_terminal_cmd", "run_command"].includes(lower);
  const isTodo = (k ? k === "todo" : lower === "todowrite") && Array.isArray(input.todos);
  const expandShell = useStore((s) => s.ui.expandShell);
  const failed = isShell && t.status === "error";
  const [open, setOpen] = useState(isEdit || (isShell && expandShell) || isTodo || failed);
  // A command that fails opens, even collapsed by default: the output is what you'd look for.
  const [wasFailed, setWasFailed] = useState(failed);
  if (wasFailed !== failed) {
    setWasFailed(failed);
    if (failed) setOpen(true);
  }

  let arg = "";
  /** the file this tool read or wrote, for the open-file button */
  let filePath: string | undefined;
  const p = t.path ?? input.file_path ?? input.filePath ?? input.path ?? input.AbsolutePath ?? input.TargetFile;
  if (isShell) arg = t.command ?? input.command ?? input.CommandLine ?? input.cmd ?? "";
  else if (k === "search" && input.pattern) arg = `${input.pattern}${input.path ? "  in " + relPath(input.path) : ""}`;
  else if (p) {
    arg = relPath(p);
    // With a kind, only file tools carry a path to open.
    if (k ? t.path : typeof p === "string" && !input.pattern) filePath = k ? t.path : p;
  }
  else if (input.pattern) arg = `${input.pattern}${input.path ? "  in " + relPath(input.path) : ""}`;
  else if (input.url) arg = input.url;
  else if (input.description) arg = input.description;
  else if (input.query) arg = input.query;
  else if (input.prompt) arg = String(input.prompt).slice(0, 120);

  // A write is its content: Antigravity's write_to_file keeps it where edits() finds it.
  const written = isWrite ? edits(input) : [];
  const pairs = isEdit ? edits(input) : written.length ? written : isWrite && typeof input.content === "string" ? [{ oldText: "", newText: input.content }] : [];
  const stat = pairs.length ? countDiff(pairs) : undefined;

  const blocked = t.guard?.decision === "deny";
  // Plan mode or a review held this back on purpose: running it anyway takes a second click.
  const held = blocked && t.guard!.by === "mode";
  const [confirming, setConfirming] = useState(false);
  // A blocked command the user ran themselves shows that run's result instead of the agent's.
  const run = t.userRun;
  const status = run ? (run.status === "running" ? "running" : run.exitCode ? "error" : "done") : t.status;
  const output = run ? run.output : t.output;
  const command = typeof input.command === "string" || Array.isArray(input.command) || typeof input.CommandLine === "string" || typeof input.cmd === "string";
  const icon = blocked ? (
    <Icon icon={NoSymbolIcon} color="error" size="sm" label="Blocked" />
  ) : status === "running" ? (
    <Spinner size="sm" aria-label="Running" />
  ) : status === "error" ? (
    <Icon icon="error" color="error" size="sm" label="Failed" />
  ) : (
    <Icon icon="success" color="success" size="sm" label="Done" />
  );
  const lines = output ? output.trimEnd().split("\n").length : 0;
  const guard = t.guard && !blocked && t.guard.by !== "mode" ? t.guard : undefined;

  const header = (
    <HStack as="span" gap={2} vAlign="center" width="100%">
      {icon}
      <StackItem as="span" size="static">
        <Text type="label" weight="semibold">
          {name}
        </Text>
      </StackItem>
      <StackItem as="span" size="fill" style={fillShrink}>
        <Text type="code" color="secondary" maxLines={1}>
          {arg}
        </Text>
      </StackItem>
      {stat ? (
        <StackItem as="span" size="static">
          <Text type="supporting" style={addText}>
            +{stat.add}
          </Text>
          {stat.del > 0 && (
            <Text type="supporting" style={delText}>
              {" "}
              −{stat.del}
            </Text>
          )}
        </StackItem>
      ) : lines > 1 ? (
        <StackItem as="span" size="static">
          <Text type="supporting" style={noWrap}>
            {lines} lines
          </Text>
        </StackItem>
      ) : null}
      {t.judging && !t.guard && (
        <StackItem as="span" size="static">
          <Tooltip content="The safety judge is checking this call" hasHoverIndication={false}>
            <Token size="sm" label="checking…" color="gray" />
          </Tooltip>
        </StackItem>
      )}
      {guard && (
        <StackItem as="span" size="static">
          <Tooltip content={guard.reason} isEnabled={!!guard.reason} hasHoverIndication={false}>
            <Token size="sm" label={GUARD_LABEL[guard.by as keyof typeof GUARD_LABEL] ?? guard.by} color={GUARD_COLOR[guard.by as keyof typeof GUARD_COLOR] ?? "gray"} />
          </Tooltip>
        </StackItem>
      )}
    </HStack>
  );

  return (
    <Card width="100%" padding={0} variant={blocked ? "red" : "default"}>
      <VStack paddingInline={3} paddingBlock={1} gap={1}>
        <HStack gap={1} vAlign="start">
          <StackItem size="fill" style={minZero}>
            <Collapsible isOpen={open} onOpenChange={setOpen} trigger={header}>
              {open && (
                <VStack gap={2} paddingBlockEnd={1}>
                  {pairs.length > 0 && <Diff pairs={pairs} />}
                  {isTodo && (
                    <VStack gap={0.5}>
                      {input.todos.map((td: any, i: number) => {
                        const done = td.status === "completed";
                        return (
                          <HStack key={i} gap={2}>
                            <Text color={done ? "secondary" : undefined}>{done ? "☑" : td.status === "in_progress" ? "◐" : "☐"}</Text>
                            <Text color={done ? "secondary" : undefined} hasStrikethrough={done}>
                              {td.content ?? td.activeForm}
                            </Text>
                          </HStack>
                        );
                      })}
                    </VStack>
                  )}
                  {!isShell && !pairs.length && !isTodo && Object.keys(input).length > 0 && (
                    <CodeBlock code={str(input)} language="json" isWrapped width="100%" size="sm" maxHeight="50vh" hasLanguageLabel={false} />
                  )}
                  {output && (!pairs.length || status === "error") && <ToolOutput text={output} />}
                </VStack>
              )}
            </Collapsible>
          </StackItem>
          {filePath && <FileOpenButton path={filePath} line={Number(input.offset ?? input.line ?? input.StartLine) || undefined} />}
        </HStack>
        {blocked && (
          <HStack gap={2} vAlign="center" paddingBlockEnd={1}>
            <StackItem size="fill" style={minZero}>
              <Text type="supporting" style={blockText}>
                {confirming
                  ? `Plan mode or a review held this back. ${command ? "Run" : "Allow"} it anyway? `
                  : held
                    ? "Held back: "
                    : null}
                {held ? (confirming ? null : (t.guard!.reason ?? "")) : <>Blocked by {t.guard!.by === "user" ? "you" : t.guard!.by === "judge" ? "the safety judge" : t.guard!.by === "hook" ? "your hook" : "the safety rules"}:{" "}
                {(t.guard!.reason ?? "").replace(/^Blocked:\s*/, "")}</>}
              </Text>
            </StackItem>
            {t.guard!.by !== "user" &&
              (held && !confirming ? (
                <Button label={command ? "Run it myself" : "Approve & retry"} size="sm" onClick={() => setConfirming(true)} />
              ) : command ? (
                <Button
                  label={confirming ? "Run anyway" : "Run it myself"}
                  variant={confirming ? "destructive" : undefined}
                  size="sm"
                  onClick={() => {
                    setOpen(true);
                    act("runBlocked", { sessionId, toolId: t.id, confirmed: confirming || undefined });
                  }}
                />
              ) : (
                <Button
                  label={confirming ? "Approve anyway" : "Approve & retry"}
                  variant={confirming ? "destructive" : undefined}
                  size="sm"
                  onClick={() => act("approveBlocked", { sessionId, toolId: t.id, confirmed: confirming || undefined })}
                />
              ))}
            {confirming && <Button label="Cancel" variant="ghost" size="sm" onClick={() => setConfirming(false)} />}
          </HStack>
        )}
      </VStack>
    </Card>
  );
}

type Link = { sessionId: string; reason: string };

export function LinkBanner({ from, to, forked, reviewOf }: { from?: Link; to?: Link; forked?: Link; reviewOf?: { sessionId: string } }) {
  return (
    <>
      {reviewOf && (
        <Card width="100%" padding={2} variant="transparent">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Icon icon={ClipboardDocumentCheckIcon} color="secondary" size="sm" />
            <Text type="supporting">Read-only review of</Text>
            <Button label={`${reviewOf.sessionId.split(":")[0]} session`} size="sm" onClick={() => selectSession(reviewOf.sessionId)} />
            <Text type="supporting">Its findings show there.</Text>
          </HStack>
        </Card>
      )}
      {forked && (
        <Card width="100%" padding={2} variant="transparent">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Icon icon={Square2StackIcon} color="secondary" size="sm" />
            <Text type="supporting">Forked from</Text>
            <Button label={`${forked.sessionId.split(":")[0]} session`} size="sm" onClick={() => selectSession(forked.sessionId)} />
            <Text type="supporting">{forked.reason}</Text>
          </HStack>
        </Card>
      )}
      {from && (
        <Card width="100%" padding={2} variant="transparent">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Icon icon={ArrowUpLeftIcon} color="secondary" size="sm" />
            <Text type="supporting">Continued from</Text>
            <Button label={`${from.sessionId.split(":")[0]} session`} size="sm" onClick={() => selectSession(from.sessionId)} />
            <Text type="supporting">{from.reason}</Text>
          </HStack>
        </Card>
      )}
      {to && (
        <Card width="100%" padding={3} variant="yellow">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Icon icon={ArrowDownRightIcon} color="warning" size="sm" />
            <Text>This conversation continues in another session ({to.reason}).</Text>
            <Button label="Open it" variant="ghost" size="sm" onClick={() => selectSession(to.sessionId)} />
          </HStack>
        </Card>
      )}
    </>
  );
}

/** A session's "Authorize <server>" button: opens the MCP server's sign-in, then says how it went, in place. */
function McpAuthAction({ label, server }: { label: string; server: string }) {
  const [state, setState] = useState<{ busy?: boolean; done?: boolean; url?: string; note?: string }>({});
  useEffect(() => onMcpAuthorized((id) => id === server && setState({ done: true })), [server]);
  if (state.done)
    return (
      <Text type="supporting" color="secondary">
        Connected.
      </Text>
    );
  const go = async () => {
    setState({ busy: true });
    try {
      const { start, opened } = await authorizeMcp(server);
      if ("needsClient" in start) setState({ note: "Its sign-in server needs a client ID: add one under MCP servers on the Memory & Skills page." });
      else setState(opened ? {} : { url: start.url });
    } catch (e: any) {
      setState({ note: e?.message ?? String(e) });
    }
  };
  return (
    <VStack gap={1}>
      <HStack>
        <Button label={label} size="sm" isLoading={state.busy} onClick={go} />
      </HStack>
      {state.url && (
        <Text type="supporting">
          The browser blocked the sign-in tab:{" "}
          <a href={state.url} target="_blank" rel="noopener noreferrer">
            open the sign-in page
          </a>
        </Text>
      )}
      {state.note && (
        <Text type="supporting" color="secondary">
          {state.note}
        </Text>
      )}
    </VStack>
  );
}
