import { useSyncExternalStore } from "react";

export type StreamingAnimationSetting = "auto" | "on" | "off";

export const STREAMING_ANIMATION_KEY = "tether.streamingAnimation";
export const STREAMING_ANIMATION_THRESHOLD = 1000;

export function loadStreamingAnimationSetting(store?: Storage): StreamingAnimationSetting {
  try {
    const s = store ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    const val = s?.getItem(STREAMING_ANIMATION_KEY);
    if (val === "on" || val === "off" || val === "auto") return val;
    return "auto";
  } catch {
    return "auto";
  }
}

export function saveStreamingAnimationSetting(setting: StreamingAnimationSetting, store?: Storage): void {
  try {
    const s = store ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    s?.setItem(STREAMING_ANIMATION_KEY, setting);
  } catch {}
  notify();
}

export function shouldAnimateStreaming(
  setting: StreamingAnimationSetting,
  loadedMessagesCount: number,
  threshold = STREAMING_ANIMATION_THRESHOLD,
): boolean {
  if (setting === "on") return true;
  if (setting === "off") return false;
  return loadedMessagesCount <= threshold;
}

const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  const handleStorage = (e: StorageEvent) => {
    if (!e.key || e.key === STREAMING_ANIMATION_KEY) callback();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", handleStorage);
  }
  return () => {
    listeners.delete(callback);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", handleStorage);
    }
  };
}

export function useStreamingAnimationSetting(): [
  StreamingAnimationSetting,
  (setting: StreamingAnimationSetting) => void,
] {
  const setting = useSyncExternalStore<StreamingAnimationSetting>(
    subscribe,
    () => loadStreamingAnimationSetting(),
    () => "auto",
  );
  return [setting, saveStreamingAnimationSetting];
}
