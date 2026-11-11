import { expect, test } from "bun:test";
import { browserUser, type Viewer } from "./identity";

const viewer = (picture: string): Viewer => ({ id: "u", email: "me@x", name: "Me", role: "owner", service: false, picture });

test("a browser is told its Foliation picture", () => {
  const url = "https://foliation.dev/pictures/AbCdEfGhIjKlMnOpQrStUv";
  expect(browserUser(viewer(url))).toEqual({ name: "Me", email: "me@x", picture: url });
});

test("no picture: the field is left out", () => {
  expect(browserUser(viewer(""))).toEqual({ name: "Me", email: "me@x" });
});
