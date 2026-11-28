(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountSource } from "../../../shared/credentials";
import type { HarnessAccount } from "../../../shared/harnessLogin";

const { HarnessLogin } = await import("./HarnessLogin");

const acc: AccountSource = "account:3f2a9c1e-1111-4222-8333-444444444444";

test("HarnessLogin status span does not repeat displayName (G8, G11')", () => {
  const extra: HarnessAccount = {
    source: acc,
    available: true,
    probe: "signedIn",
    status: {
      state: "signedIn",
      displayName: "Work Account",
      email: "alice@co.test",
      organization: "Acme Corp",
      plan: "Max",
    },
  };
  const html = renderToStaticMarkup(<HarnessLogin runnerId="r1" harness="claude" extra={extra} />);
  expect(html.split("Work Account").length - 1).toBe(1);
  expect(html).toContain("alice@co.test · Max · Acme Corp");
});

test("HarnessLogin displays probe states accurately and falls back to Sign-in required on older runners (G11)", () => {
  const base = {
    source: acc,
    available: false,
    status: { state: "signedIn" as const, email: "alice@co.test" },
  };
  const signedOutHtml = renderToStaticMarkup(<HarnessLogin runnerId="r1" harness="claude" extra={{ ...base, probe: "signedOut" }} />);
  expect(signedOutHtml).toContain("Signed out");
  expect(signedOutHtml).not.toContain("Sign-in required");

  const unknownHtml = renderToStaticMarkup(<HarnessLogin runnerId="r1" harness="claude" extra={{ ...base, probe: "unknown" }} />);
  expect(unknownHtml).toContain("Status unavailable");
  expect(unknownHtml).not.toContain("Signed out");

  // Older runner omits `probe` with `available: false` -> "Sign-in required", never "Signed out".
  const olderHtml = renderToStaticMarkup(<HarnessLogin runnerId="r1" harness="claude" extra={base} />);
  expect(olderHtml).toContain("Sign-in required");
  expect(olderHtml).not.toContain("Signed out");
});
