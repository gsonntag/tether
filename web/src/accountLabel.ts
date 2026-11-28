import { useEffect, useState } from "react";
import type { BillingSource } from "../../shared/credentials";
import type { HarnessAccount } from "../../shared/harnessLogin";
import type { HarnessId } from "../../shared/transcript";
import { resolveAccountLabels, type AccountLabelEntry } from "./accountLabels";
import { rpc } from "./connection";
import { accessOf } from "./runners";
import { useStore } from "./store";

interface CachedAccounts {
  labels: Partial<Record<BillingSource, string>>;
  entries: Partial<Record<BillingSource, AccountLabelEntry>>;
  probes: Partial<Record<BillingSource, HarnessAccount["probe"]>>;
}

const cache = new Map<string, CachedAccounts>();
const inFlight = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  for (const fn of listeners.get(key) ?? []) fn();
}

function subscribe(key: string, fn: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) listeners.delete(key);
  };
}

function fetchAccountLabels(
  runnerId: string,
  harness: HarnessId,
  force = false,
  callRpc: typeof rpc = rpc,
): Promise<void> {
  const key = `${runnerId}\0${harness}`;
  if (!force && inFlight.has(key)) return inFlight.get(key)!;
  const run = Promise.all([
    callRpc(runnerId, "harnessLoginStatus", { harness }).catch(() => undefined),
    harness === "claude" ? callRpc(runnerId, "listHarnessAccounts", { harness }).catch(() => []) : Promise.resolve([]),
  ]).then(([status, accounts]) => {
    const items = [
      ...(status ? [{ source: "subscription" as BillingSource, status }] : []),
      ...accounts.map((a) => ({
        source: a.source as BillingSource,
        status: a.status,
        available: a.available,
        probe: a.probe,
        managedBy: a.managedBy,
        hint: a.hint,
      })),
    ];
    cache.set(key, resolveAccountLabels(items));
    notify(key);
  }).finally(() => {
    if (inFlight.get(key) === run) inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

/** Invalidates cached account labels for a runner/harness after login, logout, or rename. */
export function invalidateAccountLabelCache(runnerId: string, harness: HarnessId) {
  const key = `${runnerId}\0${harness}`;
  cache.delete(key);
  inFlight.delete(key);
  notify(key);
}

/** Tests: reset module-level account label cache. */
export function clearAccountLabelCache() {
  cache.clear();
  inFlight.clear();
}

/** Test/internal: directly invoke the deduplicated loader (used by hook and tests). */
export function loadAccountLabels(
  runnerId: string,
  harness: HarnessId,
  force = false,
  callRpc: typeof rpc = rpc,
): Promise<void> {
  return fetchAccountLabels(runnerId, harness, force, callRpc);
}

/** Tests: seed module-level cache for static render tests. */
export function seedAccountLabelCache(runnerId: string, harness: HarnessId, value: CachedAccounts) {
  const key = `${runnerId}\0${harness}`;
  cache.set(key, value);
  notify(key);
}

/**
 * Read account details through the owner-only op, separate from the shared billing sources.
 * Cached per (runnerId, harness) with in-flight deduplication so SessionHeader, BillingChip,
 * and dialogs don't each spawn duplicate `claude auth status` probes (G8).
 */
export function useAccountLabel(runnerId: string | undefined, harness: HarnessId, wanted: boolean) {
  const reactiveLink = useStore((s) => s.link);
  const reactiveRunner = useStore((s) => s.runners.find((r) => r.id === runnerId));
  // Under renderToStaticMarkup (unit tests without DOM), Zustand's server snapshot returns initial state;
  // fall back to live getState() only when there is no real DOM so SSR tests can seed useStore.
  const hasDom = typeof document !== "undefined" && typeof document.createElement === "function";
  const live = hasDom ? undefined : useStore.getState();
  const link = live ? live.link : reactiveLink;
  const runner = live ? live.runners.find((r) => r.id === runnerId) : reactiveRunner;
  const allowed = wanted && link === "open" && !!runner?.online && accessOf(runner) === "manage";
  const key = runnerId ? `${runnerId}\0${harness}` : "";
  const [, tick] = useState(0);

  useEffect(() => {
    if (!allowed || !runnerId || !key) return;
    const unsub = subscribe(key, () => tick((n) => n + 1));
    if (!cache.has(key)) void fetchAccountLabels(runnerId, harness, false);
    return unsub;
  }, [allowed, runnerId, harness, key]);

  const data = allowed && key ? cache.get(key) : undefined;
  return {
    label: data?.labels.subscription,
    labels: data?.labels,
    entries: data?.entries,
    probes: data?.probes,
    refresh: () => {
      if (allowed && runnerId) void fetchAccountLabels(runnerId, harness, true);
    },
  };
}
