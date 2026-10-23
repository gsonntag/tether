// AWS Bedrock credentials (bedrock.ts): stored keys never leave the runner, profiles come from the
// AWS CLI (faked here), only the chosen credential's AWS variables reach a process, models read
// "Opus 5.5 · Bedrock" in Claude Code and pi, and Bedrock's throttling / quota errors are a rate
// limit / a quota for fallback.

import { resetHome } from "../testenv";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChainEntry, HarnessId } from "../../../web/src/shared/protocol";
import { config } from "../config";
import { bedrockFault, onBedrock, providerOf } from "../fallback";
import { claudeFault, piFault } from "../faults";
import { LiveSession, type HandoffOpts } from "../session";
import { accountOf, AWS_REDIRECT_VARS, AWS_SECRET_VARS, bedrockPlugin, cliError, modelChoices, setBedrockIo, testResult, type CliResult } from "./bedrock";
import { credentialAction, credentialModels, launchFor, listCredentials, register, testCredential, unregister } from "./registry";
import * as store from "./store";

const API_KEY = "ABSKQmVkcm9ja0FQSUtleS1TECRET-bedrock-key-9876";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYSECRETKEY1";

/** The AWS CLI as the plugin sees it: every call recorded (args + the credential's env), answers per command. */
let calls: { args: string[]; env: Record<string, string> }[] = [];
let answers: Record<string, CliResult> = {};
const ok = (out: string): CliResult => ({ ok: true, out, err: "" });
const fail = (err: string): CliResult => ({ ok: false, out: "", err });
let fetches: { url: string; init?: RequestInit }[] = [];
let fetchAnswer: () => Response = () => new Response("{}", { status: 200 });

function fakeAws() {
  answers = {
    "configure list-profiles": ok("default\n"),
    "configure get region --profile default": ok("us-east-1\n"),
    "configure get login_session --profile default": ok("arn:aws:iam::123456789012:root\n"),
    "configure export-credentials --profile default --format process": ok(JSON.stringify({ Version: 1, AccessKeyId: "ASIAXXXX", SecretAccessKey: "profile-secret-never-shown", SessionToken: "tok", Expiration: new Date(Date.now() + 40 * 60_000).toISOString() })),
  };
  setBedrockIo({
    cli: async (args, env) => {
      calls.push({ args, env });
      const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
      return key ? answers[key]! : fail("aws: [ERROR]: not faked: " + args.slice(0, 2).join(" "));
    },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      return fetchAnswer();
    },
  });
}

beforeEach(() => {
  resetHome();
  store.resetCredentialStore();
  unregister();
  register(bedrockPlugin);
  calls = [];
  fetches = [];
  fakeAws();
  config().exhausted = {};
});
afterEach(() => {
  unregister();
  config().exhausted = {};
});

