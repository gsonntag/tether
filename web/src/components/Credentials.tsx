// The Credentials page (.claude/credentials/SPEC.md, decision 3): everything this runner can run
// agents on (logins, accounts, API keys), one group per provider from listCredentials. Rows are
// generic (label, account, where it came from, state, usage, where it's used, Test, Remove); what's
// specific to a provider (its Add form, sign-in flows, models) comes from its slot
// (credentials/index.ts). Values never reach the browser: rows show the last 4 characters at most.

import { Children, useEffect, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Item } from "@astryxdesign/core/Item";
import { Layout, LayoutContent, LayoutHeader, VStack, HStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { credentialProvider, type CredentialList, type CredentialProviderInfo, type CredentialState, type CredentialTest, type CredentialView } from "../shared/credentials";
import { exampleSlot } from "../credentials/example";
import { registerSlot, slotFor } from "../credentials";
import { refreshCredentials, rpc, setCredentials, toast, useStore } from "../store";

// The example provider's form, for local UI work against a runner started with TETHER_EXAMPLE_CREDENTIALS=1.
if (import.meta.env?.DEV) registerSlot(exampleSlot);

const capped = { maxWidth: "calc(var(--spacing-12) * 20)", width: "100%" };

const STATE: Record<CredentialState, { variant: "success" | "warning" | "error" | "neutral"; label: string }> = {
  ok: { variant: "success", label: "Ready" },
  expired: { variant: "warning", label: "Expired" },
  missing: { variant: "error", label: "Not set up" },
  unknown: { variant: "neutral", label: "Not checked" },
};

const SOURCE: Record<CredentialView["source"], string> = {
  tether: "Stored in Tether",
  shell: "From your login shell",
  env: "From the runner's environment",
  cli: "The CLI's own login",
};

/** The row's second line: account, endpoint, region, key ending, where it came from. */
export function credentialDetails(c: CredentialView): string {
  return [c.account, c.endpointHost, c.region, c.last4 && `…${c.last4}`, c.sourceNote ?? SOURCE[c.source]].filter(Boolean).join(" · ");
}

/** "5h 40% · Weekly 12%" */
const usageLine = (c: CredentialView) => c.usage?.map((w) => `${w.label} ${w.percent ?? "–"}%`).join(" · ");

const actionLabel = (provider: string, action: string) => slotFor(provider)?.actionLabels?.[action] ?? action.charAt(0).toUpperCase() + action.slice(1);

export function CredentialsPage({ narrow }: { narrow: boolean }) {
  const list = useStore((s) => s.credentials);
  const runnerId = useStore((s) => s.runnerId);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    document.title = "Credentials · Tether";
    setFailed(false);
    refreshCredentials().then((l) => !l && !useStore.getState().credentials && setFailed(true));
    return () => void (document.title = "Tether");
  }, [runnerId]);

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader hasDivider padding={4}>
          {/* Room on phones (and with the sidebar hidden) for the floating sidebar button. */}
          <HStack gap={3} vAlign="center" paddingInlineStart={narrow ? 8 : 0}>
            <Heading level={1}>Credentials</Heading>
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent role="main" padding={4}>
          <VStack gap={6} style={capped}>
            {list ? <Groups list={list} /> : failed ? <EmptyState title="This runner can't list credentials yet" description="Update it to see its accounts and keys here." /> : <Spinner label="Loading…" />}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function Groups({ list }: { list: CredentialList }) {
  const nothing = !list.credentials.length && !list.providers.some((p) => slotFor(p.provider)?.Add);
  return (
    <>
      {list.errors?.map((e) => (
        <Banner key={e.provider} status="warning" container="section" collapsible={false} title={`Couldn't read ${list.providers.find((p) => p.provider === e.provider)?.label ?? e.provider}`} description={e.error} />
      ))}
      {nothing ? (
        <EmptyState title="No accounts or keys yet" description="The logins and API keys this runner can run agents on will show up here." />
      ) : (
        list.providers.map((p) => <ProviderGroup key={p.provider} provider={p} credentials={list.credentials.filter((c) => credentialProvider(c.id) === p.provider)} />)
      )}
    </>
  );
}

