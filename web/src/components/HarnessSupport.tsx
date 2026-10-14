// "Harness support" on the Memory & Skills page (Principle 3: one consistent picture): what each
// installed harness does natively, what Tether stands in for, and what isn't available, per
// feature, from the runner's connectors (harnessCapabilities). Read only; the note behind each cell
// says how, or why not.

import { useEffect, useState } from "react";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { VStack } from "@astryxdesign/core/Layout";
import { LEVEL, SLOT_LABEL, supportRows, type SupportRow } from "../harnessSupport";
import { HARNESSES, type HarnessCapabilities, type SlotCapability } from "../shared/protocol";
import { rpc, useStore } from "../store";

function Cell({ c }: { c?: SlotCapability }) {
  if (!c) return null;
  const l = LEVEL[c.level];
  return (
    <Tooltip content={c.note} hasHoverIndication={false}>
      <Token size="sm" label={l.label} color={l.color} />
    </Tooltip>
  );
}

export function HarnessSupport() {
  const runnerId = useStore((s) => s.runnerId);
  const runner = useStore((s) => s.runners.find((r) => r.id === s.runnerId));
  const [caps, setCaps] = useState<HarnessCapabilities | null>();

  useEffect(() => {
    setCaps(undefined);
    rpc("harnessCapabilities", {})
      .then(setCaps)
      .catch(() => setCaps(null));
  }, [runnerId]);

  if (caps === null) return null; // an older runner without the op
  const { harnesses, rows } = caps ? supportRows(caps, runner?.harnesses ?? HARNESSES.map((h) => h.id)) : { harnesses: [], rows: [] };
  const columns: TableColumn<SupportRow>[] = [
    { key: "slot", header: "Feature", width: pixel(150), renderCell: (r) => <Text type="label">{SLOT_LABEL[r.slot]}</Text> },
    ...harnesses.map(
      (h): TableColumn<SupportRow> => ({
        key: h,
        header: HARNESSES.find((x) => x.id === h)?.label ?? h,
        width: proportional(1),
        renderCell: (r) => <Cell c={caps?.[h]?.[r.slot]} />,
      }),
    ),
  ];

  return (
    <VStack gap={2}>
      <Heading level={3}>Harness support</Heading>
      <Text type="supporting" color="secondary">
        Native: the harness does it itself. Tether: Tether provides it for that harness. Hover a cell for how.
      </Text>
      {!caps ? <Spinner size="sm" label="Loading harness support…" /> : <Table data={rows} columns={columns} idKey="slot" density="compact" textOverflow="truncate" />}
    </VStack>
  );
}
