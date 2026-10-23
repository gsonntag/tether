// AWS Bedrock's slot on the Credentials page (runner/src/credentials/bedrock.ts): an Add form for a
// Bedrock API key or an access key (AWS profiles from ~/.aws show up on their own), and under each
// row its models ("Key once, models any time": pick from the region's list or type an id; each is
// tested with one tiny call before it's added), the region of a profile, and "Sign in again" for an
// `aws login` profile (the runner runs `aws login --remote`; you open the URL and paste the code back).
// Values go to the runner and never come back: replacing a key means adding it again.

import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Selector } from "@astryxdesign/core/Selector";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import type { CredentialActionResult, CredentialView } from "../shared/credentials";
import { modelLabel } from "../models";
import { ActionAnswer } from "./ActionAnswer";
import type { CredentialSlot, OnList } from "./index";

type Kind = "apiKey" | "awsKeys";

const red = { color: "var(--color-text-red)" };

/** Runs a credentialAction, hands the list on, gives back its result (or throws its message). */
async function act(id: string, action: string, args: unknown, onList: OnList): Promise<CredentialActionResult | undefined> {
  // Loaded on use: credentials/index.ts (and so this file) is imported where the store can't be (tests).
  const { rpc } = await import("../store");
  const r = await rpc("credentialAction", { id, action, args });
  onList(r.list);
  return r.result;
}

function useBusy() {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const run = async (name: string, fn: () => Promise<string | void>) => {
    setBusy(name);
    setError(undefined);
    setNote(undefined);
    try {
      const n = await fn();
      if (n) setNote(n);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(undefined);
    }
  };
  return { busy, error, note, setNote, run };
}