describe("adding and listing", () => {
  test("an API key and an access key are stored write-only; views show labels, region and last 4 at most", async () => {
    await credentialAction("bedrock", "add", { kind: "apiKey", name: "work", region: "us-west-2", apiKey: API_KEY });
    await credentialAction("bedrock", "add", { kind: "awsKeys", name: "iam", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: SECRET });
    const list = await listCredentials();
    expect(JSON.stringify(list)).not.toContain(API_KEY);
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(JSON.stringify(list)).not.toContain("profile-secret-never-shown");
    const by = Object.fromEntries(list.credentials.map((c) => [c.id, c]));
    expect(by["bedrock:work"]).toMatchObject({ kind: "apiKey", label: "AWS Bedrock · work · us-west-2", region: "us-west-2", last4: "9876", source: "tether", state: "ok" });
    expect(by["bedrock:iam"]).toMatchObject({ kind: "awsKeys", label: "AWS Bedrock · iam · us-east-1", account: "AKIA…MPLE", last4: "KEY1" });
    expect(store.get("bedrock:work")?.values).toEqual({ AWS_BEARER_TOKEN_BEDROCK: API_KEY });
  });

  test("bad input is refused", async () => {
    await expect(credentialAction("bedrock", "add", { kind: "apiKey", name: "x", region: "mars-1", apiKey: API_KEY })).rejects.toThrow("isn't an AWS region");
    await expect(credentialAction("bedrock", "add", { kind: "apiKey", name: "aws.default", apiKey: API_KEY })).rejects.toThrow("short name");
    await expect(credentialAction("bedrock", "add", { kind: "awsKeys", name: "x", accessKeyId: "nope", secretAccessKey: SECRET })).rejects.toThrow("access key id");
    await expect(credentialAction("bedrock", "add", { kind: "apiKey", name: "x", apiKey: "short" })).rejects.toThrow("whole Bedrock API key");
  });

  test("the machine's AWS profiles show up on their own, with the aws login's account, root warning and expiry", async () => {
    const list = await listCredentials();
    const p = list.credentials.find((c) => c.id === "bedrock:aws.default")!;
    expect(p).toMatchObject({ kind: "awsProfile", label: "AWS Bedrock · default · us-east-1", account: "123456789012 (root)", region: "us-east-1", source: "cli", state: "ok" });
    expect(p.stateNote).toContain("renew in 40 min");
    expect(p.stateNote).toContain("root user");
    expect(p.actions).toContain("signIn");
  });

  test("an expired aws login reads as expired, with Sign in again", async () => {
    answers["configure export-credentials --profile default --format process"] = fail("\naws: [ERROR]: Your session has expired. Please reauthenticate using 'aws login'.\n");
    const p = (await listCredentials()).credentials.find((c) => c.id === "bedrock:aws.default")!;
    expect(p.state).toBe("expired");
    expect(p.stateNote).toContain("sign in again");
    expect(p.actions).toContain("signIn");
  });
});

