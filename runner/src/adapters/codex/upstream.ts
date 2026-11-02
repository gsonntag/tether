// The way a key session's requests reach its provider: the private host's gateway uses these, and
// so does Settings' Test, so a test goes where a session's request would.
import type { CredentialSnapshot } from "../../credentials";
import type { ApiSource } from "./sources";

/** `/responses` under the endpoint, as Codex's provider asks for it (base URL + path). */
export const upstreamUrl = (endpoint: string, path: string) => endpoint.replace(/\/$/, "") + path;

/** The provider's own auth header and nothing of the caller's. */
export function upstreamHeaders(source: ApiSource, key: string, from?: HeadersInit): Headers {
  const headers = new Headers(from);
  for (const h of ["host", "authorization", "api-key", "content-length", "connection"]) headers.delete(h);
  if (source === "azure") headers.set("api-key", key);
  else headers.set("authorization", `Bearer ${key}`);
  return headers;
}

/** What a refused request says. Never the provider's body: it can repeat part of a key. */
export function upstreamFailure(source: ApiSource, status: number): string {
  const name = source === "azure" ? "Azure" : "OpenAI API key";
  return status === 401 || status === 403 ? `${name} rejected the credential. Check ${source === "azure" ? "Settings, Azure" : "Credentials"}.` : status === 429 ? `${name} quota or rate limit reached. The session stopped.` : `${name} request failed (HTTP ${status}). Check the configured source and connection.`;
}

const CODE = /^[A-Za-z0-9._:-]{1,64}$/;
const TEST_MS = 30_000;
/**
 * One tiny request to a saved deployment: a few tokens of real Azure usage, run only when asked.
 * The answer is a few words: OK with the model Azure says runs it, or what went wrong. No response
 * text, header or key leaves here.
 */
export async function testAzure(c?: CredentialSnapshot): Promise<{ ok: boolean; text: string }> {
  if (!c?.key || !c.endpoint || !c.deployment) return { ok: false, text: !c ? "Save it, with the key, first" : "Not saved" };
  let res: Response;
  try {
    res = await fetch(upstreamUrl(c.endpoint, "/responses"), {
      method: "POST",
      headers: upstreamHeaders("azure", c.key, { "content-type": "application/json" }),
      body: JSON.stringify({ model: c.deployment, input: "Reply OK.", max_output_tokens: 16, stream: false, store: false }),
      redirect: "error",
      signal: AbortSignal.timeout(TEST_MS),
    });
  } catch (e) {
    return { ok: false, text: (e as Error)?.name === "TimeoutError" ? "No answer in 30 s" : "Can't reach the endpoint" };
  }
  let json: any;
  try { json = await res.json(); } catch {}
  const clean = (v: unknown) => (typeof v === "string" && CODE.test(v) && !v.includes(c.key!) ? v : undefined);
  if (res.ok) {
    const model = clean(json?.model);
    return { ok: true, text: model ? `OK · ${model}` : "OK" };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, text: "Key rejected" };
  if (res.status === 404) return { ok: false, text: "Deployment not found" };
  if (res.status === 429) return { ok: false, text: "Rate limited" };
  const code = clean(json?.error?.code);
  return { ok: false, text: `HTTP ${res.status}${code ? ` · ${code}` : ""}` };
}
