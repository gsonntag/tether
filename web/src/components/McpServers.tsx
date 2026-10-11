// "MCP servers" on the Memory & Skills page: Tether's MCP registry (runner/src/mcp/). One list of
// the user's servers, each on or off and trusted or not (trusted: the guard allows its tools without
// asking), the harnesses it reached, and a paste box to add one (a command, a URL or JSON).
// "Find servers" imports every harness's own MCP config; Import on the page does that too.

import { useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Switch } from "@astryxdesign/core/Switch";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { TrashIcon } from "@heroicons/react/24/outline";
import type { McpServerView } from "../shared/protocol";
import { act, rpc, useStore } from "../store";
import { harnessLabel } from "../util";
import { HarnessBadge } from "./HarnessBadge";
import { scopeLabel, sourceLabel } from "./MemoryConflicts";

const TYPE_LABEL: Record<McpServerView["type"], string> = { stdio: "Command", http: "HTTP", sse: "SSE" };

export function McpSection({ narrow }: { narrow: boolean }) {
  const runnerId = useStore((s) => s.runnerId);
  const projects = useStore((s) => s.projects);
  // A finished import (the page's Turn on) may have brought servers in.
  const imports = useStore((s) => s.contextLive.filter((a) => a.kind === "import").length);
  const [servers, setServers] = useState<McpServerView[]>();
  const [busy, setBusy] = useState<string>();
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{ added: string[]; warnings: string[] }>();

  useEffect(() => {
    rpc("listMcpServers", {})
      .then(setServers)
      .catch(() => setServers([]));
  }, [runnerId, imports]);

  const set = async (s: McpServerView, change: { enabled?: boolean; trusted?: boolean; remove?: boolean }) => {
    setBusy(s.id + Object.keys(change)[0]);
    const next = await act("setMcpServer", { id: s.id, ...change });
    setBusy(undefined);
    if (next) setServers(next);
  };

  const find = async () => {
    setFinding(true);
    const r = await act("findMcpServers", {});
    setFinding(false);
    if (!r) return;
    setServers(r.servers);
    setFound({ added: r.added, warnings: r.warnings });
  };

  return (
    <VStack gap={2}>
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <HStack gap={2} vAlign="center">
            <Heading level={3}>MCP servers</Heading>
            {servers && <Badge variant="neutral" label={String(servers.length)} />}
          </HStack>
        </StackItem>
        <Button label="Find servers" size="sm" isLoading={finding} onClick={find} />
      </HStack>
      <Text type="supporting" color="secondary">
        Every agent gets these: per session where the harness allows it, and in each harness's own settings for the CLIs. A server a harness already has stays as
        it is there.
      </Text>
      {found && (
        <Banner
          status={found.warnings.length ? "warning" : "success"}
          title={found.added.length ? `Found ${found.added.length === 1 ? "1 new server" : `${found.added.length} new servers`}: ${found.added.join(", ")}` : "No new servers"}
          description={found.warnings.join("\n") || undefined}
          collapsible={false}
          isDismissable
          onDismiss={() => setFound(undefined)}
        />
      )}
      {!servers ? (
        <Spinner size="sm" label="Loading MCP servers…" />
      ) : !servers.length ? (
        <EmptyState title="No MCP servers yet" description="Find the ones your harnesses already use, or paste one below." isCompact />
      ) : (
        <List density="compact" hasDividers>
          {servers.map((s) => (
            <ListItem
              key={s.id}
              label={s.name}
              description={
                <VStack gap={1}>
                  <Text type="supporting" color="secondary" maxLines={2} style={{ wordBreak: "break-all" }}>
                    {s.summary}
                  </Text>
                  <HStack gap={1} vAlign="center" wrap="wrap">
                    <Token size="sm" label={TYPE_LABEL[s.type]} />
                    <Token size="sm" label={scopeLabel(s.scope)} />
                    {[...s.envKeys, ...s.headerKeys].length > 0 && (
                      <Tooltip content={[...s.envKeys, ...s.headerKeys].join(", ")} hasHoverIndication={false}>
                        <Token size="sm" label={`${s.envKeys.length + s.headerKeys.length} secret${s.envKeys.length + s.headerKeys.length === 1 ? "" : "s"}`} />
                      </Tooltip>
                    )}
                    <Delivery s={s} />
                  </HStack>
                </VStack>
              }
              endContent={
                <HStack gap={narrow ? 2 : 3} vAlign="center">
                  <Switch label="Trusted" description={narrow ? undefined : "No approval"} value={s.trusted} isLoading={busy === s.id + "trusted"} isDisabled={!!busy} onChange={(v) => set(s, { trusted: v })} />
                  <Switch label={`Use ${s.name}`} isLabelHidden value={s.enabled} isLoading={busy === s.id + "enabled"} isDisabled={!!busy} onChange={(v) => set(s, { enabled: v })} />
                  <Button
                    label={`Delete ${s.name}`}
                    variant="ghost"
                    size="sm"
                    icon={<Icon icon={TrashIcon} size="sm" />}
                    isIconOnly
                    isLoading={busy === s.id + "remove"}
                    isDisabled={!!busy}
                    onClick={() => set(s, { remove: true })}
                  />
                </HStack>
              }
            />
          ))}
        </List>
      )}
      <AddServer projects={projects.map((p) => ({ path: p.path, name: p.name }))} onAdded={setServers} />
    </VStack>
  );
}

