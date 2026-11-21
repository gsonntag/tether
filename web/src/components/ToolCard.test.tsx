import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolPart } from "../../../shared/transcript";
import { summary, ToolCard } from "./ToolCard";

(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;

test("task tool summary formats readable role/TypeName and prompt start for invoke_subagent", () => {
  // Direct description takes precedence
  const withDesc: ToolPart = {
    type: "tool",
    id: "t1",
    name: "invoke_subagent",
    kind: "task",
    status: "done",
    input: { description: "Worker · Run command" },
  };
  expect(summary(withDesc)).toBe("Worker · Run command");

  // Raw Antigravity invoke_subagent shape with TypeName and multi-line Prompt
  const agySubagent: ToolPart = {
    type: "tool",
    id: "t2",
    name: "invoke_subagent",
    kind: "task",
    status: "running",
    input: {
      raw: {
        TypeName: "self",
        Prompt: "sleep 40; echo from-child > child-proof.txt\nand more details later",
      },
    },
  };
  expect(summary(agySubagent)).toBe("self · sleep 40; echo from-child > child-proof.txt");

  // Raw Antigravity invoke_subagent shape with Role and TypeName
  const withRole: ToolPart = {
    type: "tool",
    id: "t3",
    name: "invoke_subagent",
    kind: "task",
    status: "done",
    input: {
      raw: {
        Role: "Codebase Researcher",
        TypeName: "research",
        Prompt: "Search codebase for issue 139",
      },
    },
  };
  expect(summary(withRole)).toBe("Codebase Researcher · Search codebase for issue 139");

  // Only prompt
  const promptOnly: ToolPart = {
    type: "tool",
    id: "t4",
    name: "invoke_subagent",
    kind: "task",
    status: "done",
    input: {
      raw: {
        Prompt: "Investigate performance regression",
      },
    },
  };
  expect(summary(promptOnly)).toBe("Investigate performance regression");
});

test("ToolCard renders Open transcript link and readable summary for Antigravity subagent task card", () => {
  const part: ToolPart = {
    type: "tool",
    id: "call_sub_1",
    name: "invoke_subagent",
    kind: "task",
    childSessionId: "antigravity:child-uuid-1",
    status: "running",
    input: {
      description: "self · sleep 40; echo from-child",
      prompt: "sleep 40; echo from-child",
      subagent_type: "self",
      raw: {
        TypeName: "self",
        Prompt: "sleep 40; echo from-child",
      },
    },
  };

  const html = renderToStaticMarkup(<ToolCard part={part} />);
  expect(html).toContain("Open the subagent&#x27;s transcript");
  expect(html).toContain("self · sleep 40; echo from-child");
  expect(html).not.toContain("&quot;TypeName&quot;");
  expect(html).not.toContain("{&quot;raw&quot;");
});
