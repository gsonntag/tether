import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { ClipboardDocumentCheckIcon } from "@heroicons/react/24/outline";
import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { modelDisplay } from "../models";
import { HARNESSES, type Msg, type ReviewSeverity, type SessionReview } from "../shared/protocol";
import { bySeverity, findingWhere, reviewAnchors, SEVERITY_LABEL } from "../shared/review";
import { act, selectSession } from "../store";
import { FileOpenButton } from "./FileRefs";

const SEVERITY_COLOR: Record<ReviewSeverity, "red" | "orange" | "yellow" | "gray"> = { critical: "red", high: "orange", medium: "yellow", low: "gray" };
const preWrap: CSSProperties = { whiteSpace: "pre-wrap", wordBreak: "break-word" };
const minZero: CSSProperties = { minWidth: 0 };

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** "Codex · GPT-6 Sol" */
function reviewer(r: SessionReview): string {
  const h = HARNESSES.find((x) => x.id === r.harness)?.label ?? r.harness;
  return r.model ? `${h} · ${modelDisplay(r.model, r.harness).name}` : h;
}

/**
 * A review of this session's changes (/review), inline after the message it followed: who reviews,
 * how it's going, and the findings, each with "Send to agent"; "Send all" sends the ones not sent
 * yet. The review session itself opens from here.
 */
export function ReviewCard({ sessionId, review: r }: { sessionId: string; review: SessionReview }) {
  const [busy, setBusy] = useState<string>();
  const send = async (key: string, indexes?: number[]) => {
    setBusy(key);
    try {
      await act("sendReviewFindings", { sessionId, reviewId: r.id, indexes });
    } finally {
      setBusy(undefined);
    }
  };
  const working = r.status === "starting" || r.status === "running";
  const unsent = r.findings.filter((_, i) => !r.sent.includes(i)).length;
  const what = r.stat ? `${plural(r.stat.files, "file")}, +${r.stat.additions} −${r.stat.deletions}` : undefined;
  const title = working ? `Reviewing with ${reviewer(r)}…` : r.status === "failed" ? `Review by ${reviewer(r)} didn't finish` : `Review by ${reviewer(r)}`;
  return (
    <Card width="100%" padding={3} variant={r.status === "failed" ? "yellow" : "default"}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          {working ? <Spinner size="sm" aria-label="Reviewing" /> : <Icon icon={ClipboardDocumentCheckIcon} color="secondary" size="sm" />}
          <StackItem size="fill" style={minZero}>
            <Text type="label">{title}</Text>
          </StackItem>
          {r.status === "done" && <Token size="sm" label={r.findings.length ? plural(r.findings.length, "finding") : "No findings"} color={r.findings.length ? "default" : "green"} />}
          {r.sessionId && <Button label="Open review" variant="ghost" size="sm" onClick={() => selectSession(r.sessionId)} />}
        </HStack>
        {(what || r.focus) && (
          <Text type="supporting" color="secondary">
            {[what && `Changes reviewed: ${what}`, r.focus && `Focus: ${r.focus}`].filter(Boolean).join(" · ")}
          </Text>
        )}
        {r.status === "failed" && r.error && <Text style={preWrap}>{r.error}</Text>}
        {r.summary && <Text style={preWrap}>{r.summary}</Text>}
        {r.findings.length > 0 && (
          <List density="compact" hasDividers>
            {bySeverity(r.findings.map((f, i) => ({ f, i }))).map(({ f, i }) => {
              const sent = r.sent.includes(i);
              return (
                <ListItem
                  key={i}
                  label={
                    <HStack gap={1.5} vAlign="center" wrap="wrap">
                      <Token size="sm" label={SEVERITY_LABEL[f.severity]} color={SEVERITY_COLOR[f.severity]} />
                      <Text type="code" maxLines={1}>
                        {findingWhere(f)}
                      </Text>
                      <FileOpenButton path={f.file} line={f.line} />
                    </HStack>
                  }
                  description={
                    <VStack gap={1}>
                      <Text style={preWrap}>{f.issue}</Text>
                      {f.fix && (
                        <Text type="supporting" color="secondary" style={preWrap}>
                          Fix: {f.fix}
                        </Text>
                      )}
                    </VStack>
                  }
                  endContent={
                    <Button
                      label={sent ? "Sent" : "Send to agent"}
                      variant="ghost"
                      size="sm"
                      tooltip={sent ? "Sent to the agent. Send it again?" : "Queue a message asking the agent to fix this"}
                      isLoading={busy === `f${i}`}
                      isDisabled={!!busy}
                      onClick={() => send(`f${i}`, [i])}
                    />
                  }
                />
              );
            })}
          </List>
        )}
        {r.findings.length > 1 && unsent > 0 && (
          <HStack hAlign="end">
            <Button label={unsent === r.findings.length ? "Send all" : `Send the other ${unsent}`} variant="primary" size="sm" isLoading={busy === "all"} isDisabled={!!busy} onClick={() => send("all")} />
          </HStack>
        )}
      </VStack>
    </Card>
  );
}

/**
 * The transcript's extra rows (`after`) with each review's card after the message it followed; one
 * whose message isn't in the transcript (reloaded history, a handoff) goes after the last one.
 */
export function withReviews(after: Map<string, ReactNode>, sessionId: string, messages: Msg[], reviews: SessionReview[] | undefined): Map<string, ReactNode> {
  if (!reviews?.length) return after;
  const out = new Map(after);
  const at = new Map(reviewAnchors(messages, reviews));
  for (const r of reviews) {
    const anchor = at.get(r.id);
    if (!anchor) continue;
    const card = <ReviewCard key={`review-${r.id}`} sessionId={sessionId} review={r} />;
    const prev = out.get(anchor);
    out.set(
      anchor,
      prev ? (
        <Fragment key={`after-${anchor}-${r.id}`}>
          {prev}
          {card}
        </Fragment>
      ) : (
        card
      ),
    );
  }
  return out;
}