function Add({ onList, close }: { onList: OnList; close: () => void }) {
  const [kind, setKind] = useState<Kind>("apiKey");
  const [name, setName] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [apiKey, setApiKey] = useState("");
  const [keyId, setKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const { busy, error, run } = useBusy();
  const ready = name.trim() && region.trim() && (kind === "apiKey" ? apiKey : keyId && secret);
  const add = () =>
    run("add", async () => {
      const args = kind === "apiKey" ? { kind, name: name.trim(), region: region.trim(), apiKey } : { kind, name: name.trim(), region: region.trim(), accessKeyId: keyId.trim(), secretAccessKey: secret, sessionToken: token };
      await act("bedrock", "add", args, onList);
      close();
    });
  return (
    <VStack gap={2}>
      <SegmentedControl label="Kind" size="sm" value={kind} onChange={(v) => setKind(v as Kind)}>
        <SegmentedControlItem value="apiKey" label="Bedrock API key" />
        <SegmentedControlItem value="awsKeys" label="Access key" />
      </SegmentedControl>
      <HStack gap={2} wrap="wrap">
        <StackItem size="fill">
          <TextInput label="Name" size="sm" placeholder="work" value={name} onChange={setName} />
        </StackItem>
        <StackItem size="fill">
          <TextInput label="Region" size="sm" placeholder="us-east-1" value={region} onChange={setRegion} />
        </StackItem>
      </HStack>
      {kind === "apiKey" ? (
        <TextInput label="API key" type="password" autoComplete="off" size="sm" value={apiKey} onChange={setApiKey} />
      ) : (
        <>
          <TextInput label="Access key id" autoComplete="off" size="sm" placeholder="AKIA…" value={keyId} onChange={setKeyId} />
          <TextInput label="Secret access key" type="password" autoComplete="off" size="sm" value={secret} onChange={setSecret} />
          <TextInput label="Session token (temporary keys only)" type="password" autoComplete="off" size="sm" value={token} onChange={setToken} />
        </>
      )}
      <Text type="supporting" color="secondary">
        Stored on the runner only; Tether never shows it again. AWS profiles in ~/.aws are listed on their own.
      </Text>
      <HStack gap={2}>
        <Button label="Add" variant="primary" size="sm" isLoading={busy === "add"} isDisabled={!ready} onClick={add} />
        <Button label="Cancel" variant="ghost" size="sm" onClick={close} />
      </HStack>
      {error && (
        <Text type="supporting" style={red}>
          {error}
        </Text>
      )}
    </VStack>
  );
}

/** The Bedrock ids on a credential (its pi models carry every one, as "amazon-bedrock/<id>"). */
const modelIds = (c: CredentialView) => (c.models ?? []).filter((m) => m.harness === "pi").map((m) => m.id.replace(/^amazon-bedrock\//, ""));

function Row({ credential: c, onList }: { credential: CredentialView; onList: OnList }) {
  const ids = modelIds(c);
  const [model, setModel] = useState("");
  // The region's models and inference profiles ("US Opus 5.5 · Inference profile"), once listed.
  const [choices, setChoices] = useState<NonNullable<CredentialActionResult["models"]>>();
  const [region, setRegion] = useState<string>();
  // `aws login --remote` waiting for the code its page shows (the answer's `next`).
  const [signIn, setSignIn] = useState<CredentialActionResult>();
  const { busy, error, note, setNote, run } = useBusy();
  const isProfile = c.kind === "awsProfile";
  const canSignIn = c.actions?.includes("signIn");
  const credLabel = c.models?.[0]?.credentialLabel ?? "Bedrock";

  const list = () =>
    run("list", async () => {
      const r = await act(c.id, "listModels", {}, onList);
      // No list (the credential may not list models): its reason; a typed id still works.
      if (!r?.models?.length) throw new Error(r?.message ?? "No models listed. Type a model id.");
      setChoices(r.models);
    });
  const addModel = (id = model) =>
    run("addModel", async () => {
      const r = await act(c.id, "addModel", { model: id.trim() }, onList);
      setModel("");
      return r?.message;
    });

  return (
    <VStack gap={2}>
      {ids.length > 0 && (
        <HStack gap={1} wrap="wrap">
          {ids.map((id) => (
            <Token key={id} size="sm" label={modelLabel({ id, credential: c.id, credentialLabel: credLabel })} onRemove={() => run("remove", async () => void (await act(c.id, "removeModel", { model: id }, onList)))} />
          ))}
        </HStack>
      )}
      <HStack gap={2} vAlign="end" wrap="wrap">
        <StackItem size="fill">
          {choices?.length ? (
            <Selector
              label="Add a model"
              size="sm"
              hasSearch
              searchPlaceholder="Filter"
              placeholder="Pick a model or inference profile"
              value={model || undefined}
              options={choices.filter((m) => !ids.includes(m.id)).map((m) => ({ value: m.id, label: m.label ?? m.id, description: m.id }))}
              onChange={(v) => setModel(v)}
            />
          ) : (
            <TextInput label="Add a model" size="sm" placeholder="us.anthropic.claude-opus-5-5" value={model} onChange={setModel} />
          )}
        </StackItem>
        <Button label="Test and add" size="sm" variant="secondary" isLoading={busy === "addModel"} isDisabled={!model.trim() || !!busy} onClick={() => addModel()} />
        {!choices && <Button label="List models" size="sm" variant="ghost" isLoading={busy === "list"} isDisabled={!!busy} onClick={list} />}
        {choices && <Button label="Type an id" size="sm" variant="ghost" onClick={() => (setChoices(undefined), setModel(""))} />}
      </HStack>
      {isProfile && (
        <HStack gap={2} vAlign="end" wrap="wrap">
          {region === undefined ? (
            <Button label="Change region" size="sm" variant="ghost" onClick={() => setRegion(c.region ?? "")} />
          ) : (
            <>
              <TextInput label="Region" size="sm" placeholder="the profile's own" value={region} onChange={setRegion} />
              <Button label="Save" size="sm" variant="secondary" isLoading={busy === "region"} onClick={() => run("region", async () => (await act(c.id, "setRegion", { region: region.trim() }, onList), setRegion(undefined)))} />
              <Button label="Cancel" size="sm" variant="ghost" onClick={() => setRegion(undefined)} />
            </>
          )}
          {canSignIn && !signIn && (
            <Button
              label={c.state === "expired" ? "Sign in again" : "Sign in"}
              size="sm"
              variant={c.state === "expired" ? "primary" : "ghost"}
              isLoading={busy === "signIn"}
              isDisabled={!!busy}
              onClick={() => run("signIn", async () => setSignIn(await act(c.id, "signIn", {}, onList)))}
            />
          )}
        </HStack>
      )}
      {signIn && (
        <VStack gap={1}>
          <ActionAnswer
            id={c.id}
            result={signIn}
            onAnswer={(a) => {
              onList(a.list);
              // Done (or a step with nothing more to ask): its sentence as the row's note.
              if (a.result?.next) setSignIn(a.result);
              else (setSignIn(undefined), setNote(a.result?.message));
            }}
          />
          <HStack>
            <Button label="Cancel" size="sm" variant="ghost" onClick={() => setSignIn(undefined)} />
          </HStack>
        </VStack>
      )}
      {note && (
        <Text type="supporting" style={{ color: "var(--color-text-green)" }}>
          {note}
        </Text>
      )}
      {error && (
        <Text type="supporting" style={red}>
          {error}
        </Text>
      )}
    </VStack>
  );
}

export const bedrockSlot: CredentialSlot = {
  provider: "bedrock",
  Add,
  Row,
  ownActions: ["addModel", "removeModel", "listModels", "setRegion", "signIn"],
};
