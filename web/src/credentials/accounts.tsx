// Harness logins and extra accounts on the Credentials page (runner/src/credentials/accounts.ts):
// "Add another account" (a name, then that provider's sign-in), and each row's sign-in flow:
// open the sign-in page in a new tab and paste the code back (Claude), enter a device code
// (ChatGPT via Codex), or run a command on the runner (pi, Kiro, Antigravity), which Tether
// notices. Nothing secret comes through here: the runner sends the link, the device code and the
// account's name; the code you paste goes to the CLI on the runner and nowhere else.
//
// Each step answers a CredentialActionResult (shared/accounts.ts): while the sign-in goes on it
// carries `id` and the panel keeps asking "signInStatus"; the code to paste is its `next` prompt.

import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { accountSlug, ACCOUNT_NAME, RESERVED_ACCOUNT_NAMES, SIGN_IN_STEPS } from "../shared/accounts";
import type { CredentialActionResult, CredentialView } from "../shared/credentials";
import { ActionAnswer, credentialAct } from "./ActionAnswer";
import type { CredentialSlot, OnList } from "./index";

const store = () => import("../store");
const toast = (level: "info" | "error", text: string) => void store().then((m) => m.toast(level, text));
const red = { color: "var(--color-text-red)" };

/** Whether a sign-in step's answer says it goes on (the runner answers `id` while it does). */
export const signInGoesOn = (r?: CredentialActionResult) => !!r?.id;

/** What the name field says is wrong with a new account's name, if anything. */
export function nameProblem(name: string): string | undefined {
  if (!name.trim()) return undefined;
  const slug = accountSlug(name);
  if (!slug || !ACCOUNT_NAME.test(slug)) return "Letters, digits, dots and dashes.";
  if (RESERVED_ACCOUNT_NAMES.includes(slug)) return "That name is this machine's own login.";
  return undefined;
}

/**
 * One sign-in, shown under its row: follows the runner's flow (asking again while it goes on), and
 * hands the fresh list up once it ends; its last word stays until Close.
 */
export function SignInPanel({ id, initial, onList, onClose }: { id: string; initial?: CredentialActionResult; onList: OnList; onClose: () => void }) {
  const [answer, setAnswer] = useState<CredentialActionResult | undefined>(initial);
  const live = !answer || signInGoesOn(answer);
  const stopped = useRef(false);

  useEffect(() => {
    if (!live) return;
    stopped.current = false;
    const t = setTimeout(
      async () => {
        if (stopped.current) return;
        try {
          const a = await credentialAct(id, SIGN_IN_STEPS.status);
          if (stopped.current) return;
          setAnswer(a.result ?? { message: "The sign-in stopped." });
          if (!signInGoesOn(a.result)) onList(a.list);
        } catch {
          // asked again on the next render
          setAnswer((x) => (x ? { ...x } : x));
        }
      },
      answer ? 2000 : 0,
    );
    return () => {
      stopped.current = true;
      clearTimeout(t);
    };
  }, [id, answer]);

  const cancel = async () => {
    stopped.current = true;
    try {
      onList((await credentialAct(id, SIGN_IN_STEPS.cancel)).list);
    } catch {}
    onClose();
  };

  return (
    <VStack gap={1.5}>
      {answer ? (
        <ActionAnswer
          id={id}
          result={answer}
          onAnswer={(a) => {
            setAnswer(a.result ?? { message: "The sign-in stopped." });
            onList(a.list);
          }}
        />
      ) : (
        <Text type="supporting">Starting the sign-in…</Text>
      )}
      <HStack>
        <Button label={live ? "Cancel" : "Close"} size="sm" variant="ghost" onClick={live ? cancel : onClose} />
      </HStack>
    </VStack>
  );
}

