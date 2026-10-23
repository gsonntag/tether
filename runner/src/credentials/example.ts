// A no-op credential plugin: the smallest complete one, for tests and as a template for real ones
// (Foundry, Bedrock, accounts). Not registered in production: credentials/index.ts adds it only
// with TETHER_EXAMPLE_CREDENTIALS=1 (local UI work). Its keys live in Tether's store and reach a
// process as EXAMPLE_API_KEY.

import type { CredentialModel } from "../../../web/src/shared/credentials";
import type { CredentialPlugin } from "./registry";
import * as store from "./store";

const MODELS: CredentialModel[] = [{ harness: "pi", id: "example/echo-1", credentialLabel: "Example" }];

export const examplePlugin: CredentialPlugin = {
  provider: "example",
  label: "Example keys",
  actions: ["add"],
  async discover() {
    return store.views("example").map((v) => ({ ...v, models: MODELS, actions: ["rename"] }));
  },
  async test(id) {
    const key = store.get(id)?.values.apiKey ?? "";
    return key.startsWith("ex-") ? { ok: true, result: "valid" } : { ok: false, result: "invalid", message: "Example keys start with “ex-”." };
  },
  async action(id, name, args) {
    const a = (args ?? {}) as { name?: string; apiKey?: string; label?: string };
    if (id === "example" && name === "add") {
      const slug = String(a.name ?? "").trim();
      if (!slug || !a.apiKey) throw new Error("Give it a name and a key.");
      await store.put({ id: `example:${slug}`, kind: "apiKey", label: a.label?.trim() || slug, values: { apiKey: a.apiKey }, last4Of: "apiKey" });
      return { id: `example:${slug}` };
    }
    if (name === "rename" && a.label) return store.update(id, { label: a.label });
    throw new Error(`Example keys have no “${name}”.`);
  },
  async envFor(id) {
    const key = store.get(id)?.values.apiKey;
    if (!key) throw new Error(`${id} has no key stored.`);
    return { EXAMPLE_API_KEY: key };
  },
  argsFor: (id) => ["--example-credential", id],
};
