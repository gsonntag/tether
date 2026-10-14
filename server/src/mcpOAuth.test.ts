import { describe, expect, test } from "bun:test";
import { callbackPage, runnerOfState } from "./mcpOAuth";

describe("MCP OAuth callback", () => {
  test("the state names its runner; anything else names none", () => {
    const state = `${Buffer.from("runner-a.home").toString("base64url")}.abc123`;
    expect(runnerOfState(state)).toBe("runner-a.home");
    expect(runnerOfState("nodot")).toBeUndefined();
    expect(runnerOfState(".x")).toBeUndefined();
  });

  test("the page escapes what it shows and is never cached or framed", async () => {
    const r = callbackPage(200, "Connected to <img src=x>", "You can close this tab.", '"</script><script>alert(1)//');
    const html = await r.text();
    expect(html).not.toContain("<img");
    expect(html).not.toContain("</script><script>alert");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});