/** The row's own part: its sign-in buttons, and the flow once one runs (or was running when the page opened). */
function AccountRow({ credential: c, onList }: { credential: CredentialView; onList: OnList }) {
  const [flow, setFlow] = useState<{ answer?: CredentialActionResult; open: boolean }>({ open: false });
  const [busy, setBusy] = useState<string>();
  // Opened from a session's "Sign in to …" button (openPage("credentials", id)): its button leads.
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    void store().then((m) => {
      const s = m.useStore.getState();
      setFocus(s.page === "credentials" && s.memoryFocus === c.id);
    });
  }, [c.id]);

  // A sign-in already running for this row (started on another device, or before a reload).
  useEffect(() => {
    let gone = false;
    if (c.state === "ok") return;
    credentialAct(c.id, SIGN_IN_STEPS.status)
      .then((a) => !gone && signInGoesOn(a.result) && setFlow({ answer: a.result, open: true }))
      .catch(() => {});
    return () => void (gone = true);
  }, [c.id, c.state]);

  const start = async (action: string) => {
    setBusy(action);
    try {
      const a = await credentialAct(c.id, action);
      // A sign-in (or a machine login's sign-out command) goes on under the row; an extra account's sign-out is done already.
      if (signInGoesOn(a.result)) setFlow({ answer: a.result, open: true });
      else if (a.result?.message) toast("info", a.result.message);
      onList(a.list);
    } catch (e: any) {
      toast("error", e?.message ?? String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const offers = (c.actions ?? []).filter((a) => a === "signIn" || a === "signInPi" || a === "signOut");
  return flow.open ? (
    <SignInPanel id={c.id} initial={flow.answer} onList={onList} onClose={() => setFlow({ open: false })} />
  ) : offers.length ? (
    <HStack gap={2} wrap="wrap">
      {offers.map((a) => (
        <Button
          key={a}
          label={a === "signOut" ? "Sign out" : a === "signInPi" ? "Sign in for pi too" : c.state === "expired" ? "Sign in again" : "Sign in"}
          size="sm"
          variant={a === "signIn" && focus ? "primary" : a === "signOut" ? "ghost" : "secondary"}
          isLoading={busy === a}
          isDisabled={!!busy}
          onClick={() => start(a)}
        />
      ))}
    </HStack>
  ) : null;
}

/** "Add another account": a name for it, then that provider's sign-in under the new row. */
function addForm(provider: "claude" | "chatgpt", hint: string): CredentialSlot["Add"] {
  return function AddAccount({ onList, close }) {
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string>();
    const [started, setStarted] = useState<{ id: string; answer: CredentialActionResult }>();
    const problem = nameProblem(name);
    const add = async () => {
      setBusy(true);
      setError(undefined);
      try {
        const a = await credentialAct(provider, "add", { name: name.trim() });
        if (a.result?.id) setStarted({ id: a.result.id, answer: a.result });
        else if (a.result?.message) setError(a.result.message);
        onList(a.list);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      } finally {
        setBusy(false);
      }
    };
    if (started)
      return (
        <VStack gap={1}>
          <Text type="supporting" weight="semibold">
            Signing in “{started.id.split(":")[1]}”
          </Text>
          <SignInPanel id={started.id} initial={started.answer} onList={onList} onClose={close} />
        </VStack>
      );
    return (
      <VStack gap={2}>
        <Text type="supporting">{hint}</Text>
        <HStack gap={2} vAlign="end">
          <StackItem size="fill">
            <TextInput label="Name for this account" size="sm" placeholder="work" value={name} onChange={setName} autoComplete="off" />
          </StackItem>
          <Button label="Sign in" variant="primary" size="sm" isLoading={busy} isDisabled={!name.trim() || !!problem} onClick={add} />
          <Button label="Cancel" variant="ghost" size="sm" onClick={close} />
        </HStack>
        {(problem || error) && (
          <Text type="supporting" style={red}>
            {problem ?? error}
          </Text>
        )}
      </VStack>
    );
  };
}

const FLOW_ACTIONS = ["signIn", "signInPi", "signOut", SIGN_IN_STEPS.status, SIGN_IN_STEPS.code, SIGN_IN_STEPS.cancel];

export const accountSlots: CredentialSlot[] = [
  {
    provider: "claude",
    Add: addForm("claude", "Another Claude account, kept apart from this machine's login. Fallback moves to it when the one before hits its limit."),
    Row: AccountRow,
    actionLabels: { signOut: "Sign out" },
    ownActions: FLOW_ACTIONS,
  },
  {
    provider: "chatgpt",
    Add: addForm("chatgpt", "Another ChatGPT account for Codex (and pi), kept apart from this machine's logins."),
    Row: AccountRow,
    actionLabels: { signOut: "Sign out" },
    ownActions: FLOW_ACTIONS,
  },
  {
    provider: "kiro",
    Row: AccountRow,
    actionLabels: { signOut: "Sign out" },
    ownActions: FLOW_ACTIONS,
  },
  { provider: "antigravity", Row: AccountRow, ownActions: FLOW_ACTIONS },
];