describe("models", () => {
  test("addModel makes one tiny Converse call; models then read “… · Bedrock” in Claude Code and pi", async () => {
    answers["bedrock-runtime converse"] = ok('{"output":{}}');
    await credentialAction("bedrock:aws.default", "addModel", { model: "us.anthropic.claude-opus-5-5" });
    const converse = calls.find((c) => c.args[0] === "bedrock-runtime")!;
    expect(converse.args).toContain("--model-id");
    expect(converse.args).toContain('{"maxTokens":1}');
    expect(converse.env).toEqual({ AWS_PROFILE: "default" });
    await credentialAction("bedrock:aws.default", "addModel", { model: "amazon-bedrock/us.amazon.nova-pro-v1:0" });
    await listCredentials();
    expect(await credentialModels("claude-code")).toEqual([{ id: "us.anthropic.claude-opus-5-5", credential: "bedrock:aws.default", credentialLabel: "Bedrock" }]);
    expect((await credentialModels("pi")).map((m) => m.id)).toEqual(["amazon-bedrock/us.anthropic.claude-opus-5-5", "amazon-bedrock/us.amazon.nova-pro-v1:0"]);
    await credentialAction("bedrock:aws.default", "removeModel", { model: "us.amazon.nova-pro-v1:0" });
    expect(store.get("bedrock:aws.default")?.meta?.models).toEqual(["us.anthropic.claude-opus-5-5"]);
    expect(store.get("bedrock:aws.default")?.values).toEqual({}); // a profile's record has no values
  });

  test("a model the account can't use isn't added", async () => {
    answers["bedrock-runtime converse"] = fail("\nAn error occurred (AccessDeniedException) when calling the Converse operation: You don't have access to the model with the specified model ID.\n");
    await expect(credentialAction("bedrock:aws.default", "addModel", { model: "us.anthropic.claude-opus-5-5" })).rejects.toThrow("No access to this model");
    expect(store.get("bedrock:aws.default")).toBeUndefined();
  });

  test("an API key lists and tests over the REST API with a bearer token", async () => {
    await credentialAction("bedrock", "add", { kind: "apiKey", name: "work", region: "us-west-2", apiKey: API_KEY });
    fetchAnswer = () => new Response(JSON.stringify({ inferenceProfileSummaries: [{ inferenceProfileId: "us.anthropic.claude-opus-5-5", inferenceProfileName: "US Opus 5.5", status: "ACTIVE" }], modelSummaries: [] }));
    const r = (await credentialAction("bedrock:work", "listModels", {})) as any;
    expect(r.models).toEqual([{ id: "us.anthropic.claude-opus-5-5", name: "US Opus 5.5", kind: "Inference profile" }]);
    expect(fetches[0]!.url).toStartWith("https://bedrock.us-west-2.amazonaws.com/");
    expect((fetches[0]!.init!.headers as any).authorization).toBe(`Bearer ${API_KEY}`);
    fetchAnswer = () => new Response(JSON.stringify({ message: "Too many requests, please wait before trying again." }), { status: 429, headers: { "x-amzn-errortype": "ThrottlingException:http://internal.amazon.com/coral/com.amazon.bedrock/" } });
    await store.update("bedrock:work", { meta: { models: ["us.anthropic.claude-opus-5-5"] } });
    const t = await testCredential("bedrock:work");
    expect(t).toMatchObject({ ok: true, result: "rate limited" });
    expect(fetches.at(-1)!.url).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-opus-5-5/converse");
    expect(calls.filter((c) => c.args[0] !== "configure")).toEqual([]); // the key never went to the CLI
  });

  test("model choices: active inference profiles first (Anthropic first), then on-demand models", () => {
    const c = modelChoices(
      [
        { inferenceProfileId: "us.amazon.nova-pro-v1:0", status: "ACTIVE" },
        { inferenceProfileId: "us.anthropic.claude-opus-5-5", inferenceProfileName: "US Opus", status: "ACTIVE" },
        { inferenceProfileId: "us.old", status: "LEGACY" },
      ],
      [
        { modelId: "anthropic.claude-x", providerName: "Anthropic", modelName: "X", inferenceTypesSupported: ["INFERENCE_PROFILE"] },
        { modelId: "meta.llama", providerName: "Meta", modelName: "Llama", inferenceTypesSupported: ["ON_DEMAND"] },
      ],
    );
    expect(c.map((m) => m.id)).toEqual(["us.anthropic.claude-opus-5-5", "us.amazon.nova-pro-v1:0", "meta.llama"]);
  });
});

