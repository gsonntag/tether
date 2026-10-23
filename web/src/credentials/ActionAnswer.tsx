// What a credentialAction step answered (CredentialActionResult, shared/credentials.ts), shown
// under its row or form: the sentence, a page to open (an OAuth sign-in), a code to show (a device
// code), and the next step's prompt (paste the code back): its input goes to `next.action` as
// `{ [next.field ?? "code"]: input }`. The generic Credentials page row and the slots use it.

import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import type { CredentialActionResult, CredentialList } from "../shared/credentials";

// The store is loaded on first use: slot files are registered from credentials/index.ts, which
// non-browser code may import (the store needs a window).
const store = () => import("../store");

export const mono = { fontFamily: "var(--font-family-mono, ui-monospace, monospace)", wordBreak: "break-all" as const };

/** One credentialAction call: the step's answer and the runner's fresh list. */
export async function credentialAct(id: string, action: string, args?: unknown): Promise<{ result?: CredentialActionResult; list: CredentialList }> {
  return (await store()).rpc("credentialAction", { id, action, ...(args !== undefined ? { args } : {}) });
}

const copy = (s: string) =>
  navigator.clipboard?.writeText(s).then(
    () => void store().then((m) => m.toast("info", "Copied.")),
    () => {},
  );

/**
 * The answer, and its `next` prompt when it has one. `onAnswer` gets the next step's answer and list
 * (the caller keeps showing it, so a step can lead to another).
 */
export function ActionAnswer({ id, result, onAnswer }: { id: string; result: CredentialActionResult; onAnswer: (a: { result?: CredentialActionResult; list: CredentialList }) => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const next = result.next;
  const send = async () => {
    if (!next) return;
    setBusy(true);
    setError(undefined);
    try {
      const a = await credentialAct(result.id ?? id, next.action, { [next.field ?? "code"]: input.trim() });
      setInput("");
      onAnswer(a);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <VStack gap={1.5}>
      {result.message && (
        <Text type="supporting" style={{ whiteSpace: "pre-wrap" }}>
          {result.message}
        </Text>
      )}
      {(result.url || result.code) && (
        <HStack gap={2} vAlign="center" wrap="wrap">
          {result.code && (
            <>
              <Text weight="semibold" style={{ ...mono, fontSize: "1.25em", letterSpacing: "0.08em" }}>
                {result.code}
              </Text>
              <Button label="Copy code" size="sm" variant="ghost" onClick={() => copy(result.code!)} />
            </>
          )}
          {result.url && (
            <>
              <Button label="Open page" size="sm" variant="primary" href={result.url} target="_blank" rel="noopener noreferrer" />
              <Button label="Copy link" size="sm" variant="ghost" onClick={() => copy(result.url!)} />
            </>
          )}
        </HStack>
      )}
      {next && (
        <HStack gap={2} vAlign="end">
          <StackItem size="fill">
            <TextInput
              label={next.prompt}
              isLabelHidden
              size="sm"
              placeholder={next.prompt}
              type={next.secret ? "password" : "text"}
              autoComplete="off"
              value={input}
              onChange={setInput}
            />
          </StackItem>
          <Button label="Send" size="sm" variant="primary" isLoading={busy} isDisabled={!input.trim()} onClick={send} />
        </HStack>
      )}
      {error && (
        <Text type="supporting" style={{ color: "var(--color-text-red)" }}>
          {error}
        </Text>
      )}
    </VStack>
  );
}
