// Open requests (SPEC §7, §10): approvals and questions, just above the composer, never scrolled
// away with the transcript. Approve, Deny, Deny with reason; a question's options are buttons, and
// you can type an answer instead. Answering on one device clears it on every other one (the state
// event); a device that answers second is told "Already answered.".

import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Markdown } from "@astryxdesign/core/Markdown";
import type { Request, RequestAnswer, RequestQuestion, ToolPart } from "../../../shared/transcript";
import { rpc } from "../connection";
import { openSession } from "../route";
import { shortPath, ToolDetails } from "./ToolCard";

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** "Claude wants to edit math.ts" */
export function requestTitle(r: Request, root?: string): string {
  if (r.plan !== undefined) return r.title ?? "Claude's plan is ready";
  const path = r.path ? shortPath(r.path, root) : undefined;
  const i = (r.input ?? {}) as Record<string, unknown>;
  switch (r.toolKind) {
    case "shell":
      return "Claude wants to run a command";
    case "edit":
      return path ? `Claude wants to edit ${path}` : "Claude wants to edit a file";
    case "write":
      return path ? `Claude wants to write ${path}` : "Claude wants to write a file";
    case "read":
      return path ? `Claude wants to read ${path}` : "Claude wants to read a file";
    case "fetch":
      return typeof i.url === "string" ? `Claude wants to fetch ${i.url}` : "Claude wants to search the web";
    case "task":
      return "Claude wants to start a subagent";
    default:
      return `Claude wants to use ${r.tool ?? "a tool"}`;
  }
}

export function RequestDock({ runnerId, sessionId, requests, root }: { runnerId: string; sessionId: string; requests: Request[]; root?: string }) {
  const [note, setNote] = useState<string>();
  const ids = requests.map((r) => r.id).join(",");
  // The note answers your own action; it goes when the requests change again or after a while.
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(undefined), 8000);
    return () => clearTimeout(t);
  }, [note]);
  const [noteFor, setNoteFor] = useState(ids);
  if (noteFor !== ids) {
    setNoteFor(ids);
    if (note && requests.length) setNote(undefined);
  }
  if (!requests.length && !note) return null;
  return (
    <div className="t-dock" role="region" aria-label="Waiting for you">
      <div className="t-dock-inner">
        {requests.map((r) => (
          <RequestCard key={r.id} r={r} runnerId={runnerId} sessionId={sessionId} root={root} onNote={setNote} />
        ))}
        {note && (
          <div className="t-inline-status" role="status">
            {note}
          </div>
        )}
      </div>
    </div>
  );
}

function RequestCard({ r, runnerId, sessionId, root, onNote }: { r: Request; runnerId: string; sessionId: string; root?: string; onNote: (n: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");

  const answer = async (a: RequestAnswer) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await rpc(runnerId, "answerRequest", { sessionId, requestId: r.id, ...a });
    } catch (e) {
      const m = (e as Error).message;
      // Someone else was first: the card is about to go; say so where it was.
      if (/already answered|no longer open/i.test(m)) onNote(m);
      else setError(m);
    } finally {
      setBusy(false);
    }
  };

  const fromChild = r.sessionId !== sessionId && r.agent !== undefined;
  const isQuestion = r.kind === "question";
  return (
    <div className="t-req" data-kind={r.kind} aria-busy={busy || undefined}>
      {fromChild && (
        <button type="button" className="t-req-from t-link" onClick={() => openSession(runnerId, r.sessionId)}>
          Subagent · {r.agent || "Untitled"} →
        </button>
      )}
      {isQuestion ? (
        <Questions r={r} busy={busy} onAnswer={(answers) => void answer({ allow: true, answers })} onDismiss={() => void answer({ allow: false })} />
      ) : (
        <>
          <div className="t-req-title">{requestTitle(r, root)}</div>
          {r.reason && <div className="t-req-reason">{r.reason}</div>}
          <ApprovalBody r={r} root={root} />
          {denying ? (
            <form
              className="t-req-reason-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (reason.trim()) void answer({ allow: false, reason: reason.trim() });
              }}
            >
              <textarea
                className="t-input"
                rows={2}
                autoFocus
                value={reason}
                placeholder="Tell Claude why, or what to do instead"
                aria-label="Reason"
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !coarse() && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (reason.trim()) void answer({ allow: false, reason: reason.trim() });
                  } else if (e.key === "Escape") setDenying(false);
                }}
              />
              <div className="t-req-actions">
                <Button label="Deny" variant="primary" isDisabled={busy || !reason.trim()} onClick={() => void answer({ allow: false, reason: reason.trim() })} />
                <Button label="Back" variant="ghost" isDisabled={busy} onClick={() => setDenying(false)} />
              </div>
            </form>
          ) : (
            <div className="t-req-actions">
              <Button label="Approve" variant="primary" isDisabled={busy} onClick={() => void answer({ allow: true })} />
              {(r.approveAs ?? []).map((m) => (
                <Button key={m.id} label={m.label} variant="secondary" isDisabled={busy} tooltip={m.description} onClick={() => void answer({ allow: true, mode: m.id })} />
              ))}
              <Button label="Deny" variant="secondary" isDisabled={busy} onClick={() => void answer({ allow: false })} />
              <Button label="Deny with reason" variant="ghost" isDisabled={busy} onClick={() => setDenying(true)} />
            </div>
          )}
        </>
      )}
      {error && <div className="t-inline-status error">{error}</div>}
    </div>
  );
}