describe("process env", () => {
  test("only the chosen credential's AWS variables reach the process; Claude Code is told to use Bedrock", async () => {
    await credentialAction("bedrock", "add", { kind: "apiKey", name: "work", region: "us-west-2", apiKey: API_KEY });
    await credentialAction("bedrock", "add", { kind: "awsKeys", name: "iam", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: SECRET });
    const cc = await launchFor({ harness: "claude-code", model: "us.anthropic.claude-opus-5-5", credential: "bedrock:work" });
    expect(cc.env).toMatchObject({
      AWS_PROFILE: "",
      AWS_DEFAULT_PROFILE: "",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_SESSION_TOKEN: "",
      AWS_BEARER_TOKEN_BEDROCK: API_KEY,
      AWS_REGION: "us-west-2",
      AWS_DEFAULT_REGION: "us-west-2",
      CLAUDE_CODE_USE_BEDROCK: "1",
    });
    expect(cc.args).toEqual([]);
    const pi = await launchFor({ harness: "pi", model: "amazon-bedrock/us.anthropic.claude-opus-5-5", credential: "bedrock:iam" });
    expect(pi.env).toMatchObject({ AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", AWS_SECRET_ACCESS_KEY: SECRET, AWS_BEARER_TOKEN_BEDROCK: "", AWS_PROFILE: "", AWS_REGION: "us-east-1" });
    expect(pi.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    const prof = await launchFor({ harness: "pi", model: "amazon-bedrock/x", credential: "bedrock:aws.default" });
    expect(prof.env).toMatchObject({ AWS_PROFILE: "default", AWS_ACCESS_KEY_ID: "", AWS_REGION: "us-east-1" });
    expect(Object.values(prof.env).join()).not.toContain("profile-secret-never-shown");
    for (const k of AWS_SECRET_VARS) expect(k in prof.env).toBe(true);
  });
});

describe("words", () => {
  test("AWS CLI errors come down to one line; tests name what went wrong", () => {
    expect(cliError("\nAn error occurred (ValidationException) when calling the Converse operation: The provided model identifier is invalid.\n")).toBe("ValidationException: The provided model identifier is invalid.");
    expect(cliError("\naws: [ERROR]: Your session has expired. Please reauthenticate using 'aws login'.\n")).toBe("Your session has expired. Please reauthenticate using 'aws login'.");
    expect(testResult("UnrecognizedClientException: The security token included in the request is invalid.").result).toBe("invalid");
    expect(testResult("ServiceQuotaExceededException: Your request exceeds the service quota").result).toBe("quota");
    expect(testResult("ValidationException: Invocation of model ID x with on-demand throughput isn't supported.").result).toBe("wrong model");
    expect(accountOf("arn:aws:sts::123456789012:assumed-role/Admin/gavin")).toBe("123456789012 (gavin)");
  });
});

describe("review fixes", () => {
  test("SSO / MFA / role / credential_process profiles aren't checked in the background", async () => {
    answers["configure get sso_session --profile default"] = ok("corp\n");
    const p = (await listCredentials()).credentials.find((c) => c.id === "bedrock:aws.default")!;
    expect(p.state).toBe("unknown");
    expect(p.stateNote).toContain("sso_session");
    expect(calls.some((c) => c.args.includes("export-credentials"))).toBe(false);
  });

  test("a status check holds for minutes, not one list", async () => {
    await listCredentials();
    await listCredentials();
    expect(calls.filter((c) => c.args.includes("export-credentials")).length).toBe(1);
  });

  test("adding a key again under the same name keeps its models", async () => {
    await credentialAction("bedrock", "add", { kind: "apiKey", name: "work", apiKey: API_KEY });
    await store.update("bedrock:work", { meta: { models: ["us.anthropic.claude-opus-5-5"] } });
    await credentialAction("bedrock", "add", { kind: "awsKeys", name: "work", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: SECRET });
    expect(store.get("bedrock:work")?.meta?.models).toEqual(["us.anthropic.claude-opus-5-5"]);
    expect(store.get("bedrock:work")?.values.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
  });

  test("a profile id must name a profile the AWS CLI lists", async () => {
    await expect(credentialAction("bedrock:aws.someone-else", "addModel", { model: "us.anthropic.claude-opus-5-5" })).rejects.toThrow("no AWS profile");
    await expect(testCredential("bedrock:aws.nope")).rejects.toThrow("no AWS profile");
    expect(calls.some((c) => c.args[0] === "bedrock-runtime")).toBe(false);
  });

  test("Claude Code's background model is the credential's Haiku: an added one, else the region's listed one", async () => {
    await credentialAction("bedrock", "add", { kind: "apiKey", name: "work", apiKey: API_KEY });
    let env = (await launchFor({ harness: "claude-code", model: "us.anthropic.claude-opus-5-5", credential: "bedrock:work" })).env;
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
    fetchAnswer = () => new Response(JSON.stringify({ inferenceProfileSummaries: [{ inferenceProfileId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", status: "ACTIVE" }], modelSummaries: [] }));
    await credentialAction("bedrock:work", "listModels", {});
    env = (await launchFor({ harness: "claude-code", model: "us.anthropic.claude-opus-5-5", credential: "bedrock:work" })).env;
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    await store.update("bedrock:work", { meta: { ...store.get("bedrock:work")!.meta, models: ["us.anthropic.claude-haiku-5"] } });
    env = (await launchFor({ harness: "claude-code", model: "us.anthropic.claude-opus-5-5", credential: "bedrock:work" })).env;
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("us.anthropic.claude-haiku-5");
    const pi = (await launchFor({ harness: "pi", model: "amazon-bedrock/x", credential: "bedrock:work" })).env;
    expect(pi.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined();
  });

  test("pass-through variables that could redirect auth or calls are blanked, in sessions and in aws calls", async () => {
    const saved = { ...process.env };
    process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = "https://evil.example";
    process.env.AWS_CONFIG_FILE = "/tmp/other-config";
    process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = "1";
    process.env.AWS_ENDPOINT_URL_SOMETHING_NEW = "https://x.example";
    try {
      await credentialAction("bedrock", "add", { kind: "apiKey", name: "work", apiKey: API_KEY });
      const env = (await launchFor({ harness: "claude-code", model: "us.anthropic.claude-opus-5-5", credential: "bedrock:work" })).env;
      for (const k of [...AWS_REDIRECT_VARS, "AWS_ENDPOINT_URL_SOMETHING_NEW"]) expect(env[k]).toBe("");
      const { cliEnv } = await import("./bedrock");
      const c = cliEnv({ AWS_PROFILE: "default" });
      expect(c.AWS_ENDPOINT_URL_BEDROCK_RUNTIME).toBeUndefined();
      expect(c.AWS_CONFIG_FILE).toBeUndefined();
      expect(c.AWS_PROFILE).toBe("default");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    }
  });

  test("pi and Claude Code on the same Bedrock credential and model share one quota key; models don't", () => {
    const cc = providerOf("us.anthropic.claude-opus-5-5", "claude-code", "bedrock:work");
    expect(cc).toBe("bedrock:us.anthropic.claude-opus-5-5#bedrock:work");
    expect(providerOf("amazon-bedrock/us.anthropic.claude-opus-5-5", "pi", "bedrock:work")).toBe(cc);
    expect(providerOf("amazon-bedrock/us.anthropic.claude-sonnet-5", "pi", "bedrock:work")).not.toBe(cc);
    expect(providerOf("amazon-bedrock/us.anthropic.claude-opus-5-5", "pi")).toBe("amazon-bedrock"); // no credential: unchanged
  });
});

describe("faults", () => {
  test("throttling is a rate limit; a service or per-day quota is a definite quota", () => {
    expect(bedrockFault("ThrottlingException: Too many requests, please wait before trying again.")).toEqual({ kind: "rate_limit", resetAt: undefined });
    expect(bedrockFault("API Error: 429 Too many tokens, please wait before trying again.")?.kind).toBe("rate_limit");
    expect(bedrockFault("ServiceQuotaExceededException: Your request exceeds the service quota for your account.")).toMatchObject({ kind: "quota", definite: true });
    const now = Date.UTC(2026, 9, 23, 15, 30);
    expect(bedrockFault("Too many tokens per day, please wait before trying again.", now)).toEqual({ kind: "quota", definite: true, resetAt: Date.UTC(2026, 9, 24) });
    expect(bedrockFault("ThrottlingException: try again in 30 seconds", now)).toEqual({ kind: "rate_limit", resetAt: now + 30_000 });
    expect(bedrockFault("ValidationException: bad")).toBeUndefined();
    expect(onBedrock({ harness: "claude-code", model: "us.anthropic.claude-opus-5-5", credential: "bedrock:aws.default" })).toBe(true);
    expect(onBedrock({ harness: "pi", model: "amazon-bedrock/us.anthropic.claude-opus-5-5" })).toBe(true);
    expect(onBedrock({ harness: "claude-code", model: "opus" })).toBe(false);
  });

  test("simulated limits use Bedrock's own wording", () => {
    const pi = piFault({ kind: "rate", afterTools: 0 }, "amazon-bedrock/us.anthropic.claude-opus-5-5");
    expect(pi.message.errorMessage).toStartWith("ThrottlingException:");
    const cc = claudeFault({ kind: "quota", afterTools: 0 }, "s", Date.now(), true);
    expect(cc.some((m) => m.type === "rate_limit_event")).toBe(false);
    expect(cc.at(-1).result).toContain("ServiceQuotaExceededException");
  });
});

/** A fake session on the real fallback path (fallbackSession.test.ts's pattern). */
function fake(harness: HarnessId, model: string, credential?: string) {
  const log: string[] = [];
  const handoffs: ChainEntry[] = [];
  const sink = { emit: () => {}, summary: () => {}, handoff: async (_f: LiveSession, to: ChainEntry, _r: string, _p?: string, _o?: HandoffOpts) => void handoffs.push(to) };
  class Fake extends LiveSession {
    async start() {}
    protected async send() {}
    async abort() {
      this.cancelWait();
    }
    async applyModel(m: string) {
      log.push(`model: ${m}`);
      this.setState({ model: m });
    }
    async setThinking() {}
    async setPermissionMode() {}
    async rename() {}
    async listCommands() {
      return [];
    }
    async continueTurn() {
      log.push("continue");
    }
    protected shutdown() {}
    turnError(text: string, status?: number | null, hint?: any) {
      return this.handleTurnError(text, status, hint);
    }
  }
  const s = new Fake(harness, { nativeId: crypto.randomUUID(), projectPath: process.env.HOME! }, sink);
  s.t.state.status = "idle";
  s.t.state.model = model;
  if (credential) s.t.state.credential = credential;
  return { s, log, handoffs };
}

describe("fallback on Bedrock", () => {
  test("a quota moves on down the chain; throttling backs off on the same model", async () => {
    const a = "amazon-bedrock/us.anthropic.claude-opus-5-5";
    const b = "amazon-bedrock/us.anthropic.claude-sonnet-5";
    const { s, log } = fake("pi", a);
    await s.setChain([`pi:${a}`, `pi:${b}`]);
    expect(await s.turnError("ThrottlingException: Too many requests, please wait before trying again.")).toBe(true);
    expect(config().exhausted).toEqual({});
    expect(s.t.state.waitingReason).toContain("Rate limited");
    s.abort();
    expect(await s.turnError("ServiceQuotaExceededException: Your request exceeds the service quota for your account.")).toBe(true);
    expect(Object.keys(config().exhausted)).toEqual(["amazon-bedrock"]);
    s.close();
    void log;
  });

  test("Claude Code on a Bedrock credential: a quota hands off even though Claude's hint only said rate_limit", async () => {
    await credentialAction("bedrock", "add", { kind: "apiKey", name: "work", apiKey: API_KEY });
    const { s, handoffs } = fake("claude-code", "us.anthropic.claude-opus-5-5", "bedrock:work");
    await s.setChain(["claude-code:us.anthropic.claude-opus-5-5#bedrock:work", "claude-code:opus"]);
    expect(await s.turnError("API Error: 400 Your request exceeds the service quota for your account.", 400, { kind: "rate_limit" })).toBe(true);
    expect(config().exhausted["bedrock:us.anthropic.claude-opus-5-5#bedrock:work"]).toBeGreaterThan(Date.now());
    expect(handoffs).toEqual([{ harness: "claude-code", model: "opus" }]);
    s.close();
  });

  test("off Bedrock, the same words change nothing: a 429 with Claude's rate_limit hint still backs off", async () => {
    const { s, handoffs } = fake("claude-code", "opus");
    await s.setChain(["claude-code:opus", "claude-code:sonnet"]);
    expect(await s.turnError("ServiceQuotaExceededException: Your request exceeds the service quota for your account.", 429, { kind: "rate_limit" })).toBe(true);
    expect(config().exhausted).toEqual({});
    expect(s.t.state.waitingReason).toContain("Rate limited");
    expect(handoffs).toEqual([]);
    s.close();
  });
});
