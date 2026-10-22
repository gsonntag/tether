import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import { SelectableCard } from "@astryxdesign/core/SelectableCard";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timer } from "@astryxdesign/core/Timer";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { HARNESSES, type UiRequest } from "../shared/protocol";
import { act, cardFocused, NARROW_QUERY, useStore } from "../store";
import { PlanRequestCard } from "./PlanReview";
import { Diff, edits } from "./Transcript";

const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
const warnText: CSSProperties = { ...preWrap, color: "var(--color-text-yellow)" };
const noWrap: CSSProperties = { whiteSpace: "nowrap" };
const minZero: CSSProperties = { minWidth: 0 };
/**
 * SelectableCard ignores a click while text inside it is selected, and a click on the option's words
 * that moves a pixel or two selects some: the pick was dropped, and so was every click after it
 * until the selection went away. Option text isn't selectable, so a click always picks.
 */
const noSelect: CSSProperties = { userSelect: "none", WebkitUserSelect: "none" };

export function UiRequests({ sessionId, requests }: { sessionId: string; requests: UiRequest[] }) {
  return (
    <>
      {requests.map((r) => (
        <RequestCard key={r.id} sessionId={sessionId} r={r} />
      ))}
    </>
  );
}

/** One selectable answer row (question options and select requests). */
function Option({ label, description, on, onPick }: { label: string; description?: string; on: boolean; onPick: () => void }) {
  return (
    <SelectableCard label={label} isSelected={on} onChange={onPick} padding={2} width="100%">
      <VStack gap={0.5} style={noSelect}>
        <Text>{label}</Text>
        {description && <Text type="supporting">{description}</Text>}
      </VStack>
    </SelectableCard>
  );
}

/** A notification for this request was tapped: scrolls the card into view once it's on screen. */
function useFocusCard(id: string) {
  const ref = useRef<HTMLDivElement>(null);
  const focused = useStore((s) => s.focusCard === id);
  useEffect(() => {
    if (!focused) return;
    ref.current?.scrollIntoView({ block: "nearest" });
    cardFocused(id);
  }, [focused, id]);
  return ref;
}

function RequestCard({ sessionId, r }: { sessionId: string; r: UiRequest }) {
  const ref = useFocusCard(r.id);
  if (r.kind === "plan") return <PlanRequestCard sessionId={sessionId} r={r} />;
  if (r.kind === "permission") return <PermissionCard sessionId={sessionId} r={r} focusRef={ref} />;
  return <OtherCard sessionId={sessionId} r={r} focusRef={ref} />;
}

type Respond = (response: Omit<Parameters<typeof act<"uiRespond">>[1]["response"], "id">) => Promise<unknown>;
const responder = (sessionId: string, r: UiRequest): Respond => (response) => act("uiRespond", { sessionId, response: { id: r.id, ...response } });

// ---------------- approvals ----------------

const relTo = (p: string, root?: string) => {
  const r = root?.replace(/\/$/, "");
  if (r && p.startsWith(r + "/")) return p.slice(r.length + 1);
  return p.replace(/^\/home\/[^/]+/, "~");
};

/** What the call is, in words: what it does and what it does it to. */
function describeCall(name: string, input: any, root?: string): { verb: string; command?: string; path?: string; server?: string } {
  const command = input?.command ?? input?.CommandLine ?? input?.cmd;
  if (typeof command === "string" || Array.isArray(command)) return { verb: "wants to run", command: Array.isArray(command) ? command.join(" ") : command };
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) return { verb: `wants to call ${mcp[1]}`, server: mcp[2] };
  const p = input?.file_path ?? input?.filePath ?? input?.path ?? input?.notebook_path ?? input?.TargetFile;
  if (typeof p === "string") {
    const write = /write|create/i.test(name) && !edits(input).length;
    return { verb: `wants to ${write ? "write" : /^(read|view)/i.test(name) ? "read" : "edit"} ${relTo(p, root)}`, path: p };
  }
  if (typeof input?.url === "string") return { verb: `wants to fetch ${input.url}` };
  return { verb: `wants to use ${name}` };
}

