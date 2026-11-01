// Secrets have one home: this runner's private credentials file. Snapshots are ephemeral and
// never part of session prefs, summaries, or the protocol. Retired keys remain redacted in memory
// until exit: an old process may still finish its turn after a credential changes.
import { randomUUID } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BillingSource, CredentialSource, CredentialStatus } from "../../shared/credentials";
import { validRates, type TokenRates } from "../../shared/costs";
import { CONFIG_DIR } from "./config";

export const DATA_DIR = process.env.TETHER_DATA_DIR || CONFIG_DIR;
export interface CredentialSnapshot {
  rates?: TokenRates;
  source: BillingSource;
  revision: string;
  key?: string;
  file?: string;
  endpoint?: string;
  deployment?: string;
}
interface Secret { key: string; revision: string; endpoint?: string; deployment?: string; rates?: TokenRates }
/** One slot per key. Version 1 had one `codex` slot, read as whichever key it held. */
interface Saved { version: 2; anthropic?: Secret; openai?: Secret; azure?: Secret }
const secrets = new Set<string>();
export function redact(text: string): string {
  for (const key of secrets) text = text.replaceAll(key, "[redacted]");
  return text;
}
export function redactValue<T>(value: T): T {
  if (!secrets.size) return value;
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v)])) as T;
  return value;
}

/** Terminal output can split a secret across any two PTY reads. Keep an ambiguous suffix until
 * the next bytes arrive, and redact before base64 encoding. Original non-secret bytes survive. */
export class SecretStream {
  private pending = Buffer.alloc(0);
  write(bytes: Uint8Array): Uint8Array {
    if (!secrets.size && !this.pending.length) return bytes;
    let data = Buffer.concat([this.pending, bytes]);
    for (const key of secrets) {
      const secret = Buffer.from(key);
      let at = data.indexOf(secret);
      while (at >= 0) {
        data = Buffer.concat([data.subarray(0, at), Buffer.from("[redacted]"), data.subarray(at + secret.length)]);
        at = data.indexOf(secret, at + 10);
      }
    }
    let keep = 0;
    for (const key of secrets) {
      const secret = Buffer.from(key);
      for (let n = Math.min(secret.length - 1, data.length); n > keep; n--) {
        if (data.subarray(data.length - n).equals(secret.subarray(0, n))) { keep = n; break; }
      }
    }
    this.pending = Buffer.from(data.subarray(data.length - keep));
    return data.subarray(0, data.length - keep);
  }
}
const validSource = (v: unknown): v is CredentialSource => v === "anthropic" || v === "openai" || v === "azure";
const validSecret = (v: any) => v && typeof v.key === "string" && v.key.length >= 16 && v.key.length <= 8192 && !/\s|[\x00-\x1f\x7f]/.test(v.key) && typeof v.revision === "string" && v.revision.length > 0;

/** The slots of a file in either shape. Anything else is refused: sending stays disabled. */
function readSlots(saved: any): { anthropic?: any; openai?: any; azure?: any } {
  if (saved?.version === 2) return { anthropic: saved.anthropic, openai: saved.openai, azure: saved.azure };
  if (saved?.version !== 1) throw new Error("invalid credentials");
  const codex = saved.codex;
  if (codex && codex.source !== "openai" && codex.source !== "azure") throw new Error("invalid credentials");
  return { anthropic: saved.anthropic, ...(codex ? { [codex.source]: codex } : {}) };
}

