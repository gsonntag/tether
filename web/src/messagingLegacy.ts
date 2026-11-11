// A runner from before messaging connectors has only iMessage's own ops (textingStatus, setTexting,
// textingTest). Settings → Messaging shows it as one iMessage section, the same as a new runner's.

import type { ConnectorStatus, MessagingStatus, TextingStatus } from "../../shared/protocol";

export const LEGACY_IMESSAGE = "imessage";

/** Whether an rpc failed because the runner doesn't have `op` at all (runner/src/core/ops.ts), not for any other reason. */
export function isUnknownOp(e: unknown, op: string): boolean {
  const m = (e as Error | undefined)?.message ?? "";
  return m.includes(`doesn't know "${op}"`);
}

/** An old runner's texting status, as the one connector it has. */
export function legacyMessaging(s: TextingStatus): MessagingStatus {
  const env = (on: boolean) => (on ? " · from runner.env" : "");
  const c: ConnectorStatus = {
    id: LEGACY_IMESSAGE,
    label: "iMessage",
    enabled: s.enabled,
    configured: s.keysSet && !!s.phoneLast4,
    connected: s.connected,
    ...(s.lastError ? { lastError: s.lastError } : {}),
    about: "Phone must be added and verified on Photon dashboard",
    forms: [
      { key: "phone", label: "Your phone", status: s.phoneLast4 ? `••••${s.phoneLast4}${env(s.fromEnv.phone)}` : "Not set", fromEnv: s.fromEnv.phone, inputs: [{ key: "phone", placeholder: "+13105551234", type: "tel" }] },
      {
        key: "project",
        label: "Photon project",
        status: s.keysSet ? `Set${env(s.fromEnv.keys)}` : "Not set",
        fromEnv: s.fromEnv.keys,
        inputs: [{ key: "projectId", placeholder: "Project ID" }, { key: "projectSecret", placeholder: "Project secret", secret: true }],
        unset: s.keysSet && !s.fromEnv.keys,
      },
    ],
  };
  return { connectors: [c] };
}

/** setConnector's arguments as setTexting's. */
export function legacySet(a: { enabled?: boolean; values?: Record<string, string> }): { enabled?: boolean; phone?: string; projectId?: string; projectSecret?: string } {
  const v = a.values ?? {};
  return {
    ...(typeof a.enabled === "boolean" ? { enabled: a.enabled } : {}),
    ...(typeof v.phone === "string" ? { phone: v.phone } : {}),
    ...(typeof v.projectId === "string" ? { projectId: v.projectId } : {}),
    ...(typeof v.projectSecret === "string" ? { projectSecret: v.projectSecret } : {}),
  };
}
