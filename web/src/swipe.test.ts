import { describe, expect, test } from "bun:test";
import { dragProgress, EDGE_PX, lockAxis, openKind, settleOpen, SLOP_PX, velocity } from "./swipe";

describe("openKind", () => {
  test("the left edge strip is an edge swipe", () => {
    expect(openKind(0, 390)).toBe("edge");
    expect(openKind(EDGE_PX, 390)).toBe("edge");
  });
  test("the rest of the left third is a zone swipe", () => {
    expect(openKind(EDGE_PX + 1, 390)).toBe("zone");
    expect(openKind(129, 390)).toBe("zone");
  });
  test("further right can't open the drawer", () => {
    expect(openKind(130, 390)).toBeNull();
    expect(openKind(380, 390)).toBeNull();
  });
});

describe("lockAxis", () => {
  test("waits until the finger has moved past the slop", () => {
    expect(lockAxis("edge", SLOP_PX - 1, 0)).toBe("wait");
    expect(lockAxis("zone", 5, 5)).toBe("wait");
    expect(lockAxis("close", -3, 2)).toBe("wait");
  });
  test("vertical movement is left to the page", () => {
    expect(lockAxis("edge", 2, 30)).toBe("cancel");
    expect(lockAxis("zone", 0, -20)).toBe("cancel");
    expect(lockAxis("close", -2, 30)).toBe("cancel");
  });
  test("the wrong direction is left to the page", () => {
    expect(lockAxis("edge", -20, 0)).toBe("cancel");
    expect(lockAxis("zone", -20, 0)).toBe("cancel");
    expect(lockAxis("close", 20, 0)).toBe("cancel");
  });
  test("edge and close swipes only need dx to dominate", () => {
    expect(lockAxis("edge", 12, 10)).toBe("drag");
    expect(lockAxis("close", -12, -10)).toBe("drag");
  });
  test("mid-screen swipes must be clearly horizontal", () => {
    expect(lockAxis("zone", 12, 10)).toBe("cancel");
    expect(lockAxis("zone", 20, 9)).toBe("drag");
    expect(lockAxis("zone", 20, -10)).toBe("drag");
    expect(lockAxis("zone", 20, 11)).toBe("cancel");
  });
});

describe("dragProgress", () => {
  test("opening follows the finger from shut", () => {
    expect(dragProgress("edge", 0, 320)).toBe(0);
    expect(dragProgress("zone", 160, 320)).toBe(0.5);
    expect(dragProgress("edge", 500, 320)).toBe(1);
    expect(dragProgress("edge", -40, 320)).toBe(0);
  });
  test("closing follows the finger from open", () => {
    expect(dragProgress("close", 0, 320)).toBe(1);
    expect(dragProgress("close", -80, 320)).toBe(0.75);
    expect(dragProgress("close", -999, 320)).toBe(0);
    expect(dragProgress("close", 50, 320)).toBe(1);
  });
  test("an unmeasured drawer stays where it was", () => {
    expect(dragProgress("edge", 100, 0)).toBe(0);
    expect(dragProgress("close", -100, 0)).toBe(1);
  });
});

describe("velocity", () => {
  test("needs two samples", () => {
    expect(velocity([])).toBe(0);
    expect(velocity([{ t: 0, x: 10 }])).toBe(0);
  });
  test("measures over the recent window only", () => {
    const s = [
      { t: 0, x: 0 },
      { t: 500, x: 0 }, // a long pause, then a quick flick
      { t: 550, x: 30 },
      { t: 600, x: 60 },
    ];
    expect(velocity(s, 100)).toBeCloseTo(0.6);
  });
  test("is signed", () => {
    expect(velocity([{ t: 0, x: 100 }, { t: 50, x: 50 }])).toBe(-1);
  });
  test("same-timestamp samples don't divide by zero", () => {
    expect(velocity([{ t: 5, x: 0 }, { t: 5, x: 40 }])).toBe(0);
  });
});

describe("settleOpen", () => {
  test("a slow release settles by distance", () => {
    expect(settleOpen(0.6, 0)).toBe(true);
    expect(settleOpen(0.4, 0.1)).toBe(false);
    expect(settleOpen(0.5, 0)).toBe(true);
  });
  test("a flick wins over distance", () => {
    expect(settleOpen(0.1, 0.5)).toBe(true);
    expect(settleOpen(0.9, -0.5)).toBe(false);
  });
});