function azureFields(key: string, endpoint?: string, deployment?: string, rates?: TokenRates, knownKeys: Iterable<string> = secrets): Pick<Secret, "endpoint" | "deployment" | "rates"> {
  try {
    const url = new URL(endpoint ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = url.href.replace(/\/$/, "");
  } catch { throw new Error("Enter an HTTPS Azure endpoint."); }
  // Optional: a blank field means none.
  if (deployment === "") deployment = undefined;
  if (deployment !== undefined && (typeof deployment !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(deployment))) throw new Error("Enter a valid deployment name.");
  if (rates !== undefined && !validRates(rates)) throw new Error("Enter valid USD rates per million tokens.");
  // Endpoint/deployment values are public metadata and can enter argv. Reject a key pasted
  // into either field rather than leaking it through status or a native model argument.
  const tokens = [key, ...knownKeys].map((value) => value.toLowerCase());
  const metadata = [endpoint, deployment].filter((value): value is string => !!value).map((value) => { try { return decodeURIComponent(value).toLowerCase(); } catch { throw new Error("Enter a valid Azure endpoint."); } });
  if (metadata.some((value) => tokens.some((token) => value.includes(token)))) throw new Error("Endpoint and deployment must not contain a key.");
  return { endpoint, ...(deployment ? { deployment } : {}), ...(rates ? { rates: { input: rates.input, output: rates.output, cached: rates.cached } } : {}) };
}

export class CredentialStore {
  static current?: CredentialStore;
  private saved: Saved = { version: 2 };
  constructor(readonly file = join(DATA_DIR, "credentials.json")) {
    let fd: number | undefined;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error("private file required");
      const saved = JSON.parse(readFileSync(fd, "utf8"));
      const slots = readSlots(saved);
      const loaded = [slots.anthropic, slots.openai, slots.azure].filter((s) => s !== undefined);
      if (loaded.some((s) => !validSecret(s))) throw new Error("invalid credentials");
      const loadedKeys = loaded.map((s) => s.key as string);
      if (loaded.some((s) => loadedKeys.some((key) => s.revision.toLowerCase().includes(key.toLowerCase())))) throw new Error("invalid revision");
      // Loaded public metadata must satisfy the same rules as an entry from the browser.
      // Only supported fields enter snapshots/status; arbitrary file properties cannot escape.
      // A version 1 file keeps its revisions, so a private Codex process stays current, and is
      // rewritten by the next change here.
      this.saved = { version: 2,
        ...(slots.anthropic ? { anthropic: { key: slots.anthropic.key, revision: slots.anthropic.revision } } : {}),
        ...(slots.openai ? { openai: { key: slots.openai.key, revision: slots.openai.revision } } : {}),
        ...(slots.azure ? { azure: { key: slots.azure.key, revision: slots.azure.revision, ...azureFields(slots.azure.key, slots.azure.endpoint, slots.azure.deployment, slots.azure.rates, loadedKeys) } } : {}),
      };
      for (const key of loadedKeys) secrets.add(key);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw new Error("Can't read the runner's private credentials file. Sending is disabled.");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  status(): CredentialStatus {
    const slot = (s?: Secret) => s ? { set: true, last4: s.key.slice(-4), ...(s.endpoint ? { endpoint: s.endpoint } : {}), ...(s.deployment ? { deployment: s.deployment } : {}), ...(s.rates ? { rates: s.rates } : {}) } : { set: false };
    return { anthropic: slot(this.saved.anthropic), openai: slot(this.saved.openai), azure: slot(this.saved.azure) };
  }
  /** A session's source as it is now. Undefined: its key isn't set, and nothing stands in for it. */
  snapshot(source: BillingSource): CredentialSnapshot | undefined {
    if (source === "subscription") return { source, revision: "subscription", file: this.file };
    const secret = this.saved[source];
    return secret ? { ...secret, source, file: this.file } : undefined;
  }
  set(source: CredentialSource, key: string, endpoint?: string, deployment?: string, rates?: TokenRates): CredentialStatus {
    // Validation errors are fixed text. Never register short invalid input as a redaction token:
    // doing so would replace ordinary letters in every subsequent protocol frame.
    if (!validSource(source) || typeof key !== "string" || key.length < 16 || key.length > 8192 || /\s|[\x00-\x1f\x7f]/.test(key)) throw new Error("Enter a valid key.");
    const metadata = source === "azure" ? azureFields(key, endpoint, deployment, rates) : {};
    secrets.add(key);
    const secret: Secret = { key, revision: randomUUID(), ...metadata };
    this.save({ ...this.saved, [source]: secret });
    return this.status();
  }
  unset(source: CredentialSource): CredentialStatus {
    if (!validSource(source)) throw new Error("Unknown credential source.");
    const next = { ...this.saved };
    delete next[source];
    this.save(next);
    return this.status();
  }
  private save(next: Saved) {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { fchmodSync(fd, 0o600); writeFileSync(fd, JSON.stringify(next) + "\n"); } finally { closeSync(fd); }
      renameSync(temp, this.file);
      this.saved = next;
    } catch {
      try { unlinkSync(temp); } catch {}
      throw new Error("Couldn't save the runner's private credentials file.");
    }
  }
}
