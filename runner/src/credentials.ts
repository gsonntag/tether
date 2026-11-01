// Secrets have one home: this runner's private credentials file. Snapshots are ephemeral and
// never part of session prefs, summaries, or the protocol. Retired keys remain redacted in memory
// until exit: an old process may still finish its turn after a credential changes.
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AZURE_MAX_DEPLOYMENTS, AZURE_NAME, azureEndpoint, type AzureDeployment, type BillingSource, type CredentialSource, type CredentialStatus } from "../../shared/credentials";
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
  /** Azure: the session's deployment, which is the model its requests name */
  deployment?: string;
}
interface Secret { key: string; revision: string }
/** Public metadata, kept apart from Azure's key, so either can be set or changed first. */
export interface AzureSettings { endpoint?: string; deployments: AzureDeployment[] }
/**
 * One slot per key, and Azure's settings. Version 2 kept Azure's endpoint, one deployment and its
 * rates in the key's slot; version 1 had one `codex` slot. Both still read, and the next change
 * writes version 3.
 */
interface Saved { version: 3; anthropic?: Secret; openai?: Secret; azure?: Secret; azureSettings?: AzureSettings }
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

/** The slots of a file in any shape, and Azure's settings as they were. Anything else is refused: sending stays disabled. */
function readSlots(saved: any): { anthropic?: any; openai?: any; azure?: any; settings?: any } {
  if (saved?.version === 3) return { anthropic: saved.anthropic, openai: saved.openai, azure: saved.azure, settings: saved.azureSettings };
  let azure: any;
  let rest: { anthropic?: any; openai?: any };
  if (saved?.version === 2) { azure = saved.azure; rest = { anthropic: saved.anthropic, openai: saved.openai }; }
  else if (saved?.version === 1) {
    const codex = saved.codex;
    if (codex && codex.source !== "openai" && codex.source !== "azure") throw new Error("invalid credentials");
    azure = codex?.source === "azure" ? codex : undefined;
    rest = { anthropic: saved.anthropic, ...(codex?.source === "openai" ? { openai: codex } : {}) };
  } else throw new Error("invalid credentials");
  // The one deployment that was there becomes a list of one, with its rates. Rates without a
  // deployment priced whatever model was picked; there's no deployment left to keep them for.
  const settings = azure ? { endpoint: azure.endpoint, deployments: azure.deployment === undefined || azure.deployment === "" ? [] : [{ name: azure.deployment, ...(azure.rates !== undefined ? { rates: azure.rates } : {}) }] } : undefined;
  return { ...rest, ...(azure ? { azure: { key: azure.key, revision: azure.revision } } : {}), ...(settings ? { settings } : {}) };
}

const MODEL = /^[A-Za-z0-9._:-]{1,128}$/;
/**
 * Azure's settings, checked as from the browser. `endpoint` is a resource name or a URL when
 * `typed`, else (from the file) the endpoint as it was saved. They are public metadata and can
 * enter argv and status, so a key pasted into any of them is refused.
 */
function azureSettings(raw: any, knownKeys: Iterable<string>, typed = false): AzureSettings {
  if (!raw || typeof raw !== "object") throw new Error("Enter valid Azure settings.");
  let endpoint: string | undefined;
  if (raw.endpoint !== undefined && raw.endpoint !== "") {
    if (typeof raw.endpoint !== "string") throw new Error("Enter an Azure resource name or HTTPS endpoint.");
    endpoint = typed ? azureEndpoint(raw.endpoint) : savedEndpoint(raw.endpoint);
    if (!endpoint) throw new Error("Enter an Azure resource name or HTTPS endpoint.");
  }
  const list = raw.deployments ?? [];
  if (!Array.isArray(list) || list.length > AZURE_MAX_DEPLOYMENTS) throw new Error("Enter valid Azure deployments.");
  const names = new Set<string>();
  const deployments = list.map((d: any): AzureDeployment => {
    const name = typeof d?.name === "string" ? d.name.trim() : "";
    if (!AZURE_NAME.test(name)) throw new Error("Enter a valid deployment name.");
    if (names.has(name)) throw new Error(`Deployment ${name} is listed twice.`);
    names.add(name);
    const model = typeof d?.model === "string" ? d.model.trim() : undefined;
    if (model && !MODEL.test(model)) throw new Error("Enter a valid model id.");
    if (d?.rates !== undefined && d.rates !== null && !validRates(d.rates)) throw new Error("Enter valid USD rates per million tokens.");
    return { name, ...(model ? { model } : {}), ...(d?.rates ? { rates: { input: d.rates.input, output: d.rates.output, cached: d.rates.cached } } : {}) };
  });
  const settings: AzureSettings = { ...(endpoint ? { endpoint } : {}), deployments };
  if (carriesKey(settings, knownKeys)) throw new Error("Azure settings must not contain a key.");
  return settings;
}
function savedEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
    return url.href.replace(/\/$/, "");
  } catch { return undefined; }
}
function carriesKey(settings: AzureSettings | undefined, keys: Iterable<string>): boolean {
  if (!settings) return false;
  const tokens = [...keys].map((key) => key.toLowerCase());
  const metadata = [settings.endpoint, ...settings.deployments.flatMap((d) => [d.name, d.model])].filter((v): v is string => !!v).map((value) => { try { return decodeURIComponent(value).toLowerCase(); } catch { return value.toLowerCase(); } });
  return metadata.some((value) => tokens.some((token) => value.includes(token)));
}
/** What makes an Azure process current, besides its key: a change restarts an idle session's process. */
const azureDigest = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);

