import { diffLines } from "diff";
import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Msg, Part } from "../shared/protocol";
import { act, selectSession } from "../store";

type ToolPart = Extract<Part, { type: "tool" }>;

const BRIEF_PREFIX = "You are taking over an in-progress coding session";

export const Transcript = memo(function Transcript({ messages, running, amendable }: { messages: Msg[]; running: boolean; amendable?: string[] }) {
  return (
    <>
      {messages.map((m, i) => (
        <Message key={m.id} m={m} last={running && i === messages.length - 1} amendable={!!amendable?.includes(m.id)} />
      ))}
    </>
  );
});

/** A steer the agent already has: it can't be taken back, so an edit goes in as a correction. */
function AmendableUser({ m, text }: { m: Msg; text: string }) {
  const [draft, setDraft] = useState<string>();
  const save = async () => {
    if (draft !== undefined && draft.trim() && draft.trim() !== text.trim()) await act("amendSteer", { sessionId, msgId: m.id, text: draft });
    setDraft(undefined);
  };
  if (draft === undefined)
    return (
      <div className="user">
        {text}
        <button className="amend" title="The agent already has this message. Editing sends the change as a correction." onClick={() => setDraft(text)}>
          ✎ Edit
        </button>
      </div>
    );
  return (
    <div className="user editing">
      <textarea
        autoFocus
        value={draft}
        rows={Math.min(10, draft.split("\n").length + 1)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setDraft(undefined);
          if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), save());
        }}
      />
      <div className="hint">The agent already has the original, so this goes in as a correction.</div>
      <div className="btns">
        <button className="btn" onClick={() => setDraft(undefined)}>
          Cancel
        </button>
        <button className="btn pri" onClick={save}>
          Send correction
        </button>
      </div>
    </div>
  );
}

const Message = memo(function Message({ m, last, amendable }: { m: Msg; last: boolean; amendable?: boolean }) {
  if (m.role === "user") {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    if (text.startsWith(BRIEF_PREFIX))
      return (
        <details className="brief">
          <summary>Handoff brief given to this agent (conversation + repository state)</summary>
          <div className="body">{text}</div>
        </details>
      );
    const tools = m.parts.filter((p): p is ToolPart => p.type === "tool");
    return (
      <>
        {text.trim() && amendable && <AmendableUser m={m} text={text} />}
        {text.trim() && !amendable && (
          <div className="user">
            {text}
            {m.parts.map((p, i) => (p.type === "image" ? <img key={i} src={`data:${p.mimeType};base64,${p.data}`} alt="" /> : null))}
          </div>
        )}
        {tools.map((t) => (
          <Tool key={t.id} t={t} />
        ))}
      </>
    );
  }
  if (m.role === "notice") {
    const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    if (m.title) {
      const icon = m.source === "agent" ? "↩" : m.source === "task" ? "⚙" : m.source === "compaction" ? "⇣" : m.source === "channel" ? "✉" : "›";
      if (!text.trim())
        return (
          <div className={`event ${m.source ?? ""}`}>
            <span>{icon}</span>
            <span>{m.title}</span>
          </div>
        );
      return (
        <details className={`event-card ${m.source ?? ""}`} open={!m.collapsed || undefined}>
          <summary>
            <span>{icon}</span> {m.title}
          </summary>
          <div className="md body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        </details>
      );
    }
    return (
      <div className={`notice ${m.level ?? "info"}`}>
        <span>{m.level === "error" ? "✕" : m.level === "warning" ? "⚠" : "ℹ"}</span>
        <div className="md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      </div>
    );
  }
  return (
    <div className="asst">
      {m.parts.map((p, i) => {
        const tail = last && i === m.parts.length - 1 && m.streaming;
        switch (p.type) {
          case "text":
            return p.text ? (
              <div key={i} className="md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.text}</ReactMarkdown>
                {tail && <span className="cursor" />}
              </div>
            ) : tail ? (
              <span key={i} className="cursor" />
            ) : null;
          case "thinking":
            return p.text.trim() ? <Thinking key={i} text={p.text} live={!!tail} /> : null;
          case "tool":
            return <Tool key={p.id ?? i} t={p} />;
          case "image":
            return <img key={i} src={`data:${p.mimeType};base64,${p.data}`} alt="" style={{ maxWidth: "100%" }} />;
        }
      })}
      {m.error && m.error !== "aborted" && <div className="err">{m.error}</div>}
      {m.error === "aborted" && <div className="hint">Stopped.</div>}
      {last && m.streaming && m.parts.length === 0 && <span className="cursor" />}
    </div>
  );
});

