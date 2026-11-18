import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkBadge } from "./FileTree";
import { PathRow } from "./PathRow";

test("a changed row says its mark in words; a deleted one stays focusable but disabled; a folder shows as one", () => {
  const mod = renderToStaticMarkup(<PathRow path="src/a.ts" mark="modified" onOpen={() => {}} />);
  expect(mod).toContain('aria-label="src/a.ts, modified"');
  expect(mod).toContain('class="t-dstatus modified" aria-hidden="true">M<');
  expect(mod).not.toContain("disabled");
  const del = renderToStaticMarkup(<PathRow path="gone.ts" mark="deleted" />);
  expect(del).toContain('aria-disabled="true"');
  expect(del).not.toMatch(/ disabled=/);
  expect(renderToStaticMarkup(<PathRow path="vendor" mark="untracked" folder onOpen={() => {}} />)).toContain('aria-label="vendor (folder), untracked"');
  expect(renderToStaticMarkup(<PathRow path="plain.ts" onOpen={() => {}} />)).not.toContain("aria-label");
  expect(renderToStaticMarkup(<MarkBadge mark="conflict" />)).toContain(">C<");
});
