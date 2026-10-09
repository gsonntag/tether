import { useState } from "react";
import type { UiRequest } from "../shared/protocol";
import { act } from "../store";

export function UiRequests({ sessionId, requests }: { sessionId: string; requests: UiRequest[] }) {
  return (
    <>
      {requests.map((r) => (
        <Card key={r.id} sessionId={sessionId} r={r} />
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

function Card({ sessionId, r }: { sessionId: string; r: UiRequest }) {
  const [value, setValue] = useState(r.kind === "input" ? (r.message ?? "") : "");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const respond = (response: Omit<Parameters<typeof act<"uiRespond">>[1]["response"], "id">) =>
    act("uiRespond", { sessionId, response: { id: r.id, ...response } });

  if (r.kind === "permission")
    return (
      <div className="perm">
        <div className="q">{r.title}</div>
        <pre>{summarizeTool(r.tool?.input)}</pre>
        <input type="text" placeholder="Optional: tell the agent why you deny it" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="btns">
          <button className="btn pri" onClick={() => respond({ allow: true })}>
            Allow
          </button>
          <button className="btn" onClick={() => respond({ allow: true, always: true })}>
            Always allow
          </button>
          <button className="btn danger" onClick={() => respond({ allow: false, value })}>
            Deny
          </button>
        </div>
      </div>
    );

  if (r.kind === "question" && r.questions)
    return (
      <div className="perm">
        <div className="q">{r.title}</div>
        {r.questions.map((q) => (
          <div key={q.question} style={{ marginTop: 10 }}>
            <div>{q.question}</div>
            <div className="opts">
              {q.options.map((o) => {
                const cur = answers[q.question]?.split(", ") ?? [];
                const on = cur.includes(o.label);
                return (
                  <button
                    key={o.label}
                    className={`opt${on ? " on" : ""}`}
                    onClick={() =>
                      setAnswers({
                        ...answers,
                        [q.question]: q.multiSelect ? (on ? cur.filter((x) => x !== o.label) : [...cur.filter(Boolean), o.label]).join(", ") : o.label,
                      })
                    }
                  >
                    {o.label}
                    {o.description && <small>{o.description}</small>}
                  </button>
                );
              })}
              <input
                type="text"
                placeholder="Other…"
                onChange={(e) => setAnswers({ ...answers, [q.question]: e.target.value })}
              />
            </div>
          </div>
        ))}
        <div className="btns">
          <button className="btn pri" disabled={r.questions.some((q) => !answers[q.question])} onClick={() => respond({ answers })}>
            Answer
          </button>
          <button className="btn" onClick={() => respond({ cancelled: true })}>
            Dismiss
          </button>
        </div>
      </div>
    );

  return (
    <div className="perm">
      <div className="q">{r.title}</div>
      {r.message && r.kind !== "input" && <div style={{ whiteSpace: "pre-wrap" }}>{r.message}</div>}
      {r.kind === "select" && (
        <div className="opts">
          {(r.options ?? []).map((o) => (
            <button key={o} className="opt" onClick={() => respond({ value: o })}>
              {o}
            </button>
          ))}
        </div>
      )}
      {r.kind === "input" && <textarea rows={3} placeholder={r.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />}
      <div className="btns">
        {r.kind === "confirm" && (
          <>
            <button className="btn pri" onClick={() => respond({ confirmed: true })}>
              Yes
            </button>
            <button className="btn" onClick={() => respond({ confirmed: false })}>
              No
            </button>
          </>
        )}
        {r.kind === "input" && (
          <button className="btn pri" onClick={() => respond({ value })}>
            Submit
          </button>
        )}
        <button className="btn" onClick={() => respond({ cancelled: true })}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
