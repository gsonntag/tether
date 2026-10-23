// The example provider's slot (runner/src/credentials/example.ts): a name + key Add form, the
// template for real ones. Registered only in dev builds (components/Credentials.tsx), where a
// runner started with TETHER_EXAMPLE_CREDENTIALS=1 lists the example provider.

import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { rpc } from "../store";
import type { CredentialSlot } from "./index";

export const exampleSlot: CredentialSlot = {
  provider: "example",
  actionLabels: { rename: "Rename" },
  ownActions: ["rename"],
  Add({ onList, close }) {
    const [name, setName] = useState("");
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const add = async () => {
      setBusy(true);
      setError(undefined);
      try {
        onList((await rpc("credentialAction", { id: "example", action: "add", args: { name: name.trim(), apiKey: key } })).list);
        close();
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <VStack gap={2}>
        <HStack gap={2} vAlign="end">
          <StackItem size="fill">
            <TextInput label="Name" size="sm" placeholder="work" value={name} onChange={setName} />
          </StackItem>
          <StackItem size="fill">
            <TextInput label="Key" type="password" autoComplete="off" size="sm" value={key} onChange={setKey} />
          </StackItem>
          <Button label="Add" variant="primary" size="sm" isLoading={busy} isDisabled={!name.trim() || !key} onClick={add} />
          <Button label="Cancel" variant="ghost" size="sm" onClick={close} />
        </HStack>
        {error && (
          <Text type="supporting" style={{ color: "var(--color-text-red)" }}>
            {error}
          </Text>
        )}
      </VStack>
    );
  },
};
