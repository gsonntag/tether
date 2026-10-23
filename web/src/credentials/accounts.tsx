// Harness logins and extra accounts on the Credentials page (runner/src/credentials/accounts.ts):
// "Add another account" (a name, then that provider's sign-in), and each row's sign-in flow:
// open the sign-in page in a new tab and paste the code back (Claude), enter a device code
// (ChatGPT via Codex), or run a command on the runner (pi, Kiro, Antigravity), which Tether
// notices. Nothing secret comes through here: the runner sends the link, the device code and the
// account's name; the code you paste goes to the CLI on the runner and nowhere else.

import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { accountSlug, ACCOUNT_NAME, RESERVED_ACCOUNT_NAMES, type SignInFlow, type SignInResult } from "../shared/accounts";
import type { CredentialList, CredentialView } from "../shared/credentials";
import type { CredentialSlot, OnList } from "./index";

// The store is loaded on first use: this file is registered from credentials/index.ts, which
// non-browser tests import too (the store needs a window).
const store = () => import("../store");
const toast = (level: "info" | "error", text: string) => void store().then((m) => m.toast(level, text));

const mono = {
  fontFamily: "var(--font-family-mono, ui-monospace, monospace)",
  wordBreak: "break-all" as const,
};
const red = { color: "var(--color-text-red)" };

type ActionAnswer = { result?: SignInResult; list?: CredentialList };

async function act(id: string, action: string, args?: unknown): Promise<ActionAnswer> {
  return (await store()).rpc("credentialAction", {
    id,
    action,
    ...(args ? { args } : {}),
  }) as Promise<ActionAnswer>;
}

/** Whether a flow is still going (the runner waits on you or the CLI). */
export const flowLive = (f?: SignInFlow) => !!f && (f.state === "starting" || f.state === "waiting" || f.state === "verifying");

/** What the name field says is wrong with a new account's name, if anything. */
export function nameProblem(name: string): string | undefined {
  if (!name.trim()) return undefined;
  const slug = accountSlug(name);
  if (!slug || !ACCOUNT_NAME.test(slug)) return "Letters, digits, dots and dashes.";
  if (RESERVED_ACCOUNT_NAMES.includes(slug)) return "That name is this machine's own login.";
  return undefined;
}

/**
 * One sign-in, shown under its row: follows the runner's flow (polling while it's live) until it's
 * done, then hands the fresh list up.
 */
