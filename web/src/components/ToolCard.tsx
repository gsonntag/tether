// A tool call, drawn by what it does (`kind`), whatever the harness calls it.

import { memo, type ReactNode } from "react";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { ArrowTopRightOnSquareIcon, CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { ToolPart } from "../../../shared/transcript";
import { lineDiff, withContext } from "../diff";
import { openSession } from "../route";
import { useStore, viewKey } from "../store";
import { useRowState, useSessionCtx } from "./sessionContext";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const firstLine = (s: string) => s.split("\n")[0]!;

/** A path shown relative to the session's folder when inside it. */
export function shortPath(path: string, root?: string): string {
  if (root && path.startsWith(root.replace(/\/?$/, "/"))) return path.slice(root.replace(/\/?$/, "/").length);
  return path;
}

function summary(p: ToolPart, root?: string): string {
  const i = (p.input ?? {}) as Record<string, any>;
  switch (p.kind) {
    case "shell":
      return firstLine(p.command ?? str(i.command) ?? "");
    case "edit":
    case "write":
    case "read":
      return p.path ? shortPath(p.path, root) : "";
    case "search":
      return [str(i.pattern) ?? str(i.query), str(i.path) && `in ${shortPath(i.path, root)}`, str(i.glob)].filter(Boolean).join(" ");
    case "fetch":
      return str(i.url) ?? str(i.query) ?? "";
    case "todo": {
      const todos: any[] = Array.isArray(i.todos) ? i.todos : [];
      return `${todos.length} tasks · ${todos.filter((t) => t?.status === "completed").length} done`;
    }
    case "task":
      return str(i.description) ?? "";
    default: {
      // A question or a plan reads better as itself than as JSON.
      if (Array.isArray(i.questions) && typeof i.questions[0]?.question === "string") return i.questions[0].question;
      if (typeof i.plan === "string") return firstLine(i.plan.replace(/^#+\s*/, ""));
      const json = JSON.stringify(p.input ?? {});
      return json === "{}" ? "" : json.slice(0, 200);
    }
  }
}

function StatusIcon({ status }: { status: ToolPart["status"] }) {
  if (status === "running") return <Spinner size="sm" aria-label="Running" />;
  return (
    <span className={`t-tool-status ${status}`} role="img" aria-label={status === "done" ? "Done" : "Failed"}>
      <Icon icon={status === "done" ? CheckIcon : XMarkIcon} size="sm" />
    </span>
  );
}

function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const lines = withContext(lineDiff(oldText, newText), 3);
  return (
    <div className="t-diff" role="group" aria-label="Changes">
      {lines.map((l, k) =>
        l.op === "gap" ? (
          <div key={k} className="gap">
            ⋯ {l.count} unchanged line{l.count === 1 ? "" : "s"}
          </div>
        ) : (
          <div key={k} className={l.op === "+" ? "add" : l.op === "-" ? "del" : undefined}>
            {l.op} {l.text}
          </div>
        ),
      )}
    </div>
  );
}

function Output({ text, label = "Output" }: { text?: string; label?: string }) {
  if (!text) return null;
  return (
    <>
      <span className="t-label">{label}</span>
      <pre className="t-pre">{text}</pre>
    </>
  );
}

/** A tool call's details by kind: the command, the diff, the content written, … */
export function ToolDetails({ p, root }: { p: ToolPart; root?: string }) {
  const i = (p.input ?? {}) as Record<string, any>;
  const { runnerId } = useSessionCtx();
  switch (p.kind) {
    case "shell":
      return (
        <>
          {str(i.description) && <span className="t-label">{i.description}</span>}
          <pre className="t-pre wrap t-cmd">{p.command ?? str(i.command)}</pre>
          <Output text={p.output} />
        </>
      );
    case "edit": {
      const edits: { old_string?: string; new_string?: string }[] = Array.isArray(i.edits) ? i.edits : [{ old_string: i.old_string, new_string: i.new_string }];
      return (
        <>
          {p.path && <span className="t-path">{p.path}</span>}
          {i.replace_all && <span className="t-label">Every occurrence</span>}
          {edits.map((e, k) =>
            typeof e?.old_string === "string" || typeof e?.new_string === "string" ? <Diff key={k} oldText={e.old_string ?? ""} newText={e.new_string ?? ""} /> : null,
          )}
          {p.status === "error" && <Output text={p.output} label="Error" />}
        </>
      );
    }
    case "write":
      return (
        <>
          {p.path && <span className="t-path">{p.path}</span>}
          {typeof i.content === "string" && <pre className="t-pre">{i.content}</pre>}
          {p.status === "error" && <Output text={p.output} label="Error" />}
        </>
      );
    case "todo": {
      const todos: any[] = Array.isArray(i.todos) ? i.todos : [];
      return (
        <ul className="t-todo">
          {todos.map((t, k) => (
            <li key={k} className={t?.status === "completed" ? "done" : t?.status === "in_progress" ? "active" : undefined}>
              <span aria-hidden>{t?.status === "completed" ? "☑" : t?.status === "in_progress" ? "◐" : "☐"}</span>
              <span>{t?.status === "in_progress" ? (t.activeForm ?? t.content) : t?.content}</span>
            </li>
          ))}
        </ul>
      );
    }
    case "task":
      return (
        <>
          {str(i.subagent_type) && <span className="t-label">{i.subagent_type}</span>}
          {p.childSessionId && (
            <button type="button" className="t-link" onClick={() => openSession(runnerId, p.childSessionId!)}>
              Open the subagent's transcript →
            </button>
          )}
          {str(i.prompt) && (
            <>
              <span className="t-label">Prompt</span>
              <pre className="t-pre wrap">{i.prompt}</pre>
            </>
          )}
          <Output text={p.output} label="Report" />
        </>
      );
    case "read":
    case "search":
    case "fetch":
      return (
        <>
          {p.kind === "fetch" && str(i.prompt) && <span className="t-label">{i.prompt}</span>}
          <Output text={p.output} />
        </>
      );
    default:
      return (
        <>
          <span className="t-label">Input</span>
          <pre className="t-pre">{JSON.stringify(p.input, null, 2)}</pre>
          <Output text={p.output} />
        </>
      );
  }
}

/** Open by default: diffs and todo lists (what you want to see), and failures. */
const openByDefault = (p: ToolPart) => p.kind === "edit" || p.kind === "todo" || p.status === "error";

export const ToolCard = memo(function ToolCard({ part, root, extra }: { part: ToolPart; root?: string; extra?: ReactNode }) {
  const [open, setOpen] = useRowState<boolean | undefined>(`tool:${part.id}`, undefined);
  const isOpen = open ?? openByDefault(part);
  const { runnerId, sessionId } = useSessionCtx();
  const sum = summary(part, root);
  // The call waits on your answer (the requests dock, above the composer).
  const waiting = useStore((s) => part.status === "running" && !!s.views[viewKey(runnerId, sessionId)]?.state?.requests.some((r) => r.toolId === part.id));
  // A background subagent: Claude answers the call at once ("launched") while the subagent runs on,
  // so its own session's status says more than the call's.
  const childStatus = useStore((s) => (part.childSessionId ? s.summaries[runnerId]?.sessions[part.childSessionId]?.status : undefined));
  const status = childStatus === "running" || childStatus === "waiting" ? "running" : part.status;
  return (
    <div className="t-tool" data-kind={part.kind}>
      <button type="button" className="t-tool-head" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        <span className="t-tool-name">{part.name}</span>
        <span className="t-tool-sum" title={sum}>
          {sum}
        </span>
        {waiting ? <span className="t-tool-waiting">Waiting for you</span> : <StatusIcon status={status} />}
      </button>
      {part.kind === "task" && part.childSessionId && !isOpen && (
        <div className="t-tool-body">
          <button type="button" className="t-link" onClick={() => openSession(runnerId, part.childSessionId!)}>
            Open the subagent's transcript <Icon icon={ArrowTopRightOnSquareIcon} size="xsm" />
          </button>
        </div>
      )}
      {isOpen && (
        <div className="t-tool-body">
          <ToolDetails p={part} root={root} />
          {extra}
        </div>
      )}
    </div>
  );
});
