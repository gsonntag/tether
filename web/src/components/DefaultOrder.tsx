// The default order: one ordered list of models (each on its harness) that new sessions and
// subagents start on and fall back along at usage limits. Edited in Settings and, until one is
// saved, from a setup card on Home (pre-filled from what's installed and signed in on the runner).

import { useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { cleanOrder } from "../shared/defaultOrder";
import { rpc, saveDefaultOrder, useStore } from "../store";
import { ChainEditor } from "./ChainEditor";

/** Why it's worth setting, in one line (the Home card, the editor). */
export const ORDER_WHY = "New sessions start on the first model and move down the list when one hits its usage limit.";

const same = (a: string[], b: string[]) => JSON.stringify(cleanOrder(a)) === JSON.stringify(cleanOrder(b));

/**
 * The order being edited: the saved one, or (none saved) the runner's suggestion. `saved` is
 * undefined until the runner answers, null while none is saved.
 */
export function useOrderDraft() {
  const saved = useStore((s) => s.defaultOrder);
  const [draft, setDraft] = useState<string[]>();
  const [suggesting, setSuggesting] = useState(false);
  useEffect(() => {
    if (saved) {
      setDraft((d) => d ?? saved);
      return;
    }
    if (saved !== null || draft) return;
    setSuggesting(true);
    rpc("getDefaultOrder", { suggest: true })
      .then((r) => setDraft((d) => d ?? r.order ?? r.suggested ?? []))
      .catch(() => setDraft((d) => d ?? []))
      .finally(() => setSuggesting(false));
  }, [saved]);
  return { saved, draft: draft ?? [], setDraft, suggesting, loaded: draft !== undefined };
}

/** The chain editor over a draft, with a note while the suggestion loads or when it's empty. */
export function OrderDraftEditor({ draft, setDraft, suggesting }: { draft: string[]; setDraft: (o: string[]) => void; suggesting: boolean }) {
  if (suggesting) return <Spinner size="sm" label="Looking at what's signed in…" />;
  return <ChainEditor chain={draft} onChange={setDraft} />;
}

/**
 * Settings: the saved order saves itself a moment after each edit (closing saves at once). None
 * saved yet: the suggestion shows with a Save button.
 */
export function DefaultOrderSettings() {
  const { saved, draft, setDraft, suggesting, loaded } = useOrderDraft();
  const [busy, setBusy] = useState(false);
  const pending = useRef<string[]>(undefined);
  const flush = () => {
    const p = pending.current;
    pending.current = undefined;
    if (p) void saveDefaultOrder(p);
  };
  useEffect(() => {
    pending.current = saved && cleanOrder(draft).length && !same(draft, saved) ? draft : undefined;
    if (!pending.current) return;
    const t = setTimeout(flush, 600);
    return () => clearTimeout(t);
  }, [draft]);
  useEffect(() => flush, []);
  if (saved === undefined) return <Text type="supporting">This runner can't keep a default order yet: update it.</Text>;
  return (
    <VStack gap={2}>
      <OrderDraftEditor draft={draft} setDraft={setDraft} suggesting={suggesting} />
      {saved && !cleanOrder(draft).length && <Text type="supporting">Add a model to save it.</Text>}
      {!saved && loaded && (
        <HStack>
          <Button
            label="Save"
            variant="primary"
            size="sm"
            isLoading={busy}
            isDisabled={!cleanOrder(draft).length}
            onClick={async () => {
              setBusy(true);
              await saveDefaultOrder(draft);
              setBusy(false);
            }}
          />
        </HStack>
      )}
    </VStack>
  );
}

/** Home, while no default order is saved: one card that opens the editor. Gone once it's saved. */
export function DefaultOrderCard() {
  const saved = useStore((s) => s.defaultOrder);
  if (saved !== null) return null;
  return (
    <Banner
      status="info"
      container="section"
      collapsible={false}
      title="Set your default order"
      description={ORDER_WHY}
      endContent={<Button label="Set up" variant="primary" size="sm" onClick={() => useStore.setState({ dialog: "defaultOrder" })} />}
    />
  );
}
