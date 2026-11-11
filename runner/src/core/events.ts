// The session core's events (SPEC §3). Modules subscribe to these; the core never imports a module.

import type { PushKeys } from "../../../shared/protocol";
import type { Msg, Request, RunStatus, SessionMode, ToolPart } from "../../../shared/transcript";

/** How a request closed: decided, stopped with its turn, or answered in the harness's own UI. */
export type RequestOutcome = "allowed" | "denied" | "answered" | "cancelled" | "elsewhere";

export interface CoreEvents {
  /** `from`: the status before ("waiting": the turn goes on after the person answered it, not a new one) */
  turnStarted: { sessionId: string; from?: RunStatus };
  /** `stopped`: a person stopped it. `recovering`: an intermediate failure, with no final notification. */
  turnEnded: { sessionId: string; error?: string; stopped?: boolean; recovering?: boolean };
  message: { sessionId: string; msg: Msg };
  /** a waiting message left the queue: it went out to the harness, or was cancelled */
  queueGone: { sessionId: string; msgId: string; how: "sent" | "cancelled"; text: string };
  toolCall: { sessionId: string; msgId: string; tool: ToolPart };
  requestOpened: { request: Request };
  /** `source`: who decided ("person", or a policy step's source such as "judge" or "rule") */
  requestClosed: { sessionId: string; requestId: string; outcome: RequestOutcome; source?: string; reason?: string };
  modeChanged: { sessionId: string; from: SessionMode; to: SessionMode };
  /**
   * The harness waits on the person outside Tether's requests (in terminal mode, Claude's TUI
   * asks for permission or a choice, SPEC §8): "needs you", for notifications and Home.
   */
  attention: { sessionId: string; message?: string };
  error: { sessionId?: string; message: string };
  /** the last browser watching these sessions went away */
  unwatched: { sessionIds: string[] };
  /** the app accepted this runner (after every reconnect); `push`: the app's VAPID keys */
  connected: { push?: PushKeys };
  /** which devices look at which sessions right now (presence, from the app) */
  viewers: { sessions: Record<string, string[]> };
  /** the connection to the app is gone; the server forgot every subscription with it */
  disconnected: {};
}

export type CoreEventName = keyof CoreEvents;
