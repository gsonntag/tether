import "./testenv";
import { describe, expect, test } from "bun:test";
import { contentHash, parseMemory, serializeMemory, slugify, splitFrontMatter, type Memory } from "./format";

describe("memory file format", () => {
  test("Claude's newer format: type under metadata", () => {
    const m = parseMemory(`---
name: hosts-prod-dev-split
description: Owner decision — stay on the single Oracle VPS
metadata:
  type: project
---

Body line one.

- bullet
`);
    expect(m.name).toBe("hosts-prod-dev-split");
    expect(m.description).toBe("Owner decision — stay on the single Oracle VPS");
    expect(m.type).toBe("project");
    expect(m.body).toBe("Body line one.\n\n- bullet");
    expect(m.scope).toBe("global");
    expect(m.sources).toEqual([]);
  });

  test("Claude's older format: top-level type", () => {
    const m = parseMemory(`---\nname: ui-style\ndescription: plain headings\ntype: feedback\n---\nNo subtext.`);
    expect(m.type).toBe("feedback");
    expect(m.body).toBe("No subtext.");
  });

  test("Tether fields: scope, inline and dash source lists, quoted values", () => {
    const inline = parseMemory(`---
name: x
description: "a: quoted, value"
type: user
scope: repo:github.com/foo/bar
sources: [claude:~/.claude/projects/-home-u-x/memory/x.md, "codex:memories#42"]
updated: 2026-10-10T12:00:00Z
---
body`);
    expect(inline.description).toBe("a: quoted, value");
    expect(inline.scope).toBe("repo:github.com/foo/bar");
    expect(inline.sources).toEqual(["claude:~/.claude/projects/-home-u-x/memory/x.md", "codex:memories#42"]);
    expect(inline.updated).toBe("2026-10-10T12:00:00Z");
    const dashed = parseMemory(`---\nname: y\nsources:\n  - a\n  - "b, c"\ntype: reference\n---\nz`);
    expect(dashed.sources).toEqual(["a", "b, c"]);
    expect(dashed.type).toBe("reference");
  });

  test("no front matter: all body, defaults filled in", () => {
    const m = parseMemory("# Prefer bun\n\nUse bun, not npm.", { scope: "global" });
    expect(m.body).toBe("# Prefer bun\n\nUse bun, not npm.");
    expect(m.name).toBe("prefer-bun");
    expect(m.description).toBe("Prefer bun");
    expect(m.type).toBe("project");
  });

  test("unknown type falls back; CRLF and BOM are handled", () => {
    const m = parseMemory("﻿---\r\nname: a\r\ntype: weird\r\n---\r\nhi\r\n", { type: "feedback" });
    expect(m.type).toBe("feedback");
    expect(m.body).toBe("hi");
  });

  test("serialize → parse round-trips", () => {
    const m: Memory = {
      name: "my-fact",
      description: "has: a colon, and #hash",
      type: "feedback",
      scope: "repo:/home/u/proj",
      sources: ["claude:~/a.md", "mcp:claude-code:abc", "weird, one"],
      updated: "2026-10-10T12:00:00.000Z",
      body: "Line\n\n[[other-slug]]",
    };
    const text = serializeMemory(m);
    expect(parseMemory(text)).toEqual(m);
    expect(splitFrontMatter(text).hasFrontMatter).toBe(true);
  });

  test("slugs and content hashes", () => {
    expect(slugify("Prefer Bün over npm!")).toBe("prefer-bun-over-npm");
    expect(slugify("---")).toBeUndefined();
    expect(contentHash("A  b\n c")).toBe(contentHash("a b c"));
  });
});
