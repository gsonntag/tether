// The message box. Desktop: Enter sends, Shift+Enter is a newline, Esc on an empty box stops the
// turn. Phones (coarse pointer): Enter is a newline and the button sends. While a turn runs the
// button stops it (P1 has no steer or queue), and the text stays for later.

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Icon } from "@astryxdesign/core/Icon";
import { ArrowUpIcon, StopIcon } from "@heroicons/react/24/solid";

export interface ComposerHandle {
  focus(): void;
}

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

const drafts = new Map<string, string>();

export const Composer = forwardRef<
  ComposerHandle,
  { draftKey: string; running: boolean; waiting?: boolean; disabled?: string; onSend: (text: string) => Promise<void>; onStop: () => Promise<void>; status?: React.ReactNode }
>(function Composer({ draftKey, running, waiting, disabled, onSend, onStop, status }, ref) {
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }));

  const [forKey, setForKey] = useState(draftKey);
  if (forKey !== draftKey) {
    setForKey(draftKey);
    setText(drafts.get(draftKey) ?? "");
    setError(undefined);
  }

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

  const send = async () => {
    const t = text.trim();
    if (!t || running || busy || disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSend(t);
      change("");
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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey && !coarse()) {
      e.preventDefault();
      void send();
    } else if (e.key === "Escape" && running && !text) {
      e.preventDefault();
      void stop();
    }
  };

  return (
    <div className="t-composer">
      <div className="t-composer-inner">
        {status}
        {error && <div className="t-inline-status error">{error}</div>}
        <div className="t-composer-row">
          <textarea
            ref={box}
            className="t-input"
            rows={1}
            value={text}
            placeholder={disabled ?? (running ? (waiting ? "Waiting for your answer above" : "Claude is working… (Esc to stop)") : "Message")}
            aria-label="Message"
            onChange={(e) => change(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {running ? (
            <IconButton label="Stop" tooltip="Stop (Esc)" variant="secondary" icon={<Icon icon={StopIcon} />} onClick={() => void stop()} />
          ) : (
            <IconButton label="Send" tooltip="Send (Enter)" variant="primary" icon={<Icon icon={ArrowUpIcon} />} isDisabled={!text.trim() || busy || !!disabled} onClick={() => void send()} />
          )}
        </div>
      </div>
    </div>
  );
});