/** What is being approved: the plan, or the tool call as its card would draw it. */
function ApprovalBody({ r, root }: { r: Request; root?: string }) {
  if (r.plan !== undefined)
    return (
      <div className="t-req-plan">
        <Markdown density="compact" contentWidth="100%">
          {r.plan || "(No plan text.)"}
        </Markdown>
      </div>
    );
  if (!r.toolKind && r.input === undefined) return null;
  const part: ToolPart = { type: "tool", id: r.toolId ?? r.id, name: r.tool ?? "Tool", kind: r.toolKind ?? "other", input: r.input, status: "running", ...(r.command ? { command: r.command } : {}), ...(r.path ? { path: r.path } : {}) };
  return (
    <div className="t-req-body">
      <ToolDetails p={part} root={root} />
      {r.inputTruncated && <span className="t-cut">Shown cut short.</span>}
    </div>
  );
}

/** A question's options as buttons, plus your own answer. One single-choice question answers on a tap. */
function Questions({ r, busy, onAnswer, onDismiss }: { r: Request; busy: boolean; onAnswer: (answers: string[]) => void; onDismiss: () => void }) {
  const qs: RequestQuestion[] = r.questions?.length ? r.questions : [{ question: r.question ?? "Claude has a question.", options: (r.options ?? []).map((label) => ({ label })) }];
  const quick = qs.length === 1 && !qs[0]!.multiSelect;
  const [picked, setPicked] = useState<string[][]>(() => qs.map(() => []));
  const [typed, setTyped] = useState<string[]>(() => qs.map(() => ""));
  const answers = qs.map((_, i) => typed[i]!.trim() || picked[i]!.join(", "));
  const complete = answers.every(Boolean);

  const pick = (i: number, label: string, multi?: boolean) => {
    if (quick) return onAnswer([label]);
    setPicked((p) => p.map((x, j) => (j !== i ? x : multi ? (x.includes(label) ? x.filter((l) => l !== label) : [...x, label]) : [label])));
    setTyped((t) => t.map((x, j) => (j === i ? "" : x)));
  };

  return (
    <form
      className="t-req-questions"
      onSubmit={(e) => {
        e.preventDefault();
        if (complete) onAnswer(answers);
      }}
    >
      {qs.map((q, i) => (
        <fieldset key={i} className="t-req-q" disabled={busy}>
          <legend className="t-req-title">
            {q.header && <span className="t-label t-req-header">{q.header}</span>}
            {q.question}
          </legend>
          <div className="t-req-options">
            {q.options.map((o) => (
              <button
                key={o.label}
                type="button"
                className="t-option"
                aria-pressed={quick ? undefined : picked[i]!.includes(o.label)}
                onClick={() => pick(i, o.label, q.multiSelect)}
              >
                <span className="t-option-label">{o.label}</span>
                {o.description && <span className="t-option-desc">{o.description}</span>}
              </button>
            ))}
          </div>
          <input
            className="t-search"
            value={typed[i]}
            placeholder={q.options.length ? "Or type your own answer" : "Your answer"}
            aria-label={`Your answer to: ${q.question}`}
            onChange={(e) => {
              const v = e.target.value;
              setTyped((t) => t.map((x, j) => (j === i ? v : x)));
            }}
          />
        </fieldset>
      ))}
      <div className="t-req-actions">
        <Button label={qs.length > 1 ? "Send answers" : "Send answer"} variant="primary" isDisabled={busy || !complete || (quick && !typed[0]!.trim())} onClick={() => complete && onAnswer(answers)} />
        <Button label="Dismiss" variant="ghost" isDisabled={busy} onClick={onDismiss} />
      </div>
    </form>
  );
}
