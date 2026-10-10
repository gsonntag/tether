import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { SelectableCard } from "@astryxdesign/core/SelectableCard";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState, type CSSProperties } from "react";
import type { UiRequest } from "../shared/protocol";
import { act } from "../store";
import { PlanRequestCard } from "./PlanReview";

const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };

export function UiRequests({ sessionId, requests }: { sessionId: string; requests: UiRequest[] }) {
  return (
    <>
      {requests.map((r) => (
        <RequestCard key={r.id} sessionId={sessionId} r={r} />
      ))}
    </>
  );
}

function summarizeTool(input: any): string {
  if (!input) return "";
  if (input.command) return input.command;
  if (input.file_path) return input.file_path + (input.content ? `\n\n${String(input.content).slice(0, 1500)}` : "");
  return JSON.stringify(input, null, 2);
}

/** One selectable answer row (question options and select requests). */
function Option({ label, description, on, onPick }: { label: string; description?: string; on: boolean; onPick: () => void }) {
  return (
    <SelectableCard label={label} isSelected={on} onChange={onPick} padding={2} width="100%">
      <VStack gap={0.5}>
        <Text>{label}</Text>
        {description && <Text type="supporting">{description}</Text>}
      </VStack>
    </SelectableCard>
  );
}

function RequestCard({ sessionId, r }: { sessionId: string; r: UiRequest }) {
  const [value, setValue] = useState(r.kind === "input" ? (r.message ?? "") : "");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const respond = (response: Omit<Parameters<typeof act<"uiRespond">>[1]["response"], "id">) =>
    act("uiRespond", { sessionId, response: { id: r.id, ...response } });

  const title = (
    <Text type="label" weight="semibold">
      {r.title}
    </Text>
  );

  if (r.kind === "plan") return <PlanRequestCard sessionId={sessionId} r={r} />;

  if (r.kind === "permission")
    return (
      <Card width="100%" padding={3} variant="blue">
        <VStack gap={2}>
          {title}
          <CodeBlock code={summarizeTool(r.tool?.input)} isWrapped width="100%" size="sm" maxHeight="30vh" />
          <TextInput label="Reason for denying" isLabelHidden placeholder="Optional: tell the agent why you deny it" value={value} onChange={(v) => setValue(v)} width="100%" />
          <HStack gap={2} wrap="wrap">
            <Button label="Allow" variant="primary" onClick={() => respond({ allow: true })} />
            <Button label="Always allow" onClick={() => respond({ allow: true, always: true })} />
            <Button label="Deny" variant="destructive" onClick={() => respond({ allow: false, value })} />
          </HStack>
        </VStack>
      </Card>
    );

  if (r.kind === "question" && r.questions)
    return (
      <Card width="100%" padding={3} variant="blue">
        <VStack gap={3}>
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
                    onPick={() =>
                      setAnswers({
                        ...answers,
                        [q.question]: q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur.filter(Boolean), o.label]).join(", ") : o.label,
                      })
                    }
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
              />
            </VStack>
          ))}
          <HStack gap={2} wrap="wrap">
            <Button label="Answer" variant="primary" isDisabled={r.questions.some((q) => !answers[q.question])} onClick={() => respond({ answers })} />
            <Button label="Dismiss" onClick={() => respond({ cancelled: true })} />
          </HStack>
        </VStack>
      </Card>
    );

  return (
    <Card width="100%" padding={3} variant="blue">
      <VStack gap={2}>
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
