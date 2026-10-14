// The MCP OAuth callback's pieces (the route is in index.ts). The runner holds the PKCE verifier
// and the sign-in's state; this server only reads which runner a state belongs to and relays the
// authorization server's answer to it (runner/src/mcp/oauth.ts makes states as
// `<base64url runner id>.<random>`).

import { randomBytes } from "node:crypto";

/** The runner id a state names, or undefined. */
export function runnerOfState(state: string): string | undefined {
  const i = state.indexOf(".");
  if (i <= 0 || i > 512) return undefined;
  try {
    return Buffer.from(state.slice(0, i), "base64url").toString("utf8") || undefined;
  } catch {
    return undefined;
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The page the sign-in tab lands on. On success it tells the app's other tabs (they refresh the
 * server's status) and closes itself when the app opened it.
 */
export function callbackPage(status: number, title: string, text: string, serverId?: string): Response {
  const nonce = randomBytes(16).toString("base64");
  const script = serverId
    ? `<script nonce="${nonce}">history.replaceState(null,"",location.pathname);try{const c=new BroadcastChannel("tether-mcp-auth");c.postMessage({id:${JSON.stringify(serverId).replace(/</g, "\\u003c")}});c.close()}catch{}setTimeout(()=>window.close(),1500)</script>`
    : `<script nonce="${nonce}">history.replaceState(null,"",location.pathname)</script>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Tether</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#222}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#555}@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}p{color:#aaa}}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p></main>${script}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}
