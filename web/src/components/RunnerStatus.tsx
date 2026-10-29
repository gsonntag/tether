import { StatusDot } from "@astryxdesign/core/StatusDot";
import { PROTOCOL_VERSION } from "../../../shared/protocol";
import { ago, type KnownRunner } from "../runners";
import { useStore } from "../store";

/** What we can say about a runner: nothing for sure while the server link itself is down. */
export function runnerStatus(r: KnownRunner, linkOpen: boolean, now: number): { variant: "success" | "neutral" | "warning"; label: string } {
  if (!linkOpen) return { variant: "neutral", label: "Waiting for the server" };
  if (!r.online) return { variant: "neutral", label: `Disconnected · last seen ${ago(r.lastSeen, now)}` };
  if (r.protocol !== PROTOCOL_VERSION) return { variant: "warning", label: "Connected · needs an update" };
  return { variant: "success", label: "Connected" };
}

export function RunnerDot({ runner, now }: { runner: KnownRunner; now: number }) {
  const open = useStore((s) => s.link === "open");
  const st = runnerStatus(runner, open, now);
  return <StatusDot variant={st.variant} label={st.label} tooltip={st.label} />;
}
