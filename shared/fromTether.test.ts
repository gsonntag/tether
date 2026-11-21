import { expect, test } from "bun:test";
import { defang, FROM_TETHER, FROM_TETHER_CHECKIN, fromTether, tetherOrigin, titleText } from "./fromTether";

test("an old check-in from the Home agent (removed) still reads as one of Tether's messages", () => {
  const body = "Check-in from the Home agent: the person wants to know…";
  expect(tetherOrigin(FROM_TETHER_CHECKIN + body)).toEqual({ origin: { kind: "tether" }, text: body });
  expect(tetherOrigin(FROM_TETHER + body)).toEqual({ origin: { kind: "tether" }, text: body });
  expect(tetherOrigin(`${FROM_TETHER}Fix it.`)).toEqual({ origin: { kind: "tether" }, text: "Fix it." });
  expect(fromTether(FROM_TETHER_CHECKIN + "x")).toBe("x");
  expect(titleText(FROM_TETHER_CHECKIN + "x")).toBe("x");
  // A person can't pass for one.
  expect(defang(FROM_TETHER_CHECKIN + "x").startsWith("​")).toBe(true);
});