export function SignInPanel({ id, initial, onList, onClose }: { id: string; initial?: SignInFlow; onList: OnList; onClose: () => void }) {
  const [flow, setFlow] = useState<SignInFlow | undefined>(initial);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const stopped = useRef(false);

  useEffect(() => {
    stopped.current = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped.current) return;
      try {
        const a = await act(id, "signInStatus");
        const f = a.result?.flow;
        setFlow(f);
        if (f?.state === "done" && a.list) {
          onList(a.list);
          return;
        }
        if (!flowLive(f)) return;
      } catch {}
      t = setTimeout(tick, 2000);
    };
    t = setTimeout(tick, initial ? 2000 : 0);
    return () => {
      stopped.current = true;
      clearTimeout(t);
    };
  }, [id]);

  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const a = await act(id, "signInCode", { code: code.trim() });
      setFlow(a.result?.flow);
      setCode("");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    stopped.current = true;
    try {
      const a = await act(id, "signInCancel");
      if (a.list) onList(a.list);
    } catch {}
    onClose();
  };
  const copy = (s: string) =>
    navigator.clipboard?.writeText(s).then(
      () => toast("info", "Copied."),
      () => {},
    );

  if (!flow) return <Text type="supporting">Starting the sign-in…</Text>;
  if (flow.state === "done")
    return (
      <Text type="supporting" style={{ color: "var(--color-text-green)" }}>
        {flow.kind === "command" ? "Done." : "Signed in."}
      </Text>
    );
  const over = !flowLive(flow);
  return (
    <VStack gap={1.5}>
      {flow.kind === "paste" && flow.url && !over && (
        <>
          <Text type="supporting">1. Open the sign-in page and sign in with the account you want here.</Text>
          <HStack gap={2} wrap="wrap">
            <Button label="Open sign-in page" size="sm" variant="primary" href={flow.url} target="_blank" rel="noopener noreferrer" />
            <Button label="Copy link" size="sm" variant="ghost" onClick={() => copy(flow.url!)} />
          </HStack>
          <Text type="supporting">2. Paste the code it shows you.</Text>
          <HStack gap={2} vAlign="end">
            <StackItem size="fill">
              <TextInput
                label="Code"
                isLabelHidden
                size="sm"
                placeholder="Paste the code"
                autoComplete="off"
                value={code}
                onChange={setCode}
                isDisabled={flow.state === "verifying"}
              />
            </StackItem>
            <Button label="Sign in" size="sm" variant="primary" isLoading={busy || flow.state === "verifying"} isDisabled={!code.trim()} onClick={send} />
          </HStack>
          {flow.state === "verifying" && <Text type="supporting">Checking the code…</Text>}
        </>
      )}
      {flow.kind === "device" && flow.url && !over && (
        <>
          <Text type="supporting">Open the page, sign in with the account you want here, and enter this code:</Text>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Text weight="semibold" style={{ ...mono, fontSize: "1.25em", letterSpacing: "0.08em" }}>
              {flow.code}
            </Text>
            <Button label="Copy code" size="sm" variant="ghost" onClick={() => copy(flow.code ?? "")} />
            <Button label="Open page" size="sm" variant="primary" href={flow.url} target="_blank" rel="noopener noreferrer" />
          </HStack>
          <Text type="supporting" color="secondary">
            Waiting for you to finish there…
          </Text>
        </>
      )}
      {flow.kind === "command" && !over && (
        <>
          <Text type="supporting">{flow.message ?? "Run this on the runner. Tether notices when you're signed in."}</Text>
          <HStack gap={2} vAlign="center">
            <StackItem size="fill">
              <Text type="supporting" style={mono}>
                {flow.command}
              </Text>
            </StackItem>
            <Button label="Copy" size="sm" variant="ghost" onClick={() => copy(flow.command ?? "")} />
          </HStack>
        </>
      )}
      {flow.state === "starting" && (
        <Text type="supporting" color="secondary">
          Starting the sign-in…
        </Text>
      )}
      {flow.output && !flow.url && (
        <Text type="supporting" color="secondary" style={{ ...mono, whiteSpace: "pre-wrap" }}>
          {flow.output}
        </Text>
      )}
      {over && flow.state !== "cancelled" && (
        <Text type="supporting" style={{ ...red, whiteSpace: "pre-wrap" }}>
          {flow.message ?? "The sign-in stopped."}
        </Text>
      )}
      {error && (
        <Text type="supporting" style={red}>
          {error}
        </Text>
      )}
      <HStack>
        <Button label={over ? "Close" : "Cancel"} size="sm" variant="ghost" onClick={over ? onClose : cancel} />
      </HStack>
    </VStack>
  );
}

/** The row's own part: its sign-in buttons, and the flow once one runs (or was running when the page opened). */
function AccountRow({ credential: c, onList }: { credential: CredentialView; onList: OnList }) {
  const [flow, setFlow] = useState<{ flow?: SignInFlow; open: boolean }>({
    open: false,
  });
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
    act(c.id, "signInStatus")
      .then((a) => !gone && flowLive(a.result?.flow) && setFlow({ flow: a.result!.flow, open: true }))
      .catch(() => {});
    return () => void (gone = true);
  }, [c.id, c.state]);

  const start = async (action: string) => {
    setBusy(action);
    try {
      const a = await act(c.id, action);
      // Signing a machine login out shows the command to run; an extra account's is done already.
      if (a.result?.flow) setFlow({ flow: a.result.flow, open: true });
      else {
        if (a.result?.message) toast("info", a.result.message);
        if (a.list) onList(a.list);
      }
    } catch (e: any) {
      toast("error", e?.message ?? String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const offers = (c.actions ?? []).filter((a) => a === "signIn" || a === "signInPi" || a === "signOut");
  return flow.open ? (
    <SignInPanel
      id={c.id}
      initial={flow.flow}
      onList={(l) => {
        setFlow({ open: false });
        onList(l);
      }}
      onClose={() => setFlow({ open: false })}
    />
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
    const [started, setStarted] = useState<{ id: string; flow?: SignInFlow }>();
    const problem = nameProblem(name);
    const add = async () => {
      setBusy(true);
      setError(undefined);
      try {
        const a = await act(provider, "add", { name: name.trim() });
        const flow = a.result?.flow;
        if (flow) setStarted({ id: flow.id, flow });
        if (a.list) onList(a.list);
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
          <SignInPanel
            id={started.id}
            initial={started.flow}
            onList={(l) => {
              onList(l);
              close();
            }}
            onClose={close}
          />
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

const FLOW_ACTIONS = ["signIn", "signInPi", "signOut", "signInStatus", "signInCode", "signInCancel"];

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