/** One provider: its title, an Add button when its slot has a form, and its rows. */
function ProviderGroup({ provider, credentials }: { provider: CredentialProviderInfo; credentials: CredentialView[] }) {
  const slot = slotFor(provider.provider);
  const [adding, setAdding] = useState(false);
  const Add = slot?.Add;
  if (!credentials.length && !Add) return null;
  const rows: ReactNode[] = credentials.map((c) => <CredentialRow key={c.id} credential={c} />);
  if (adding && Add) rows.push(<VStack key="+add" padding={4}>{<Add provider={provider} onList={(l) => setCredentials(l)} close={() => setAdding(false)} />}</VStack>);
  return (
    <VStack gap={1.5}>
      <HStack gap={2} hAlign="between" vAlign="center">
        <Text type="supporting" weight="semibold" color="secondary">
          {provider.label}
        </Text>
        {Add && !adding && <Button label="Add" size="sm" variant="ghost" onClick={() => setAdding(true)} />}
      </HStack>
      {rows.length ? <Rows>{rows}</Rows> : <Text type="supporting">None yet.</Text>}
    </VStack>
  );
}

/** A muted card of rows separated by hairlines (the Settings look). */
function Rows({ children }: { children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <Card padding={0} width="100%" variant="muted">
      <VStack as="ul" role="list" gap={0}>
        {rows.map((row, i) => (
          <VStack key={i} as="li" gap={0}>
            {i > 0 && <Divider variant="subtle" />}
            {row}
          </VStack>
        ))}
      </VStack>
    </Card>
  );
}

function CredentialRow({ credential: c }: { credential: CredentialView }) {
  const owner = credentialProvider(c.id);
  const slot = slotFor(owner);
  const [busy, setBusy] = useState<string>();
  const [test, setTest] = useState<CredentialTest>();
  // What a generic action said (its result's message); flows with a URL or code are a slot's Row.
  const [answer, setAnswer] = useState<string>();
  const st = STATE[c.state] ?? STATE.unknown;
  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e: any) {
      toast("error", e?.message ?? String(e));
    } finally {
      setBusy(undefined);
    }
  };
  const actions = (c.actions ?? []).filter((a) => !slot?.ownActions?.includes(a));
  const usage = usageLine(c);
  const notes = [answer, c.stateNote, usage, c.usedIn?.length ? `Used in ${c.usedIn.join(", ")}` : undefined].filter(Boolean) as string[];
  const Row = slot?.Row;
  return (
    <VStack padding={2} gap={1}>
      <Item
        startContent={<StatusDot variant={st.variant} label={st.label} tooltip={c.stateNote ?? st.label} />}
        label={c.label}
        description={credentialDetails(c)}
        descriptionLines={2}
        endContent={
          <HStack gap={1} wrap="wrap" hAlign="end">
            {actions.map((a) => (
              <Button
                key={a}
                label={actionLabel(owner, a)}
                size="sm"
                variant="ghost"
                isLoading={busy === a}
                isDisabled={!!busy}
                onClick={() =>
                  run(a, async () => {
                    const r = await rpc("credentialAction", { id: c.id, action: a });
                    setAnswer(r.result?.message);
                    setCredentials(r.list);
                  })
                }
              />
            ))}
            <Button label="Test" size="sm" variant="ghost" isLoading={busy === "test"} isDisabled={!!busy} onClick={() => run("test", async () => setTest(await rpc("testCredential", { id: c.id })))} />
            {/* No confirm: what removing it changes is said next to the button. */}
            {c.source === "tether" && c.usedIn?.some((u) => u.startsWith("Default order")) && (
              <Text type="supporting" color="secondary">
                Used in your default order
              </Text>
            )}
            {c.source === "tether" && (
              <Button
                label="Remove"
                size="sm"
                variant="ghost"
                isLoading={busy === "remove"}
                isDisabled={!!busy}
                onClick={() => run("remove", async () => setCredentials(await rpc("removeCredential", { id: c.id })))}
              />
            )}
          </HStack>
        }
      />
      {(notes.length > 0 || test) && (
        <VStack gap={0.5} paddingInlineStart={8}>
          {test && (
            <Text type="supporting" style={{ color: test.ok ? "var(--color-text-green)" : "var(--color-text-red)" }}>
              {test.message ?? (test.ok ? "Works." : `Didn't work: ${test.result}.`)}
            </Text>
          )}
          {notes.map((n) => (
            <Text key={n} type="supporting" color="secondary">
              {n}
            </Text>
          ))}
        </VStack>
      )}
      {Row && (
        <VStack paddingInlineStart={8}>
          <Row credential={c} onList={(l) => setCredentials(l)} />
        </VStack>
      )}
    </VStack>
  );
}