function Thinking({ text, live }: { text: string; live: boolean }) {
  return (
    <details className="think" open={live || undefined}>
      <summary>▸ {live ? "Thinking…" : "Thought"}</summary>
      <div className="body">{text}</div>
    </details>
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

/** Normalizes the edit inputs of Claude Code (old_string/new_string) and pi (edits[]). */
function edits(input: any): { oldText: string; newText: string }[] {
  if (Array.isArray(input?.edits)) return input.edits.map((e: any) => ({ oldText: e.oldText ?? e.old_string ?? "", newText: e.newText ?? e.new_string ?? "" }));
  if (input?.old_string !== undefined || input?.new_string !== undefined) return [{ oldText: input.old_string ?? "", newText: input.new_string ?? "" }];
  if (input?.oldText !== undefined) return [{ oldText: input.oldText, newText: input.newText ?? "" }];
  return [];
}

function Diff({ pairs }: { pairs: { oldText: string; newText: string }[] }) {
  return (
    <div className="diff">
      {pairs.map((e, k) => (
        <div key={k} style={{ padding: 0 }}>
          {k > 0 && <div className="sep">⋯</div>}
          {diffLines(e.oldText, e.newText).flatMap((part, j) =>
            part.value
              .replace(/\n$/, "")
              .split("\n")
              .map((line, n) => (
                <div key={`${j}-${n}`} className={part.added ? "add" : part.removed ? "del" : "ctx"}>
                  {(part.added ? "+ " : part.removed ? "- " : "  ") + line}
                </div>
              )),
          )}
        </div>
      ))}
    </div>
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
    <span className="bad">⛔</span>
  ) : t.status === "running" ? (
    <span className="spin" />
  ) : t.status === "error" ? (
    <span className="bad">✕</span>
  ) : (
    <span className="ok">✓</span>
  );
  const lines = t.output ? t.output.trimEnd().split("\n").length : 0;

  return (
    <div className={`tool${blocked ? " blocked" : ""}`}>
      <button className="hd" onClick={() => setOpen(!open)}>
        {icon}
        <span className="nm">{name}</span>
        <span className="arg mono">{arg}</span>
        <span className="grow" />
        {stat ? (
          <span style={{ whiteSpace: "nowrap", flex: "none" }}>
            <span className="ok">+{stat.add}</span>
            {stat.del > 0 && <span className="bad"> −{stat.del}</span>}
          </span>
        ) : lines > 1 ? (
          <span style={{ whiteSpace: "nowrap", flex: "none" }}>{lines} lines</span>
        ) : null}
        {t.guard && !blocked && t.guard.by !== "mode" && (
          <span className={`gv ${t.guard.by}`} title={t.guard.reason}>
            {t.guard.by === "rule" ? "auto" : t.guard.by === "judge" ? "judged ✓" : "you ✓"}
          </span>
        )}
      </button>
      {blocked && (
        <div className="blockbar">
          <span className="grow">
            Blocked by {t.guard!.by === "user" ? "you" : t.guard!.by === "judge" ? "the safety judge" : "the safety rules"}: {(t.guard!.reason ?? "").replace(/^Blocked:\s*/, "")}
          </span>
          {t.guard!.by !== "user" && (
            <button className="btn" onClick={() => act("approveBlocked", { sessionId, toolId: t.id })}>
              Approve &amp; retry
            </button>
          )}
        </div>
      )}
      {open && (
        <>
          {pairs.length > 0 && <Diff pairs={pairs} />}
          {isTodo && (
            <div className="todo">
              {input.todos.map((td: any, i: number) => (
                <div key={i} className={td.status === "completed" ? "done" : ""}>
                  <span>{td.status === "completed" ? "☑" : td.status === "in_progress" ? "◐" : "☐"}</span>
                  <span>{td.content ?? td.activeForm}</span>
                </div>
              ))}
            </div>
          )}
          {!isShell && !pairs.length && !isTodo && Object.keys(input).length > 0 && <pre>{str(input)}</pre>}
          {t.output && (!pairs.length || t.status === "error") && <pre>{t.output.length > 20000 ? t.output.slice(0, 20000) + "\n…" : t.output}</pre>}
        </>
      )}
    </div>
  );
}

export function LinkBanner({ from, to }: { from?: { sessionId: string; reason: string }; to?: { sessionId: string; reason: string } }) {
  return (
    <>
      {from && (
        <div className="link-banner">
          ↖ Continued from{" "}
          <button className="btn" onClick={() => selectSession(from.sessionId)}>
            {from.sessionId.split(":")[0]} session
          </button>
          <span className="hint">{from.reason}</span>
        </div>
      )}
      {to && (
        <div className="notice warning">
          <span>↘</span>
          <div>
            This conversation continues in another session ({to.reason}).{" "}
            <button className="link" onClick={() => selectSession(to.sessionId)}>
              Open it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