/** An edit's preview: the transcript's diff of the first changes, or the new file's first lines. */
function EditPreview({ input }: { input: any }) {
  const pairs = edits(input);
  const content = typeof input?.content === "string" ? input.content : typeof input?.CodeContent === "string" ? input.CodeContent : undefined;
  const shown = pairs.length ? pairs.slice(0, 3) : content !== undefined ? [{ oldText: "", newText: content.split("\n").slice(0, 40).join("\n") }] : [];
  if (!shown.length) return null;
  return <Diff pairs={shown} />;
}

function PermissionCard({ sessionId, r, focusRef }: { sessionId: string; r: UiRequest; focusRef: RefObject<HTMLDivElement | null> }) {
  const phone = useMediaQuery(NARROW_QUERY);
  const harness = useStore((s) => s.open[sessionId]?.session?.harness);
  const root = useStore((s) => s.open[sessionId]?.session?.projectPath);
  const [reason, setReason] = useState<string>();
  const [busy, setBusy] = useState(false);
  // When it started waiting: the runner says (newer runners); else when this card first showed it.
  const [seen] = useState(() => r.at ?? Date.now());
  const respond = responder(sessionId, r);
  const once = (f: () => Promise<unknown>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  const input: any = r.tool?.input ?? {};
  const name = r.tool?.name ?? "";
  const call = describeCall(name, input, root);
  const who = HARNESSES.find((h) => h.id === harness)?.label ?? "The agent";
  const note = r.message?.replace(/^⚠\s*/, "").replace(/^Blocked:\s*/, "");
  const size = phone ? "lg" : "md";
  const isEdit = !!call.path && !call.verb.startsWith("wants to read");

  const body: ReactNode = call.command ? (
    <CodeBlock code={call.command} language="bash" isWrapped width="100%" size="sm" maxHeight="30vh" hasLanguageLabel={false} />
  ) : isEdit ? (
    <EditPreview input={input} />
  ) : call.path ? null : (
    <CodeBlock code={JSON.stringify(input, null, 2)} language="json" isWrapped width="100%" size="sm" maxHeight="30vh" hasLanguageLabel={false} />
  );

  const menu = [
    { label: "Deny with a reason…", onClick: () => setReason("") },
    ...(call.command ? [{ label: "Run it myself", description: "Tether runs it and gives the agent the output", onClick: once(() => respond({ allow: false, runMyself: true })) }] : []),
    {
      label: "Full access for 15 minutes",
      description: "Approves this and everything else until then",
      onClick: once(async () => {
        await act("setGuard", { sessionId, mode: "full", minutes: 15 });
        await respond({ allow: true });
      }),
    },
  ];

  return (
    <Card width="100%" padding={3} variant="blue">
      <VStack ref={focusRef} gap={2}>
        <HStack gap={2} vAlign="center">
          <StackItem size="fill" style={minZero}>
            <Text type="label" weight="semibold" maxLines={2}>
              {who} {call.verb}
              {call.server ? (
                <Text type="code" color="secondary">
                  {" "}
                  {call.server}
                </Text>
              ) : null}
            </Text>
          </StackItem>
          <StackItem size="static">
            <Text type="supporting" color="secondary" style={noWrap}>
              waiting <Timer startTime={seen} type="inherit" color="inherit" />
            </Text>
          </StackItem>
        </HStack>
        {body}
        {note && (
          <Text type="supporting" style={warnText}>
            Guard: {note}
          </Text>
        )}
        {reason !== undefined && (
          <TextInput
            label="Reason for denying"
            isLabelHidden
            hasAutoFocus
            placeholder="Tell the agent why, then Deny"
            value={reason}
            onChange={setReason}
            onKeyDown={(e) => {
              if (e.key === "Enter") once(() => respond({ allow: false, value: reason.trim() || undefined }))();
              if (e.key === "Escape") setReason(undefined);
            }}
            width="100%"
          />
        )}
        <HStack gap={2} vAlign="center">
          <Button label="Approve" variant="primary" size={size} isDisabled={busy} onClick={once(() => respond({ allow: true }))} />
          <Button label="Always allow" size={size} isDisabled={busy} onClick={once(() => respond({ allow: true, always: true }))} />
          <StackItem size="fill" />
          <MoreMenu label="More ways to answer" size={size} alignment="end" presentation="adaptive" isDisabled={busy} items={menu} />
          <Button label="Deny" size={size} isDisabled={busy} onClick={once(() => respond({ allow: false, value: reason?.trim() || undefined }))} />
        </HStack>
      </VStack>
    </Card>
  );
}

// ---------------- questions, confirms, selects, inputs ----------------

function OtherCard({ sessionId, r, focusRef }: { sessionId: string; r: UiRequest; focusRef: RefObject<HTMLDivElement | null> }) {
  const [value, setValue] = useState(r.kind === "input" ? (r.message ?? "") : "");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const respond = responder(sessionId, r);

  const title = (
    <Text type="label" weight="semibold">
      {r.title}
    </Text>
  );

  if (r.kind === "question" && r.questions) {
    // One single-choice question: a pick is the answer.
    const pickAnswers = r.questions.length === 1 && !r.questions[0]!.multiSelect;
    const typed = Object.values(other).some((v) => v.trim());
    return (
      <Card width="100%" padding={3} variant="blue">
        <VStack ref={focusRef} gap={3}>
          {title}
          {r.questions.map((q) => (
            <VStack key={q.question} gap={1.5}>
              <Text>{q.question}</Text>
              {q.options.map((o) => {
                const cur = answers[q.question]?.split(", ") ?? [];
                const on = cur.includes(o.label);
                return (
                  <Option
                    key={o.label}
                    label={o.label}
                    description={o.description}
                    on={on}
                    onPick={() => {
                      if (pickAnswers) {
                        setAnswers({ [q.question]: o.label });
                        return void respond({ answers: { [q.question]: o.label } });
                      }
                      setAnswers({
                        ...answers,
                        [q.question]: q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur.filter(Boolean), o.label]).join(", ") : o.label,
                      });
                    }}
                  />
                );
              })}
              <TextInput
                label="Other answer"
                isLabelHidden
                placeholder="Other…"
                width="100%"
                value={other[q.question] ?? ""}
                onChange={(v) => {
                  setOther({ ...other, [q.question]: v });
                  setAnswers({ ...answers, [q.question]: v });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && pickAnswers && (other[q.question] ?? "").trim()) respond({ answers: { [q.question]: other[q.question]!.trim() } });
                }}
              />
            </VStack>
          ))}
          <HStack gap={2} wrap="wrap">
            {(!pickAnswers || typed) && (
              <Button label="Answer" variant="primary" isDisabled={r.questions.some((q) => !answers[q.question])} onClick={() => respond({ answers })} />
            )}
            <Button label="Dismiss" onClick={() => respond({ cancelled: true })} />
          </HStack>
        </VStack>
      </Card>
    );
  }

  return (
    <Card width="100%" padding={3} variant="blue">
      <VStack ref={focusRef} gap={2}>
        {title}
        {r.message && r.kind !== "input" && <Text style={preWrap}>{r.message}</Text>}
        {r.kind === "select" && (
          <VStack gap={1.5}>
            {(r.options ?? []).map((o) => (
              <Option key={o} label={o} on={false} onPick={() => respond({ value: o })} />
            ))}
          </VStack>
        )}
        {r.kind === "input" && (
          <TextArea label={r.title || "Response"} isLabelHidden rows={3} placeholder={r.placeholder} value={value} onChange={(v) => setValue(v)} width="100%" />
        )}
        <HStack gap={2} wrap="wrap">
          {r.kind === "confirm" && (
            <>
              <Button label="Yes" variant="primary" onClick={() => respond({ confirmed: true })} />
              <Button label="No" onClick={() => respond({ confirmed: false })} />
            </>
          )}
          {r.kind === "input" && <Button label="Submit" variant="primary" onClick={() => respond({ value })} />}
          <Button label="Dismiss" onClick={() => respond({ cancelled: true })} />
        </HStack>
      </VStack>
    </Card>
  );
}
