// One transcript message: a user prompt, an assistant reply (markdown, thinking, tool cards), or a
// quiet notice. Parts cut short to travel get "Show all", which loads them whole (fullPart).

import { memo } from "react";
import { Icon } from "@astryxdesign/core/Icon";
import { Markdown } from "./Markdown";
import { hardBreaks } from "../breaks";
import { checked } from "../parts";
import { ErrorBoundary } from "./ErrorBoundary";
import { ExclamationTriangleIcon, InformationCircleIcon, PaperClipIcon } from "@heroicons/react/24/outline";
import { formatSize, isImageType, splitAttachments, type Attachment } from "../../../shared/attachments";
import type { Msg, Part } from "../../../shared/transcript";
import { undefang } from "../../../shared/fromTether";
import { useFullParts, useSessionCtx } from "./sessionContext";
import { ShellCard, ShellSent } from "./ShellCard";
import { ToolCard } from "./ToolCard";
import { openSession } from "../route";

const isCut = (p: Part) => (p.type === "tool" ? !!p.truncated || !!p.inputTruncated : !!p.truncated);

function CutNote({ loading, onLoad, error }: { loading: boolean; onLoad: () => void; error?: string }) {
  return (
    <span className="t-cut">
      {loading ? "Loading…" : error ? error : "Cut short to load faster."}
      {!loading && (
        <button type="button" className="t-link" onClick={onLoad}>
          Show all
        </button>
      )}
    </span>
  );
}


/** One part, inside its own error boundary: a part that can't render shows a note, not a blank app. */
function PartView(props: { part: Part; streaming: boolean; cut?: React.ReactNode; root?: string }) {
  const part = checked(props.part);
  if (!part) return null;
  return (
    <ErrorBoundary resetKey={part}>
      <PartBody {...props} part={part} />
    </ErrorBoundary>
  );
}

function PartBody({ part, streaming, cut, root }: { part: Part; streaming: boolean; cut?: React.ReactNode; root?: string }) {
  switch (part.type) {
    case "text":
      if (!part.text && !streaming) return null;
      return (
        <div className="t-text">
          <Markdown density="compact" isStreaming={streaming} contentWidth="100%">
            {hardBreaks(part.text)}
          </Markdown>
          {cut}
        </div>
      );
    case "thinking":
      // Stored thinking is empty (Claude doesn't keep it): nothing to show then.
      if (!part.text && !streaming) return null;
      return (
        <details className="t-think">
          <summary>{streaming && !part.text ? "Thinking…" : "Thinking"}</summary>
          <div className="t-think-body">{part.text}</div>
          {cut}
        </details>
      );
    case "image":
      return part.data ? <img className="t-img" alt="Attached image" src={`data:${part.mimeType};base64,${part.data}`} /> : <span className="t-cut">An image too large to show here. {cut}</span>;
    case "tool":
      return <ToolCard part={part} root={root} extra={cut} />;
  }
}

export const Message = memo(function Message({ msg }: { msg: Msg }) {
  const { projectPath, runnerId } = useSessionCtx();
  const { full, loading, error, load } = useFullParts(msg.id);
  if (msg.role === "notice") {
    const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    return (
      <div className={`t-msg notice ${msg.level ?? "info"}`} role={msg.level === "error" ? "alert" : undefined}>
        <Icon icon={msg.level && msg.level !== "info" ? ExclamationTriangleIcon : InformationCircleIcon} size="sm" />
        <span className="t-notice-text">
          {text}
          {msg.link && (
            <>
              {" "}
              <button type="button" className="t-link" onClick={() => openSession(runnerId, msg.link!.sessionId)}>
                {msg.link.label}
              </button>
            </>
          )}
        </span>
      </div>
    );
  }
  const omitted = msg.partsOmitted ?? 0;
  const parts = msg.parts.map((p, i) => full[i] ?? p);
  for (let i = 0; i < omitted; i++) {
    const p = full[msg.parts.length + i];
    if (p) parts.push(p);
  }
  const missing = Array.from({ length: omitted }, (_, i) => msg.parts.length + i).filter((i) => !full[i]);
  const cutFor = (i: number) => (isCut(parts[i]!) && !full[i] ? <CutNote loading={loading.includes(i)} error={error} onLoad={() => load([i])} /> : undefined);

  // A `!` command you ran, and the message that carried its output to the agent.
  if (msg.shell) return <ShellCard msg={msg} />;
  if (msg.role === "user" && msg.origin?.kind === "shell") return <ShellSent msg={msg} />;
  if (msg.role === "user" && msg.origin) {
    // Not something you typed: another session's message, a channel, a report.
    const who =
      msg.origin.kind === "peer" ? "From another session" : msg.origin.kind === "channel" ? "From a channel" : msg.origin.kind === "tether" ? "From Tether, on your behalf" : "From the system";
    return (
      <div className="t-msg from">
        <div className="t-from-head">
          {who}
          {msg.origin.name ? ` · ${msg.origin.name}` : ""}
        </div>
        <div className="t-parts">
          {parts.map((p, i) => (
            <PartView key={i} part={p} streaming={false} cut={cutFor(i)} root={projectPath} />
          ))}
        </div>
      </div>
    );
  }
  if (msg.role === "user") {
    // Attachments are listed at the end of the text (shared/attachments.ts): shown as chips. Images
    // the harness took as images show as images; the chips are for the other files.
    const files: Attachment[] = [];
    const hasImages = parts.some((p) => p.type === "image");
    const shownParts = parts.map((p) => {
      if (p.type !== "text") return p;
      // What a person typed that began like one of Tether's own messages carries an invisible mark
      // (shared/fromTether.ts defang): never shown, never copied.
      const split = splitAttachments(undefang(p.text));
      files.push(...split.files);
      return { ...p, text: split.text };
    });
    const chips = files.filter((f) => !(hasImages && isImageType(f.mimeType)));
    return (
      <div className="t-msg user">
        {shownParts.map((p, i) =>
          p.type === "text" ? (
            p.text ? (
              <div key={i} className="t-bubble">
                {p.text}
                {cutFor(i)}
              </div>
            ) : null
          ) : (
            <PartView key={i} part={p} streaming={false} cut={cutFor(i)} />
          ),
        )}
        {chips.length > 0 && (
          <div className="t-msg-files">
            {chips.map((f) => (
              <span key={f.path} className="t-file" title={f.path}>
                <PaperClipIcon className="t-file-icon" aria-hidden />
                <span className="t-file-name">{f.name}</span>
                <span className="t-file-meta">{formatSize(f.size)}</span>
              </span>
            ))}
          </div>
        )}
        {msg.relay && (
          <div className={`t-relay ${msg.relay}`}>
            {msg.relay === "sending" ? "Sending via the main agent…" : msg.relay === "delivered" ? "Sent via the main agent" : "Not delivered: the main agent didn't pass it on."}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="t-msg assistant">
      <div className="t-parts">
        {parts.map((p, i) => (
          <PartView key={i} part={p} streaming={!!msg.streaming && i === parts.length - 1} cut={cutFor(i)} root={projectPath} />
        ))}
        {missing.length > 0 && <CutNote loading={missing.some((i) => loading.includes(i))} error={error} onLoad={() => load(missing)} />}
        {msg.error && <div className="t-msg-error">{msg.error}</div>}
      </div>
    </div>
  );
});
