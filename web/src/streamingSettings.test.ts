import { describe, expect, it } from "bun:test";
import { formatRoute, parseRoute } from "./route";
import {
  loadStreamingAnimationSetting,
  saveStreamingAnimationSetting,
  shouldAnimateStreaming,
  STREAMING_ANIMATION_KEY,
  STREAMING_ANIMATION_THRESHOLD,
  type StreamingAnimationSetting,
} from "./streamingSettings";

function createMockStorage(initial?: Record<string, string>): Storage {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("streamingSettings", () => {
  it("defaults to 'auto' when storage is empty", () => {
    const store = createMockStorage();
    expect(loadStreamingAnimationSetting(store)).toBe("auto");
  });

  it("defaults to 'auto' when storage contains invalid value", () => {
    const store = createMockStorage({ [STREAMING_ANIMATION_KEY]: "invalid" });
    expect(loadStreamingAnimationSetting(store)).toBe("auto");
  });

  it("loads 'on', 'off', and 'auto' settings", () => {
    const storeOn = createMockStorage({ [STREAMING_ANIMATION_KEY]: "on" });
    expect(loadStreamingAnimationSetting(storeOn)).toBe("on");

    const storeOff = createMockStorage({ [STREAMING_ANIMATION_KEY]: "off" });
    expect(loadStreamingAnimationSetting(storeOff)).toBe("off");

    const storeAuto = createMockStorage({ [STREAMING_ANIMATION_KEY]: "auto" });
    expect(loadStreamingAnimationSetting(storeAuto)).toBe("auto");
  });

  it("saves setting to storage", () => {
    const store = createMockStorage();
    saveStreamingAnimationSetting("off", store);
    expect(store.getItem(STREAMING_ANIMATION_KEY)).toBe("off");

    saveStreamingAnimationSetting("on", store);
    expect(store.getItem(STREAMING_ANIMATION_KEY)).toBe("on");

    saveStreamingAnimationSetting("auto", store);
    expect(store.getItem(STREAMING_ANIMATION_KEY)).toBe("auto");
  });

  describe("shouldAnimateStreaming", () => {
    it("always returns true when setting is 'on'", () => {
      expect(shouldAnimateStreaming("on", 0)).toBe(true);
      expect(shouldAnimateStreaming("on", 500)).toBe(true);
      expect(shouldAnimateStreaming("on", STREAMING_ANIMATION_THRESHOLD)).toBe(true);
      expect(shouldAnimateStreaming("on", STREAMING_ANIMATION_THRESHOLD + 1)).toBe(true);
      expect(shouldAnimateStreaming("on", 5000)).toBe(true);
    });

    it("always returns false when setting is 'off'", () => {
      expect(shouldAnimateStreaming("off", 0)).toBe(false);
      expect(shouldAnimateStreaming("off", 500)).toBe(false);
      expect(shouldAnimateStreaming("off", STREAMING_ANIMATION_THRESHOLD)).toBe(false);
      expect(shouldAnimateStreaming("off", STREAMING_ANIMATION_THRESHOLD + 1)).toBe(false);
      expect(shouldAnimateStreaming("off", 5000)).toBe(false);
    });

    it("returns true for <= threshold and false for > threshold when setting is 'auto'", () => {
      expect(shouldAnimateStreaming("auto", 0)).toBe(true);
      expect(shouldAnimateStreaming("auto", 100)).toBe(true);
      expect(shouldAnimateStreaming("auto", STREAMING_ANIMATION_THRESHOLD)).toBe(true);
      expect(shouldAnimateStreaming("auto", STREAMING_ANIMATION_THRESHOLD + 1)).toBe(false);
      expect(shouldAnimateStreaming("auto", 3000)).toBe(false);
    });

    it("supports custom threshold", () => {
      expect(shouldAnimateStreaming("auto", 50, 50)).toBe(true);
      expect(shouldAnimateStreaming("auto", 51, 50)).toBe(false);
    });
  });

  describe("route parsing and formatting", () => {
    it("parses and formats display settings route", () => {
      expect(parseRoute("#/settings/display")).toEqual({ page: "display" });
      expect(parseRoute("#/settings/appearance")).toEqual({ page: "display" });
      expect(parseRoute("#/display")).toEqual({ page: "display" });
      expect(formatRoute({ page: "display" })).toBe("#/settings/display");
    });
  });
});