export class CredentialStore {
  static current?: CredentialStore;
  private saved: Saved = { version: 3 };
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
      // An older file keeps its revisions, so a private Codex process stays current, and is
      // rewritten by the next change here.
      const settings = slots.settings !== undefined ? azureSettings(slots.settings, loadedKeys) : undefined;
      this.saved = { version: 3,
        ...(slots.anthropic ? { anthropic: { key: slots.anthropic.key, revision: slots.anthropic.revision } } : {}),
        ...(slots.openai ? { openai: { key: slots.openai.key, revision: slots.openai.revision } } : {}),
        ...(slots.azure ? { azure: { key: slots.azure.key, revision: slots.azure.revision } } : {}),
        ...(settings ? { azureSettings: settings } : {}),
      };
      for (const key of loadedKeys) secrets.add(key);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw new Error("Can't read the runner's private credentials file. Sending is disabled.");
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  status(): CredentialStatus {
    const slot = (s?: Secret) => s ? { set: true, last4: s.key.slice(-4) } : { set: false };
    const settings = this.saved.azureSettings;
    return { anthropic: slot(this.saved.anthropic), openai: slot(this.saved.openai), azure: { ...slot(this.saved.azure), ...(settings?.endpoint ? { endpoint: settings.endpoint } : {}), deployments: settings?.deployments ?? [] } };
  }
  /** Azure's settings as saved: the endpoint and deployments, whether or not its key is set. */
  azure(): AzureSettings {
    return this.saved.azureSettings ?? { deployments: [] };
  }
  /**
   * A session's source as it is now. Undefined: its key isn't set, and nothing stands in for it. On
   * Azure, also no endpoint, or the session's deployment isn't listed any more. Without a
   * deployment, Azure's snapshot has none of a deployment's fields.
   */
  snapshot(source: BillingSource, deployment?: string): CredentialSnapshot | undefined {
    if (source === "subscription") return { source, revision: "subscription", file: this.file };
    const secret = this.saved[source];
    if (!secret) return undefined;
    if (source !== "azure") return { ...secret, source, file: this.file };
    const endpoint = this.saved.azureSettings?.endpoint;
    if (!endpoint) return undefined;
    if (deployment === undefined) return { key: secret.key, source, file: this.file, endpoint, revision: `${secret.revision}:${azureDigest(endpoint)}` };
    const d = this.saved.azureSettings!.deployments.find((x) => x.name === deployment);
    if (!d) return undefined;
    return { key: secret.key, source, file: this.file, endpoint, deployment: d.name, ...(d.rates ? { rates: d.rates } : {}), revision: `${secret.revision}:${azureDigest(endpoint, d.name, d.rates ?? null)}` };
  }
  /** A key. Azure's settings come separately (`setAzure`); a browser from before sends them along. */
  set(source: CredentialSource, key: string, endpoint?: string, deployment?: string, rates?: TokenRates): CredentialStatus {
    // Validation errors are fixed text. Never register short invalid input as a redaction token:
    // doing so would replace ordinary letters in every subsequent protocol frame.
    if (!validSource(source) || typeof key !== "string" || key.length < 16 || key.length > 8192 || /\s|[\x00-\x1f\x7f]/.test(key)) throw new Error("Enter a valid key.");
    let settings = this.saved.azureSettings;
    if (source === "azure" && endpoint !== undefined) {
      const kept = (settings?.deployments ?? []).filter((d) => d.name !== deployment);
      settings = azureSettings({ endpoint, deployments: deployment ? [{ name: deployment, ...(rates ? { rates } : {}) }, ...kept] : kept }, [key, ...secrets], true);
    }
    if (carriesKey(settings, [key])) throw new Error("Azure settings must not contain a key.");
    secrets.add(key);
    this.save({ ...this.saved, [source]: { key, revision: randomUUID() }, ...(settings ? { azureSettings: settings } : {}) });
    return this.status();
  }
  /** Azure's endpoint (from a resource name or a URL) and its deployments, all at once. Its key is untouched. */
  setAzure(input: { endpoint?: unknown; deployments?: unknown }): CredentialStatus {
    const settings = azureSettings(input, secrets, true);
    this.save({ ...this.saved, azureSettings: settings });
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
