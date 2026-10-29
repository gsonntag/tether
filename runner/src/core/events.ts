// The session core's events (SPEC §3). Modules subscribe to these; the core never imports a module.

import type { Msg, Request, SessionMode, ToolPart } from "../../../shared/transcript";

export interface CoreEvents {
  turnStarted: { sessionId: string };
  turnEnded: { sessionId: string; error?: string };
  message: { sessionId: string; msg: Msg };
  toolCall: { sessionId: string; msgId: string; tool: ToolPart };
  requestOpened: { request: Request };
  requestClosed: { sessionId: string; requestId: string; outcome: "allowed" | "denied" | "answered" | "cancelled" };
  modeChanged: { sessionId: string; from: SessionMode; to: SessionMode };
  error: { sessionId?: string; message: string };
  /** the last browser watching these sessions went away */
  unwatched: { sessionIds: string[] };
}

export type CoreEventName = keyof CoreEvents;
