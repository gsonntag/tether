import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { ComputerDesktopIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { HARNESS_LABELS } from "../../../shared/transcript";
import { rpc } from "../connection";
import type { KnownRunner } from "../runners";
import { forgetRunner, useStore } from "../store";
import { RunnerDot, runnerStatus } from "./RunnerStatus";
import { useNow } from "./useNow";

export function Home() {
  const runners = useStore((s) => s.runners);
  const linkOpen = useStore((s) => s.link === "open");

  return (
    <Layout
      height="fill"
      contentWidth={768}
      content={
        <LayoutContent padding={6}>
          <VStack gap={4}>
            <Heading level={1}>Runners</Heading>
            {runners.length === 0 ? (
              <EmptyState
                icon={<Icon icon={ComputerDesktopIcon} size="lg" />}
                title={linkOpen ? "No runner has connected yet" : "Connecting…"}
                description={linkOpen ? "Start the runner on a machine with TETHER_URL and TETHER_TOKEN set, and it shows up here." : undefined}
              />
            ) : (
              <List hasDividers>
                {runners.map((r) => (
                  <RunnerRow key={r.id} runner={r} linkOpen={linkOpen} />
                ))}
              </List>
            )}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function RunnerRow({ runner, linkOpen }: { runner: KnownRunner; linkOpen: boolean }) {
  const now = useNow();
  const [check, setCheck] = useState<string>();
  // A ping result describes one connection; it means nothing after a reconnect or a drop.
  const conn = `${runner.online && linkOpen}:${runner.connectedAt}`;
  const [checkedConn, setCheckedConn] = useState(conn);
  if (checkedConn !== conn) {
    setCheckedConn(conn);
    setCheck(undefined);
  }
  const status = runnerStatus(runner, linkOpen, now);
  const harnesses = runner.harnesses.map((h) => `${HARNESS_LABELS[h.id] ?? h.id} ${h.version}`).join(" · ") || "No harnesses found";
  const host = runner.hostname !== runner.id ? `${runner.hostname} · ` : "";

  const ping = async () => {
    const t0 = performance.now();
    try {
      await rpc(runner.id, "ping", {});
      setCheck(`Answered in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      setCheck((e as Error).message);
    }
  };

  return (
    <ListItem
      label={runner.id}
      startContent={<RunnerDot runner={runner} now={now} />}
      description={
        <VStack gap={0.5}>
          <Text type="supporting" display="block" maxLines={1}>
            {[status.label, check].filter(Boolean).join(" · ")}
          </Text>
          <Text type="supporting" display="block" maxLines={1}>
            {host + harnesses}
          </Text>
        </VStack>
      }
      endContent={
        !linkOpen ? undefined : runner.online ? (
          <Button label="Ping" size="sm" variant="secondary" clickAction={ping} />
        ) : (
          <IconButton label={`Forget ${runner.id}`} tooltip="Forget" size="sm" variant="ghost" icon={<Icon icon={XMarkIcon} />} onClick={() => forgetRunner(runner.id)} />
        )
      }
    />
  );
}
