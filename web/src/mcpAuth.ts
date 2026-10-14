// Signing in to a registry MCP server (runner/src/mcp/oauth.ts). The runner builds the
// authorization URL; this tab opens it in a new one, and the authorization server sends that tab
// back to the app server's /api/mcp-oauth/callback, which relays the code to the runner and tells
// the app's tabs on this BroadcastChannel (server/src/mcpOAuth.ts).

import type { McpAuthStart } from "./shared/protocol";
import { rpc } from "./store";

const CHANNEL = "tether-mcp-auth";

export const mcpRedirectUri = () => `${location.origin}/api/mcp-oauth/callback`;

/**
 * Starts a sign-in. The tab opens first, inside the click (popup blockers allow that), and goes to
 * the sign-in page once the runner answers. `opened` is false when the browser blocked the tab:
 * show `start.url` as a link instead.
 */
export async function authorizeMcp(id: string, client?: { clientId: string; clientSecret?: string }): Promise<{ start: McpAuthStart; opened: boolean }> {
  const tab = window.open("about:blank", "_blank");
  try {
    const start = await rpc("startMcpAuth", { id, redirectUri: mcpRedirectUri(), ...client });
    if (!("url" in start) || !tab) {
      tab?.close();
      return { start, opened: false };
    }
    // The sign-in page gets no handle on the app.
    tab.opener = null;
    tab.location.href = start.url;
    return { start, opened: true };
  } catch (e) {
    tab?.close();
    throw e;
  }
}

/** Calls `fn` with the server id whenever a sign-in finishes (in any of this app's tabs). */
export function onMcpAuthorized(fn: (id: string) => void): () => void {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const c = new BroadcastChannel(CHANNEL);
  c.onmessage = (e) => {
    if (typeof e.data?.id === "string") fn(e.data.id);
  };
  return () => c.close();
}
