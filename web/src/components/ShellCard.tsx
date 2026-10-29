// A `!` command you ran from the composer (SPEC §9 Shell commands): the command, its output as it
// streams, how it ended, and where the output is on its way to the agent:
//   Running ──► Waiting in queue ──► Sent to Claude        (or Not sent, with why)

import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StopIcon } from "@heroicons/react/24/outline";
import { formatSize } from "../../../shared/attachments";
import { endedHow } from "../../../shared/shellRun";
import { agentOf, type LiveState, type Msg, type ToolPart } from "../../../shared/transcript";
import { rpc } from "../connection";
import { useStore, viewKey } from "../store";
import { useSessionCtx } from "./sessionContext";

const HELD: Record<NonNullable<LiveState["queueHeldBy"]>, string> = {
  terminal: "until you're back from the terminal",
  stopped: "paused after Stop",
  failed: "paused after a failed turn",
  restart: "paused after a restart",
};

export function ShellCard({ msg }: { msg: Msg }) {
  const { runnerId, sessionId } = useSessionCtx();
  const run = msg.shell!;
  const tool = msg.parts[0] as ToolPart | undefined;
  const agent = agentOf(sessionId);
  const [error, setError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  // Where its queued message stands: held (and why), or behind a running turn.
  const held = useStore((s) => {
    const st = s.views[viewKey(runnerId, sessionId)]?.state;
    return run.state === "queued" && st?.queueHeld ? (st.queueHeldBy ? HELD[st.queueHeldBy] : "paused") : undefined;
  });
  const busy = useStore((s) => run.state === "queued" && (s.views[viewKey(runnerId, sessionId)]?.state?.status ?? "idle") !== "idle");
  const out = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const output = tool?.output ?? "";
  // Follows the newest output while running, unless you scrolled up in it.
  useLayoutEffect(() => {
    const el = out.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [output]);

  const stop = async () => {
    setError(undefined);
    setStopping(true);
    try {
      await rpc(runnerId, "stopShell", { sessionId, id: msg.id });
    } catch (e) {
      setError((e as Error).message);
      setStopping(false);
    }
  };

  const running = run.state === "running";
  const ended = running ? undefined : endedHow(run);
  const failed = !running && (run.stopped || !!run.signal || (run.exitCode ?? 0) !== 0);
  const where =
    run.state === "running"
      ? `Running · the output goes to ${agent} when it finishes`
      : run.state === "queued"
        ? `Waiting in queue · goes to ${agent} ${held ? `(${held})` : busy ? "when this turn ends" : "next"}`
        : run.state === "sent"
          ? `Sent to ${agent}`
          : `Not sent${run.why ? `: ${run.why}` : ""}`;

  return (
    <div className="t-msg shellrun" data-state={run.state}>
      <div className={`t-shellcard${failed ? " failed" : ""}`}>
        <div className="t-shellcard-head">
          <span className="t-shellcard-who">You ran</span>
          <code className="t-shellcard-cmd" title={tool?.command}>
            <span aria-hidden>$ </span>
            {tool?.command}
          </code>
          {running ? (
            <>
              <Spinner size="sm" aria-label="Running" />
              <Button label={stopping ? "Stopping…" : "Stop"} size="sm" variant="secondary" icon={<Icon icon={StopIcon} size="sm" />} isDisabled={stopping} onClick={() => void stop()} />
            </>
          ) : (
            <span className={`t-shellcard-exit${failed ? " failed" : ""}`}>{ended === "stopped" ? "Stopped" : ended}</span>
          )}
        </div>
        {output ? (
          <pre
            ref={out}
            className="t-pre t-shellcard-out"
            tabIndex={0}
            aria-label="Output"
            onScroll={(e) => {
              const el = e.currentTarget;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            }}
          >
            {output}
          </pre>
        ) : (
          !running && <div className="t-shellcard-none">No output.</div>
        )}
        {(run.omitted ?? 0) > 0 && !running && (
          <div className="t-shellcard-note">
            {formatSize(run.bytes ?? 0)} of output; the middle {formatSize(run.omitted!)} isn't kept. {agent} gets the start and the end.
          </div>
        )}
        {error && <div className="t-inline-status error">{error}</div>}
        <div className={`t-shellcard-where ${run.state}`} role="status">
          {run.state === "queued" && <Spinner size="sm" />}
          {where}
        </div>
      </div>
    </div>
  );
}

/** The message that carried a command's output to the agent, where the agent got it: one quiet line. */
export function ShellSent({ msg }: { msg: Msg }) {
  const { sessionId } = useSessionCtx();
  const text = msg.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  return (
    <details className="t-msg shellsent">
      <summary>
        Output of <code>$ {msg.origin?.name}</code> sent to {agentOf(sessionId)}
      </summary>
      <pre className="t-pre">{text}</pre>
    </details>
  );
}