/** The harnesses that got it (a badge each, with how in its tooltip); the rest behind one "Not in" token. */
function Delivery({ s }: { s: McpServerView }) {
  const got = s.delivery.filter((d) => d.how !== "none");
  const not = s.delivery.filter((d) => d.how === "none");
  if (!s.enabled) return null;
  return (
    <>
      {got.map((d) => (
        <Tooltip key={d.harness} content={`${harnessLabel(d.harness)}: ${d.note}`} hasHoverIndication={false}>
          <HarnessBadge harness={d.harness} />
        </Tooltip>
      ))}
      {not.length > 0 && (
        <Tooltip content={not.map((d) => `${harnessLabel(d.harness)}: ${d.note}`).join("\n")} hasHoverIndication={false}>
          <Token size="sm" label={`Not in ${not.map((d) => harnessLabel(d.harness)).join(", ")}`} />
        </Tooltip>
      )}
      {s.sources.length > 0 && (
        <Tooltip content={s.sources.map((x) => (x === "you" ? "Added by you" : x.slice(x.indexOf(":") + 1))).join("\n")} hasHoverIndication={false}>
          <Text type="supporting" color="secondary">
            {s.sources.includes("you") ? "Added by you" : `From ${[...new Set(s.sources.map((x) => (x.startsWith("repo:") ? ".mcp.json" : sourceLabel(x))))].join(", ")}`}
          </Text>
        </Tooltip>
      )}
    </>
  );
}

function AddServer({ projects, onAdded }: { projects: { path: string; name: string }[]; onAdded: (s: McpServerView[]) => void }) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState("global");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      onAdded(await rpc("addMcpServer", { text, name: name.trim() || undefined, scope }));
      setText("");
      setName("");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <VStack gap={2} paddingBlockStart={2}>
      <TextArea
        label="Add a server"
        description="Paste a command (npx -y @modelcontextprotocol/server-github), a URL, or JSON from any harness's MCP settings"
        rows={3}
        value={text}
        onChange={(v) => {
          setText(v);
          setError(undefined);
        }}
        status={error ? { type: "error", message: error } : undefined}
        statusVariant="detached"
      />
      <HStack gap={2} vAlign="end" wrap="wrap">
        <TextInput label="Name" size="sm" placeholder="From the command" value={name} onChange={setName} />
        <Selector
          label="For"
          size="sm"
          value={scope}
          options={[{ value: "global", label: "Every project" }, ...projects.map((p) => ({ value: p.path, label: p.name, description: p.path }))]}
          onChange={setScope}
        />
        <Button label="Add" variant="primary" size="sm" isLoading={busy} isDisabled={!text.trim()} onClick={add} />
      </HStack>
    </VStack>
  );
}
