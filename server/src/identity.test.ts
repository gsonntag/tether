import { expect, test } from "bun:test";
import { browserUser, type Viewer } from "./identity";

const viewer = (picture: string): Viewer => ({ id: "u", email: "me@x", name: "Me", role: "owner", service: false, picture });

test("a browser is told its Foliation picture", () => {
  const url = "https://foliation.dev/pictures/AbCdEfGhIjKlMnOpQrStUv";
  expect(browserUser(viewer(url))).toEqual({ name: "Me", email: "me@x", picture: url, role: "owner" });
});

test("no picture: the field is left out", () => {
  expect(browserUser(viewer(""))).toEqual({ name: "Me", email: "me@x", role: "owner" });
});

// Foliation's identity vectors (contracts/testdata/identity-vectors.json in the foliation repo,
// copied as is): every verifier must accept exactly the valid cases and refuse the rest, app user
// tokens (`tok`) included.
import { createLocalJWKSet } from "jose";
import { verifyIdentity } from "./identity";
import vectors from "./testdata/identity-vectors.json";

const keys = createLocalJWKSet(vectors.jwks as Parameters<typeof createLocalJWKSet>[0]);
for (const c of vectors.cases as { name: string; token: string; now: number; audience: string; issuer: string; expect: string; claims?: Record<string, unknown> }[]) {
  test(`identity vector: ${c.name} (${c.expect})`, async () => {
    const v = await verifyIdentity(c.token, keys, { issuer: c.issuer, audience: c.audience, currentDate: new Date(c.now * 1000) });
    if (c.expect !== "valid") return expect(v).toBeNull();
    expect(v).not.toBeNull();
    expect(v!.id).toBe(c.claims!.sub as string);
    expect(v!.role).toBe(c.claims!.role as string);
    expect(!!v!.token).toBe(c.claims!.tok === true);
    expect(!!v!.guest).toBe(c.claims!.pub === true || c.claims!.anon === true || c.claims!.caller !== undefined);
  });
}
