// One transcript message: a user prompt, an assistant reply (markdown, thinking, tool cards), or a
// quiet notice. Parts cut short to travel get "Show all", which loads them whole (fullPart).

import { memo } from "react";
import { Icon } from "@astryxdesign/core/Icon";
import { Markdown } from "@astryxdesign/core/Markdown";
import { hardBreaks } from "../breaks";
import { ExclamationTriangleIcon, InformationCircleIcon } from "@heroicons/react/24/outline";
import type { Msg, Part } from "../../../shared/transcript";
import { useFullParts, useSessionCtx } from "./sessionContext";
import { ToolCard } from "./ToolCard";

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

function PartView({ part, streaming, cut, root }: { part: Part; streaming: boolean; cut?: React.ReactNode; root?: string }) {
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
  const { projectPath } = useSessionCtx();
  const { full, loading, error, load } = useFullParts(msg.id);
  if (msg.role === "notice") {
    const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    return (
      <div className={`t-msg notice ${msg.level ?? "info"}`} role={msg.level === "error" ? "alert" : undefined}>
        <Icon icon={msg.level && msg.level !== "info" ? ExclamationTriangleIcon : InformationCircleIcon} size="sm" />
        <span className="t-notice-text">{text}</span>
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

  if (msg.role === "user") {
    return (
      <div className="t-msg user">
        {parts.map((p, i) =>
          p.type === "text" ? (
            <div key={i} className="t-bubble">
              {p.text}
              {cutFor(i)}
            </div>
          ) : (
            <PartView key={i} part={p} streaming={false} cut={cutFor(i)} />
          ),
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
