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
  Cog6ToothIcon,
  EnvelopeIcon,
  NoSymbolIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";
import { diffLines } from "diff";
import { memo, useState, type CSSProperties, type ReactNode } from "react";
import type { Msg, Part } from "../shared/protocol";
import { act, selectSession } from "../store";
import { PlanCard } from "./PlanReview";

type ToolPart = Extract<Part, { type: "tool" }>;

const BRIEF_PREFIX = "You are taking over an in-progress coding session";

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
  return (
    <ChatMessageList align="top" isStreaming={running} style={listStyle}>
      {messages.flatMap((m, i) => {
        const row = <Message key={m.id} m={m} last={running && i === messages.length - 1} amendable={!!amendable?.includes(m.id)} />;
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
function AmendableUser({ m, text }: { m: Msg; text: string }) {
  const [draft, setDraft] = useState<string>();
  const save = async () => {
    if (draft !== undefined && draft.trim() && draft.trim() !== text.trim()) await act("amendSteer", { sessionId, msgId: m.id, text: draft });
    setDraft(undefined);
  };
  if (draft === undefined)
    return (
      <ChatMessage sender="user">
        <ChatMessageBubble
          metadata={
            <HStack hAlign="end">
              <Button
                label="Edit"
                variant="ghost"
                size="sm"
                icon={<Icon icon={PencilSquareIcon} />}
                tooltip="The agent already has this message. Editing sends the change as a correction."
                onClick={() => setDraft(text)}
              />
            </HStack>
          }
        >
          <Text style={preWrap}>{text}</Text>
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
} as const;

const Message = memo(function Message({ m, last, amendable }: { m: Msg; last: boolean; amendable?: boolean }) {
  if (m.role === "user") {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    if (text.startsWith(BRIEF_PREFIX))
      return (
        <Card width="100%" padding={3} variant="transparent">
          <Collapsible
            defaultIsOpen={false}
            chevronPosition="start"
            trigger={<Text type="supporting">Handoff brief given to this agent (conversation + repository state)</Text>}
          >
            <CodeBlock code={text} isWrapped width="100%" size="sm" maxHeight="50vh" container="section" />
          </Collapsible>
        </Card>
      );
    const tools = m.parts.filter((p): p is ToolPart => p.type === "tool");
    return (
      <>
        {text.trim() && amendable && <AmendableUser m={m} text={text} />}
        {text.trim() && !amendable && (
          <ChatMessage sender="user">
            <ChatMessageBubble>
              <VStack gap={1.5}>
                <Text style={preWrap}>{text}</Text>
                {m.parts.map((p, i) => (p.type === "image" ? <img key={i} src={`data:${p.mimeType};base64,${p.data}`} alt="" style={imgStyle} /> : null))}
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
      if (!text.trim()) return <ChatSystemMessage icon={icon}>{m.title}</ChatSystemMessage>;
      return <EventCard title={m.title} icon={icon} text={text} agent={m.source === "agent"} collapsed={!!m.collapsed} />;
    }
    return <NoticeCard level={m.level ?? "info"}>{<Markdown density="compact" contentWidth="100%">{text}</Markdown>}</NoticeCard>;
  }
  return (
    <ChatMessage sender="assistant">
      <VStack gap={2} width="100%">
        {m.parts.map((p, i) => {
          const tail = last && i === m.parts.length - 1 && m.streaming;
          switch (p.type) {
            case "text":
              return p.text ? (
                <VStack key={i} gap={1}>
                  <Markdown density="compact" contentWidth="100%" isStreaming={!!tail}>
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

function EventCard({ title, icon, text, agent, collapsed }: { title: string; icon: ReactNode; text: string; agent: boolean; collapsed: boolean }) {
  const [open, setOpen] = useFollowOpen(!collapsed);
  return (
    <Card width="100%" padding={3} variant={agent ? "blue" : "default"}>
      <Collapsible
        isOpen={open}
        onOpenChange={setOpen}
        chevronPosition="start"
        trigger={
          <HStack as="span" gap={2} vAlign="center">
            {icon}
            <Text type="label" color={agent ? "accent" : "secondary"}>
              {title}
            </Text>
          </HStack>
        }
      >
        <VStack isScrollable style={eventBody}>
          <Markdown density="compact" contentWidth="100%">
            {text}
          </Markdown>
        </VStack>
      </Collapsible>
    </Card>
  );
}

const NOTICE_VARIANT = { info: "muted", warning: "yellow", error: "red" } as const;

function NoticeCard({ level, children }: { level: "info" | "warning" | "error"; children: ReactNode }) {
  return (
    <Card width="100%" padding={3} variant={NOTICE_VARIANT[level]}>
      <HStack gap={2} vAlign="start">
        <Icon icon={level} color={level === "info" ? "secondary" : level} size="sm" />
        <StackItem size="fill" style={minZero}>
          {children}
        </StackItem>
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

function Diff({ pairs }: { pairs: { oldText: string; newText: string }[] }) {
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
                <Text key={`${j}-${n}`} type="code" as="div" display="block" style={diffLine[kind]}>
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

const GUARD_LABEL = { rule: "auto", judge: "judged ✓", user: "you ✓" } as const;
const GUARD_COLOR = { rule: "gray", judge: "blue", user: "green" } as const;

function Tool({ t }: { t: ToolPart }) {
  const name = t.name;
  const lower = name.toLowerCase();
  const input: any = t.input ?? {};
  const isEdit = ["edit", "multiedit", "str_replace_based_edit_tool"].includes(lower) || edits(input).length > 0;
  const isWrite = lower === "write";
  const isShell = ["bash", "shell", "exec", "run_terminal_cmd", "run_command"].includes(lower);
  const isTodo = lower === "todowrite" && Array.isArray(input.todos);
  const [open, setOpen] = useState(isEdit || (isShell && t.status === "running") || isTodo);

  let arg = "";
  if (isShell) arg = input.command ?? input.CommandLine ?? input.cmd ?? "";
  else if (input.file_path || input.filePath || input.path || input.AbsolutePath || input.TargetFile)
    arg = relPath(input.file_path ?? input.filePath ?? input.path ?? input.AbsolutePath ?? input.TargetFile);
  else if (input.pattern) arg = `${input.pattern}${input.path ? "  in " + relPath(input.path) : ""}`;
  else if (input.url) arg = input.url;
  else if (input.description) arg = input.description;
  else if (input.query) arg = input.query;
  else if (input.prompt) arg = String(input.prompt).slice(0, 120);

  const pairs = isEdit ? edits(input) : isWrite ? [{ oldText: "", newText: str(input.content) }] : [];
  const stat = pairs.length ? countDiff(pairs) : undefined;

  const blocked = t.guard?.decision === "deny";
  const icon = blocked ? (
    <Icon icon={NoSymbolIcon} color="error" size="sm" label="Blocked" />
  ) : t.status === "running" ? (
    <Spinner size="sm" aria-label="Running" />
  ) : t.status === "error" ? (
    <Icon icon="error" color="error" size="sm" label="Failed" />
  ) : (
    <Icon icon="success" color="success" size="sm" label="Done" />
  );
  const lines = t.output ? t.output.trimEnd().split("\n").length : 0;
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
              {t.output && (!pairs.length || t.status === "error") && (
                <CodeBlock code={t.output.length > 20000 ? t.output.slice(0, 20000) + "\n…" : t.output} isWrapped width="100%" size="sm" maxHeight="50vh" />
              )}
            </VStack>
          )}
        </Collapsible>
        {blocked && (
          <HStack gap={2} vAlign="center" paddingBlockEnd={1}>
            <StackItem size="fill" style={minZero}>
              <Text type="supporting" style={blockText}>
                Blocked by {t.guard!.by === "user" ? "you" : t.guard!.by === "judge" ? "the safety judge" : "the safety rules"}:{" "}
                {(t.guard!.reason ?? "").replace(/^Blocked:\s*/, "")}
              </Text>
            </StackItem>
            {t.guard!.by !== "user" && <Button label="Approve & retry" size="sm" onClick={() => act("approveBlocked", { sessionId, toolId: t.id })} />}
          </HStack>
        )}
      </VStack>
    </Card>
  );
}

export function LinkBanner({ from, to }: { from?: { sessionId: string; reason: string }; to?: { sessionId: string; reason: string } }) {
  return (
    <>
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
