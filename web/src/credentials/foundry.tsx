// Microsoft Foundry (Azure OpenAI) on the Credentials page (runner/src/credentials/foundry.ts): an
// Add form (endpoint, key, optional name) and, under each resource, its models with "Add model"
// (a deployment name, tested before it's added; the resource's model list as suggestions) and
// "Replace key". "Store in Tether" (a key from the shell or the env) is a plain row button. Keys go
// in and never come back.

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import type { CredentialView } from "../shared/credentials";
import { modelDisplay } from "../models";
import type { CredentialSlot, OnList } from "./index";

/** One action; the new list goes to `onList`, its message (suggestions…) comes back. */
async function act(id: string, action: string, args: unknown, onList: OnList): Promise<string | undefined> {
  // Loaded on use: credentials/index.ts (and so this file) is imported where the store can't be (tests).
  const { rpc } = await import("../store");
  const r: any = await rpc("credentialAction", { id, action, args });
  if (r?.list) onList(r.list);
  return r?.message ?? r?.result?.message;
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const Error_ = ({ text }: { text?: string }) =>
  text ? (
    <Text type="supporting" style={{ color: "var(--color-text-red)" }}>
      {text}
    </Text>
  ) : null;

/** Codex models of a resource, one per deployment ("GPT-6.1 Sol", its Codex profile, removable when added here). */
export function foundryModels(c: CredentialView): { id: string; name: string; profile?: string }[] {
  return (c.models ?? []).filter((m) => m.harness === "codex").map((m) => ({ id: m.id, name: modelDisplay(m.id, "codex").name, ...(m.label ? { profile: m.label } : {}) }));
}

function Add({ onList, close }: { onList: OnList; close: () => void }) {
  const [endpoint, setEndpoint] = useState("");
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const { busy, error, run } = useAction();
  const ready = !!endpoint.trim() && !!key.trim();
  const add = () => run(async () => void (await act("azure", "add", { endpoint: endpoint.trim(), apiKey: key.trim(), label: label.trim() }, onList), close()));
  return (
    <VStack gap={2}>
      <TextInput label="Endpoint" size="sm" placeholder="https://<resource>.openai.azure.com" value={endpoint} onChange={setEndpoint} hasAutoFocus />
      <HStack gap={2} vAlign="end" wrap="wrap">
        <StackItem size="fill">
          <TextInput label="Key" type="password" autoComplete="off" size="sm" value={key} onChange={setKey} onEnter={() => ready && add()} />
        </StackItem>
        <StackItem size="fill">
          <TextInput label="Name" isOptional size="sm" value={label} onChange={setLabel} onEnter={() => ready && add()} />
        </StackItem>
      </HStack>
      <HStack gap={2}>
        <Button label="Add" variant="primary" size="sm" isLoading={busy} isDisabled={!ready} onClick={add} />
        <Button label="Cancel" variant="ghost" size="sm" onClick={close} />
      </HStack>
      <Error_ text={error} />
    </VStack>
  );
}

function AddModel({ c, onList, close }: { c: CredentialView; onList: OnList; close: () => void }) {
  const [name, setName] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  useEffect(() => {
    let live = true;
    // Where the key can read the resource's model list; typing a name always works.
    act(c.id, "suggest", undefined, () => {})
      .then((m) => live && setSuggestions((m ?? "").split("\n").filter(Boolean)))
      .catch(() => {});
    return () => void (live = false);
  }, [c.id]);
  const add = (d = name.trim()) => d && run(async () => void (await act(c.id, "addModel", { deployment: d }, onList), close()));
  const shown = suggestions.filter((s) => s.toLowerCase().includes(name.trim().toLowerCase())).slice(0, 8);
  return (
    <VStack gap={1.5}>
      <HStack gap={2} vAlign="end">
        <StackItem size="fill">
          <TextInput label="Deployment" size="sm" placeholder="gpt-6-luna" value={name} onChange={setName} onEnter={() => add()} hasAutoFocus isDisabled={busy} />
        </StackItem>
        <Button label={busy ? "Testing…" : "Add"} variant="primary" size="sm" isLoading={busy} isDisabled={!name.trim()} onClick={() => add()} />
        <Button label="Cancel" variant="ghost" size="sm" onClick={close} />
      </HStack>
      {shown.length > 0 && !busy && (
        <HStack gap={1} wrap="wrap">
          {shown.map((s) => (
            <Token key={s} size="sm" label={s} onClick={() => setName(s)} />
          ))}
        </HStack>
      )}
      <Error_ text={error} />
    </VStack>
  );
}

function ReplaceKey({ c, onList, close }: { c: CredentialView; onList: OnList; close: () => void }) {
  const [key, setKey] = useState("");
  const { busy, error, run } = useAction();
  const save = () => key.trim() && run(async () => void (await act(c.id, "replaceKey", { apiKey: key.trim() }, onList), close()));
  return (
    <VStack gap={1.5}>
      <HStack gap={2} vAlign="end">
        <StackItem size="fill">
          <TextInput label="New key" type="password" autoComplete="off" size="sm" value={key} onChange={setKey} onEnter={save} hasAutoFocus />
        </StackItem>
        <Button label="Save" variant="primary" size="sm" isLoading={busy} isDisabled={!key.trim()} onClick={save} />
        <Button label="Cancel" variant="ghost" size="sm" onClick={close} />
      </HStack>
      <Error_ text={error} />
    </VStack>
  );
}

function Row({ credential: c, onList }: { credential: CredentialView; onList: OnList }) {
  const [open, setOpen] = useState<"model" | "key">();
  const { error, run } = useAction();
  const models = foundryModels(c);
  const can = (a: string) => c.actions?.includes(a);
  let form: ReactNode = null;
  if (open === "model") form = <AddModel c={c} onList={onList} close={() => setOpen(undefined)} />;
  if (open === "key") form = <ReplaceKey c={c} onList={onList} close={() => setOpen(undefined)} />;
  return (
    <VStack gap={1.5}>
      <HStack gap={1} wrap="wrap" vAlign="center">
        {models.map((m) => (
          <Token
            key={m.id}
            size="sm"
            label={m.name}
            description={m.profile ? `Codex profile ${m.profile}` : m.id}
            {...(!m.profile && can("removeModel") ? { onRemove: () => run(async () => void (await act(c.id, "removeModel", { deployment: m.id }, onList))) } : {})}
          />
        ))}
        {!open && can("addModel") && <Button label="Add model" size="sm" variant="ghost" onClick={() => setOpen("model")} />}
        {!open && can("replaceKey") && <Button label="Replace key" size="sm" variant="ghost" onClick={() => setOpen("key")} />}
      </HStack>
      {form}
      <Error_ text={error} />
    </VStack>
  );
}

export const foundrySlot: CredentialSlot = {
  provider: "azure",
  Add: ({ onList, close }) => <Add onList={onList} close={close} />,
  Row,
  actionLabels: { storeKey: "Store in Tether", addModel: "Add model", replaceKey: "Replace key" },
  ownActions: ["addModel", "replaceKey", "removeModel", "suggest"],
};
