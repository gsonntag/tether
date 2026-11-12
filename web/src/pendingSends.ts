// Optimistic sends: a message shows in the chat the moment it's sent, as a pending copy, until the
// runner's own message for it arrives (tagged with the copy's clientId, protocol send) and takes its
// place. A send that fails leaves the copy, marked, with Retry and Edit. Pure rules here; the store
// keeps the copies (store.ts sendPending).

import type { Attachment } from "../../shared/attachments";
import type { Ops } from "../../shared/protocol";
import type { LiveState, Msg } from "../../shared/transcript";

export interface PendingSend {
  clientId: string;
  text: string;
  attachments: Attachment[];
  /** Stop and send now */
  stop?: boolean;
  /** sending: on its way; sent: the runner took it, its message not seen yet; failed: not sent */
  status: "sending" | "sent" | "failed";
  error?: string;
  /** the newest message when it was sent: a message for it comes after this one */
  after?: string;
}

const textOf = (m: Msg) =>
  m.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("")
    .trim();

/**
 * The copies still to show: those whose message hasn't come. A message is theirs by its clientId;
 * failing that (a runner that doesn't tag, a message the harness reports late), a message of the
 * person's after the one newest at the send with the same text. A sent copy whose message went to
 * the queue (the terminal drives, a restart wait) leaves to the queue's own row.
 */
export function reconcile(list: PendingSend[], messages: Msg[], queue: { text: string }[] = []): PendingSend[] {
  if (!list.length) return list;
  const tagged = new Set(messages.flatMap((m) => (m.clientId ? [m.clientId] : [])));
  const used = new Set<string>();
  const out = list.filter((p) => {
    if (tagged.has(p.clientId)) return false;
    if (p.status === "failed") return true;
    const from = p.after ? messages.findIndex((m) => m.id === p.after) + 1 : 0;
    // The newest message at the send isn't loaded any more (a reconnect's fresh page): no guessing.
    if (p.after && from === 0) return true;
    const want = p.text.trim();
    const mine = messages.slice(from).find((m) => m.role === "user" && !m.origin && !m.clientId && !used.has(m.id) && textOf(m) === want);
    if (mine) {
      used.add(mine.id);
      return false;
    }
    return !(p.status === "sent" && queue.some((q) => q.text.trim() === want));
  });
  return out.length === list.length ? list : out;
}

/** What shows below the chat while a session gets going: a spinner with words, or why it couldn't. */
export type StartRow = { kind: "spinner"; text: string } | { kind: "error"; text: string };

/**
 * The row under the chat while the harness starts (state.starting), or while a send is on its way
 * before the runner has said anything; the error of a send that failed. None: the usual rows.
 */
export function startRow(o: { state: LiveState; pending: PendingSend[]; label: string; hasMessages: boolean }): StartRow | undefined {
  const last = o.pending.at(-1);
  if (last?.status === "failed") return { kind: "error", text: last.error ?? "Not sent." };
  if (o.state.starting === "resume") return { kind: "spinner", text: "Resuming session…" };
  if (o.state.starting === "start") return { kind: "spinner", text: `Starting ${o.label} session…` };
  if (last?.status === "sending" && o.state.status === "idle") {
    if (o.state.mode === "stored") return { kind: "spinner", text: o.hasMessages ? "Resuming session…" : `Starting ${o.label} session…` };
    return { kind: "spinner", text: "Sending…" };
  }
  return undefined;
}

/** Where the copies live and how a send goes (the store's; tests pass their own). */
export interface PendingIO {
  list(k: string): PendingSend[] | undefined;
  update(k: string, f: (list: PendingSend[]) => PendingSend[]): void;
  /** the newest message the chat has */
  newest(k: string): string | undefined;
  /** drops the copies whose message has come (reconcile) */
  settle(k: string): void;
  send(runnerId: string, args: Ops["send"]["args"]): Promise<unknown>;
  /** a failure with no copy left to mark: the chat says it */
  failed(runnerId: string, sessionId: string, error: string): void;
  key(runnerId: string, sessionId: string): string;
}

/** How long a sent copy waits for its message before it goes anyway (a reply Tether gave itself, a late report). */
export const SENT_GRACE_MS = 8000;

/** Sends a message optimistically: its copy shows at once, `sending`; the answer marks it sent or failed. Returns its clientId. */
export function pendingSender(io: PendingIO) {
  return (runnerId: string, sessionId: string, text: string, attachments: Attachment[] = [], o: { stop?: boolean; clientId?: string } = {}): string => {
    const k = io.key(runnerId, sessionId);
    const clientId = o.clientId ?? crypto.randomUUID();
    const after = io.newest(k);
    const copy: PendingSend = { clientId, text, attachments, status: "sending", ...(o.stop ? { stop: true } : {}), ...(after ? { after } : {}) };
    // A retry takes its copy's place (same clientId): never a second bubble.
    io.update(k, (l) => [...l.filter((p) => p.clientId !== clientId), copy]);
    const patch = (x: Partial<PendingSend>) => io.update(k, (l) => l.map((p) => (p.clientId === clientId ? { ...p, ...x } : p)));
    const mine = () => !!io.list(k)?.some((p) => p.clientId === clientId);
    void io.send(runnerId, { sessionId, text, clientId, ...(attachments.length ? { attachments } : {}), ...(o.stop ? { stop: true } : {}) }).then(
      () => {
        if (!mine()) return;
        patch({ status: "sent" });
        io.settle(k);
        setTimeout(() => io.update(k, (l) => l.filter((p) => !(p.clientId === clientId && p.status === "sent"))), SENT_GRACE_MS);
      },
      (e) => {
        const error = (e as Error)?.message ?? String(e);
        // Its message came after all (the turn failed after it went out): the chat says why.
        if (mine()) patch({ status: "failed", error });
        else io.failed(runnerId, sessionId, error);
      },
    );
    return clientId;
  };
}
