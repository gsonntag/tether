// One transcript message: a user prompt, an assistant reply (markdown, thinking, tool cards), or a
// quiet notice. Parts cut short to travel get "Show all", which loads them whole (fullPart).

import { memo, useMemo } from "react";
import { imageSize } from "../imageSize";
import { Icon } from "@astryxdesign/core/Icon";
import { Markdown } from "./Markdown";
import { hardBreaks } from "../breaks";
import { checked } from "../parts";
import { ErrorBoundary } from "./ErrorBoundary";
import { ExclamationTriangleIcon, InformationCircleIcon, PaperClipIcon } from "@heroicons/react/24/outline";
import { formatSize, isImageType, splitAttachments, type Attachment } from "../../../shared/attachments";
import type { Msg, Part } from "../../../shared/transcript";
import { undefang } from "../../../shared/fromTether";
import { useFullParts, useRowState, useSessionCtx } from "./sessionContext";
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


/** Folded thinking; opened stays opened when the row is unmounted and mounted again. */
function Thinking({ text, streaming, cut, rowKey }: { text: string; streaming: boolean; cut?: React.ReactNode; rowKey: string }) {
  const [open, setOpen] = useRowState(`think:${rowKey}`, false);
  return (
    <details className="t-think" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{streaming && !text ? "Thinking…" : "Thinking"}</summary>
      <div className="t-think-body">{text}</div>
      {cut}
    </details>
  );
}

/** One part, inside its own error boundary: a part that can't render shows a note, not a blank app. */
function PartView(props: { part: Part; streaming: boolean; cut?: React.ReactNode; root?: string; rowKey: string }) {
  const part = checked(props.part);
  if (!part) return null;
  return (
    <ErrorBoundary resetKey={part}>
      <PartBody {...props} part={part} />
    </ErrorBoundary>
  );
}

function PartBody({ part, streaming, cut, root, rowKey }: { part: Part; streaming: boolean; cut?: React.ReactNode; root?: string; rowKey: string }) {
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
      return <Thinking text={part.text} streaming={streaming} cut={cut} rowKey={rowKey} />;
    case "image":
      return part.data ? <Attached mimeType={part.mimeType} data={part.data} /> : <span className="t-cut">An image too large to show here. {cut}</span>;
    case "tool":
      return <ToolCard part={part} root={root} extra={cut} />;
  }
}

/** An attached image, its box reserved from its header before it decodes (imageSize.ts). */
function Attached({ mimeType, data }: { mimeType: string; data: string }) {
  const size = useMemo(() => imageSize(mimeType, data), [mimeType, data]);
  // as wide as it is, the column allows, and its height cap allows (--t-img-max), at its ratio
  const style = size ? { aspectRatio: `${size.w} / ${size.h}`, width: `min(100%, ${size.w}px, calc(var(--t-img-max) * ${size.w / size.h}))`, height: "auto" } : undefined;
  return <img className="t-img" alt="Attached image" src={`data:${mimeType};base64,${data}`} style={style} />;
}

export const Message = memo(function Message({ msg }: { msg: Msg }) {
  const { projectPath, runnerId } = useSessionCtx();
  const { full, loading, error, load } = useFullParts(msg.id, msg.parts);
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
      msg.origin.kind === "peer" ? "From another session" : msg.origin.kind === "channel" ? "From a channel" : msg.origin.kind === "tether" ? (/^Tether: /.test(msg.parts[0]?.type === "text" ? msg.parts[0].text : "") ? "Tether" : "From Tether, on your behalf") : "From the system";
    return (
      <div className="t-msg from">
        <div className="t-from-head">
          {who}
          {msg.origin.name ? ` · ${msg.origin.name}` : ""}
        </div>
        <div className="t-parts">
          {parts.map((p, i) => (
            <PartView key={i} rowKey={`${msg.id}:${i}`} part={p} streaming={false} cut={cutFor(i)} root={projectPath} />
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
            <PartView key={i} rowKey={`${msg.id}:${i}`} part={p} streaming={false} cut={cutFor(i)} />
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
          <PartView key={i} rowKey={`${msg.id}:${i}`} part={p} streaming={!!msg.streaming && i === parts.length - 1} cut={cutFor(i)} root={projectPath} />
        ))}
        {missing.length > 0 && <CutNote loading={missing.some((i) => loading.includes(i))} error={error} onLoad={() => load(missing)} />}
        {msg.error && <div className="t-msg-error">{msg.error}</div>}
      </div>
    </div>
  );
});
