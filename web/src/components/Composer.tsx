// The message box (SPEC §9). Desktop: Enter sends (steers into a running turn when the harness can,
// else queues), Tab queues, ⌘/Ctrl+Enter stops the turn and sends now, Shift+Enter is a newline,
// Esc on an empty box stops. Phones (coarse pointer): Enter is a newline and the buttons send; the
// menu beside the button has Queue and Stop and send now. Files attach by paste, drop, the paperclip
// or (phones) the camera; they upload to the runner first and go with the message.

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Icon } from "@astryxdesign/core/Icon";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { ArrowUpIcon, ChevronDownIcon, StopIcon } from "@heroicons/react/24/solid";
import { CameraIcon, ClockIcon, PaperClipIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { formatSize, isImageType, type Attachment } from "../../../shared/attachments";
import { ATTACH_MAX } from "../../../shared/limits";
import { composerMode, keyAction, primaryAction, type ComposerAction } from "../composerKeys";
import { prepare, upload } from "../upload";

export interface ComposerHandle {
  focus(): void;
}

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** A file in the box: uploading, uploaded, or failed. */
interface Pending {
  key: string;
  name: string;
  size: number;
  mimeType: string;
  preview?: string;
  progress: number;
  attachment?: Attachment;
  error?: string;
}

const drafts = new Map<string, string>();
const draftFiles = new Map<string, Pending[]>();

export type SendKind = "send" | "steer" | "queue" | "stopSend";

export const Composer = forwardRef<
  ComposerHandle,
  {
    draftKey: string;
    running: boolean;
    waiting?: boolean;
    disabled?: string;
    placeholder?: string;
    /** who works: "Claude is working…" */
    agent?: string;
    /** a message can go into the running turn */
    canSteer?: boolean;
    /** only steering (a subagent): no queue, no stop-and-send */
    steerOnly?: boolean;
    /** the harness's TUI drives: what's typed goes there */
    inTerminal?: boolean;
    /** where attachments upload (none: no attaching) */
    uploadTo?: { runnerId: string; sessionId: string };
    onSend: (kind: SendKind, text: string, attachments: Attachment[]) => Promise<void>;
    onStop: () => Promise<void>;
    status?: React.ReactNode;
  }
>(function Composer({ draftKey, running, waiting, disabled, placeholder, agent = "Claude", canSteer = false, steerOnly = false, inTerminal = false, uploadTo, onSend, onStop, status }, ref) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [files, setFilesState] = useState<Pending[]>(() => draftFiles.get(draftKey) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [drag, setDrag] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const keyRef = useRef(draftKey);
  keyRef.current = draftKey;
  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }));

  const [forKey, setForKey] = useState(draftKey);
  if (forKey !== draftKey) {
    setForKey(draftKey);
    setText(drafts.get(draftKey) ?? "");
    setFilesState(draftFiles.get(draftKey) ?? []);
    setError(undefined);
  }

  /** Files belong to the draft they were attached in, even if the view moved on meanwhile. */
  const updateFiles = (key: string, f: (list: Pending[]) => Pending[]) => {
    const next = f(draftFiles.get(key) ?? []);
    if (next.length) draftFiles.set(key, next);
    else draftFiles.delete(key);
    if (keyRef.current === key) setFilesState(next);
  };

  // Grow with the text (up to the CSS max-height).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);

  const change = (v: string) => {
    setText(v);
    if (v) drafts.set(draftKey, v);
    else drafts.delete(draftKey);
  };

  const addFiles = (list: File[]) => {
    if (!uploadTo || !list.length) return;
    const key = draftKey;
    const to = uploadTo;
    const room = ATTACH_MAX - (draftFiles.get(key)?.length ?? 0);
    if (list.length > room) setError(`At most ${ATTACH_MAX} files on one message.`);
    for (const file of list.slice(0, Math.max(0, room))) {
      const p: Pending = { key: crypto.randomUUID(), name: file.name || "file", size: file.size, mimeType: file.type, progress: 0, ...(isImageType(file.type) ? { preview: URL.createObjectURL(file) } : {}) };
      updateFiles(key, (l) => [...l, p]);
      const patch = (x: Partial<Pending>) => updateFiles(key, (l) => l.map((y) => (y.key === p.key ? { ...y, ...x } : y)));
      void (async () => {
        try {
          const prepared = await prepare(file);
          patch({ name: prepared.name, size: prepared.blob.size, mimeType: prepared.mimeType });
          const attachment = await upload(to.runnerId, to.sessionId, prepared, (progress) => patch({ progress }));
          patch({ attachment, progress: 1 });
        } catch (e) {
          patch({ error: (e as Error).message });
        }
      })();
    }
  };

  const removeFile = (k: string) =>
    updateFiles(draftKey, (l) => {
      const f = l.find((x) => x.key === k);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return l.filter((x) => x.key !== k);
    });

  const mode = steerOnly ? "steer" : composerMode({ running, canSteer, inTerminal });
  const uploading = files.some((f) => !f.attachment && !f.error);
  const ready = files.filter((f) => f.attachment).map((f) => f.attachment!);
  const hasContent = !!text.trim() || ready.length > 0;

  const go = async (kind: SendKind) => {
    const t = text.trim();
    if ((!t && !ready.length) || busy || disabled) return;
    if (uploading) return setError("Wait for the files to finish uploading.");
    if (steerOnly && kind !== "steer") kind = "steer";
    setBusy(true);
    setError(undefined);
    try {
      await onSend(kind, t, ready);
      change("");
      for (const f of draftFiles.get(draftKey) ?? []) if (f.preview) URL.revokeObjectURL(f.preview);
      updateFiles(draftKey, () => []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setError(undefined);
    try {
      await onStop();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const act = (a: ComposerAction) => {
    if (a === "stop") return void stop();
    if (a) void go(a);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const a = keyAction(e, mode, { hasText: hasContent, phone: coarse() });
    if (!a) return;
    e.preventDefault();
    act(a);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const list = [...(e.clipboardData?.files ?? [])];
    if (!list.length || !uploadTo) return;
    e.preventDefault();
    addFiles(list);
  };

  const primary = primaryAction(mode);
  const busyTurn = mode === "steer" || mode === "queue";
  const label = primary === "steer" ? "Steer" : primary === "queue" ? "Queue" : "Send";
  const tip = primary === "steer" ? "Send into the running turn (Enter)" : primary === "queue" ? "Send after this turn (Enter)" : "Send (Enter)";
  const hint =
    disabled ??
    (busyTurn
      ? waiting
        ? "Waiting for your answer above"
        : steerOnly
          ? `${agent} is working… (Enter to send it a message)`
          : mode === "steer"
            ? `${agent} is working… (Enter to steer, Tab to queue)`
            : `${agent} is working… (Enter to queue)`
      : (placeholder ?? "Message"));

  return (
    <div
      className={`t-composer${drag ? " dragging" : ""}`}
      onDragOver={(e) => {
        if (!uploadTo || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        setDrag(false);
        if (!uploadTo || !e.dataTransfer.files.length) return;
        e.preventDefault();
        addFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="t-composer-inner">
        {status}
        {error && <div className="t-inline-status error">{error}</div>}
        {files.length > 0 && (
          <div className="t-files" aria-label="Attachments">
            {files.map((f) => (
              <span key={f.key} className={`t-file${f.error ? " error" : ""}`} title={f.error ?? `${f.name} · ${formatSize(f.size)}`}>
                {f.preview ? <img src={f.preview} alt="" className="t-file-thumb" /> : <PaperClipIcon className="t-file-icon" aria-hidden />}
                <span className="t-file-name">{f.name}</span>
                <span className="t-file-meta">{f.error ? "Failed" : f.attachment ? formatSize(f.size) : `${Math.round(f.progress * 100)}%`}</span>
                <button type="button" className="t-file-x" aria-label={`Remove ${f.name}`} onClick={() => removeFile(f.key)}>
                  <XMarkIcon aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="t-composer-row">
          {uploadTo && (
            <>
              <input ref={picker} type="file" multiple hidden aria-label="Attach files" onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
              <input ref={camera} type="file" accept="image/*" capture="environment" hidden aria-label="Take a photo" onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ""))} />
              <IconButton label="Attach files" tooltip="Attach files (or paste, or drop)" variant="ghost" icon={<Icon icon={PaperClipIcon} />} isDisabled={!!disabled} onClick={() => picker.current?.click()} />
              {coarse() && <IconButton label="Take a photo" variant="ghost" icon={<Icon icon={CameraIcon} />} isDisabled={!!disabled} onClick={() => camera.current?.click()} />}
            </>
          )}
          <textarea ref={box} className="t-input" rows={1} value={text} placeholder={hint} aria-label="Message" onChange={(e) => change(e.target.value)} onKeyDown={onKeyDown} onPaste={onPaste} />
          {busyTurn && !hasContent ? (
            <IconButton label="Stop" tooltip="Stop (Esc)" variant="secondary" icon={<Icon icon={StopIcon} />} onClick={() => void stop()} />
          ) : (
            <IconButton label={label} tooltip={tip} variant="primary" icon={<Icon icon={primary === "queue" ? ClockIcon : ArrowUpIcon} />} isDisabled={!hasContent || busy || !!disabled || uploading} onClick={() => void go(primary)} />
          )}
          {busyTurn && hasContent && !steerOnly && (
            <DropdownMenu
              renderTrigger={(p) => (
                <button type="button" className="t-more-send" aria-label="More ways to send" {...p}>
                  <ChevronDownIcon aria-hidden />
                </button>
              )}
            >
              {primary !== "queue" && <DropdownMenuItem label="Queue for after this turn" description="Tab" onClick={() => void go("queue")} />}
              <DropdownMenuItem label="Stop and send now" description="⌘/Ctrl+Enter" onClick={() => void go("stopSend")} />
              <DropdownMenuItem label="Stop" description="Esc on an empty box" onClick={() => void stop()} />
            </DropdownMenu>
          )}
        </div>
      </div>
    </div>
  );
});
