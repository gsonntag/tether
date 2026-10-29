import { expect, test } from "bun:test";
import { codexMode, modelList, modeOf, sandboxPolicy } from "./modes";

test("permission presets: human labels, and a thread's settings read back as one", () => {
  expect(modeOf("untrusted", { type: "workspaceWrite" })).toBe("untrusted");
  expect(modeOf("on-request", "workspace-write")).toBe("auto");
  expect(modeOf("never", { type: "dangerFullAccess" })).toBe("full-access");
  expect(modeOf("on-request", { type: "readOnly" })).toBe("read-only");
  expect(modeOf("never", { type: "readOnly" })).toBeUndefined();
  expect(codexMode("nonsense")).toEqual(codexMode("auto"));
  expect(sandboxPolicy("read-only")).toEqual({ type: "readOnly", networkAccess: false });
});

test("model/list as the picker: the default first, efforts in order with labels", () => {
  const l = modelList([
    { id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "xhigh" }] },
    { id: "gpt-6-luna", displayName: "GPT-6-Luna", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "low" }] },
    { id: "hidden", hidden: true },
  ]);
  expect(l.models.map((m) => [m.id, m.label])).toEqual([
    ["default", "Default (GPT-6.1-Sol)"],
    ["gpt-6.1-sol", "GPT-6.1-Sol"],
    ["gpt-6-luna", "GPT-6-Luna"],
  ]);
  expect(l.efforts).toEqual([
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "xhigh", label: "Extra high" },
  ]);
  expect(l.permissionModes.map((m) => m.label)).toEqual(["Read only", "Ask first", "Auto", "Full access"]);
});
