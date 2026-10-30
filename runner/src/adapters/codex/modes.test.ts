import { expect, test } from "bun:test";
import { codexMode, modelList, modeOf, sandboxPolicy } from "./modes";

test("permission presets: human labels, and a thread's settings read back as one", () => {
  expect(modeOf("untrusted", { type: "workspaceWrite" })).toBe("untrusted");
  expect(modeOf("on-request", "workspace-write")).toBe("auto");
  expect(modeOf("never", { type: "dangerFullAccess" })).toBe("full-access");
  expect(modeOf("on-request", { type: "readOnly" })).toBe("read-only");
  // A combination no preset has: kept as it is, and read back exactly.
  expect(modeOf("never", { type: "readOnly" })).toBe("never+read-only");
  expect(codexMode("never+read-only")).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
  // What Tether can't express (a granular policy object, an unknown policy): custom, never a preset.
  expect(modeOf({ granular: {} }, "read-only")).toBe("custom");
  expect(modeOf("granular", "read-only")).toBe("custom");
  expect(modeOf(undefined, "read-only")).toBeUndefined();
  // Codex's own reviewer ("Approve for me") is part of the mode.
  expect(modeOf("on-request", "workspace-write", "auto_review")).toBe("auto@codex-reviews");
  expect(modeOf("on-request", "workspace-write", "user")).toBe("auto");
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

test("a stored thread's settings from its rollout: the newest turn_context", async () => {
  const { rolloutSettings } = await import("./discovery");
  const ctx = (model: string, effort: string, policy: string, sandbox: string) => JSON.stringify({ type: "turn_context", payload: { model, effort, approval_policy: policy, sandbox_policy: { type: sandbox } } });
  const text = [ctx("gpt-6-sol", "high", "on-request", "workspace-write"), '{"type":"event_msg","payload":{}}', ctx("gpt-6-luna", "low", "on-request", "read-only"), '{"type":"response_item"}', "{partial"].join("\n");
  expect(rolloutSettings(text)).toEqual({ found: true, model: "gpt-6-luna", effort: "low", approvalPolicy: "on-request", sandbox: "read-only", mode: "read-only" });
  expect(rolloutSettings("")).toEqual({});
  expect(rolloutSettings(JSON.stringify({ type: "turn_context", payload: { approval_policy: "on-request", sandbox_policy: { type: "workspace-write" }, approvals_reviewer: "auto_review" } })).mode).toBe("auto@codex-reviews");
});

test("looser, by dimension (approval policy and sandbox), for any combination", async () => {
  const { looser } = await import("./modes");
  expect(looser({ approvalPolicy: "never", sandbox: "read-only" }, { approvalPolicy: "on-request", sandbox: "read-only" })).toBe(true);
  expect(looser({ approvalPolicy: "on-request", sandbox: "workspace-write" }, { approvalPolicy: "on-request", sandbox: "read-only" })).toBe(true);
  expect(looser({ approvalPolicy: "untrusted", sandbox: "read-only" }, { approvalPolicy: "never", sandbox: "danger-full-access" })).toBe(false);
  expect(looser({ approvalPolicy: "on-request", sandbox: "read-only" }, { approvalPolicy: "on-request", sandbox: "read-only" })).toBe(false);
});
