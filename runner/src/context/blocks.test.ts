import "./testenv";
import { describe, expect, test } from "bun:test";
import { BEGIN, END, blockContent, outsideBlock, upsertBlock, upsertTomlBlock } from "./blocks";

const USER = "# Global Guidance\n\n## Skills\n\n- grill-me: interviews\n";

describe("managed blocks", () => {
  test("inserted at the end of the user's text, after a blank line", () => {
    const out = upsertBlock(USER, "@~/.config/tether/context/exports/global.md");
    expect(out).toBe(`${USER}\n${BEGIN}\n@~/.config/tether/context/exports/global.md\n${END}\n`);
    expect(out.startsWith(USER)).toBe(true);
  });

  test("into an empty file", () => {
    expect(upsertBlock("", "x")).toBe(`${BEGIN}\nx\n${END}\n`);
  });

  test("updated in place; the user's text before and after is kept byte for byte", () => {
    const before = "my intro\n\n";
    const after = "\n\nmy outro\n  indented\n";
    const text = `${before}${BEGIN}\nold digest\n${END}${after}`;
    const out = upsertBlock(text, "new digest");
    expect(out).toBe(`${before}${BEGIN}\nnew digest\n${END}${after}`);
    expect(blockContent(out)).toBe("new digest");
    expect(upsertBlock(out, "new digest")).toBe(out); // idempotent
  });

  test("user edits outside the block survive an update", () => {
    let text = upsertBlock(USER, "v1");
    text = "added on top by the user\n" + text + "and at the bottom\n";
    const out = upsertBlock(text, "v2");
    expect(out.startsWith("added on top by the user\n" + USER)).toBe(true);
    expect(out.endsWith("and at the bottom\n")).toBe(true);
    expect(blockContent(out)).toBe("v2");
  });

  test("outsideBlock is what importers read; it undoes an insert", () => {
    expect(outsideBlock(upsertBlock(USER, "digest"))).toBe(USER);
    expect(outsideBlock(USER)).toBe(USER);
    expect(outsideBlock(`a\n\n${BEGIN}\nx\n${END}\n\nb\n`)).toBe("a\n\nb\n");
  });

  test("removing the block restores the user's file", () => {
    expect(upsertBlock(upsertBlock(USER, "digest"), undefined)).toBe(USER);
  });

  test("markers written by a hand-edited begin line are still found", () => {
    const text = `x\n<!-- tether:begin -->\nold\n<!-- tether:end -->\n`;
    expect(upsertBlock(text, "new")).toBe(`x\n${BEGIN}\nnew\n${END}\n`);
  });

  test("TOML blocks for codex config.toml", () => {
    const cfg = 'model = "gpt"\n\n[profiles.x]\nmodel = "y"\n';
    const once = upsertTomlBlock(cfg, "[mcp_servers.tether-context]\ncommand = \"bun\"");
    expect(once.startsWith(cfg)).toBe(true);
    expect(once).toContain("# tether:begin");
    const twice = upsertTomlBlock(once, "[mcp_servers.tether-context]\ncommand = \"bun2\"");
    expect(twice.match(/tether:begin/g)!.length).toBe(1);
    expect(twice).toContain('command = "bun2"');
    expect(twice.startsWith(cfg)).toBe(true);
  });

  test("a begin marker without an end marker never swallows the user's text", () => {
    const text = `intro\n\n${BEGIN}\nold digest\n\n## My own section\nprecious notes\n`;
    const out = upsertBlock(text, "new");
    expect(out).toContain("## My own section\nprecious notes\n");
    expect(out).toContain(`${BEGIN}\nnew\n${END}`);
    expect(outsideBlock(text)).toContain("precious notes");
    expect(upsertBlock(text, undefined)).toContain("precious notes");
  });

  test("the user's trailing whitespace is kept while the block is there, and removal is exact", () => {
    for (const user of ["a\n", "a\n\n\n", "# T\n\nbody\n", ""]) {
      const withBlock = upsertBlock(user, "digest");
      expect(withBlock.startsWith(user)).toBe(true);
      expect(upsertBlock(withBlock, undefined)).toBe(user);
      expect(outsideBlock(withBlock)).toBe(user);
    }
  });

  test("TOML: missing end marker keeps the rest of the config; removal restores it", () => {
    const cfg = 'model = "gpt"\n\n[profiles.x]\nmodel = "y"\n';
    const broken = `${cfg}\n# tether:begin (managed)\n[mcp_servers.tether-context]\ncommand = "bun"\n\n[user.table]\nkeep = true\n`;
    const out = upsertTomlBlock(broken, '[mcp_servers.tether-context]\ncommand = "bun2"');
    expect(out).toContain("[user.table]\nkeep = true");
    expect(upsertTomlBlock(upsertTomlBlock(cfg, "x = 1"), undefined)).toBe(cfg);
  });
});
