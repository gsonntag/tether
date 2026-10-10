import { describe, expect, test } from "bun:test";
import { allowTrashClick, GRACE_MS, pointerMoved, type TrashGuard } from "./trashGuard";

const fresh = (): TrashGuard => ({ at: 0, id: "", x: 0, y: 0, holding: false });
const at = { x: 100, y: 200 };

describe("trash guard", () => {
  test("a double-click that lands on the row that slid up is ignored", () => {
    const g = fresh();
    expect(allowTrashClick("a", at, 1000, g)).toBe(true);
    expect(allowTrashClick("b", at, 1000 + 250, g)).toBe(false);
  });
  test("a deliberate second removal after the grace period goes through", () => {
    const g = fresh();
    allowTrashClick("a", at, 1000, g);
    expect(allowTrashClick("b", at, 1000 + GRACE_MS + 1, g)).toBe(true);
  });
  test("an ignored click doesn't extend the grace period", () => {
    const g = fresh();
    allowTrashClick("a", at, 1000, g);
    allowTrashClick("b", at, 1400, g);
    expect(allowTrashClick("b", at, 1000 + GRACE_MS + 1, g)).toBe(true);
  });
  test("the pointer counts as moved only off the click spot", () => {
    const g = fresh();
    allowTrashClick("a", at, 1000, g);
    expect(pointerMoved({ x: 101, y: 200 }, g)).toBe(false);
    expect(pointerMoved({ x: 100, y: 230 }, g)).toBe(true);
  });
});
