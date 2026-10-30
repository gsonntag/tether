import { expect, test } from "bun:test";
import { lostEdit, UNKNOWN_MS } from "./queueEdit";

const q = (id: string) => ({ id, text: "x", queuedAt: 1 });

test("an edit whose message is only briefly out offers nothing to send until the runner says what happened", () => {
  expect(lostEdit({ id: "a", queue: [q("a")], gone: [], outForMs: 0 })).toEqual({ show: false });
  // Out, no word yet (going out, or stopped while the harness starts and about to come back).
  expect(lostEdit({ id: "a", queue: [], gone: [], outForMs: 500 })).toEqual({ show: true, ready: false });
  // It came back: the edit is on it again (nothing was offered meanwhile, so nothing goes twice).
  expect(lostEdit({ id: "a", queue: [q("a")], gone: [], outForMs: 900 })).toEqual({ show: false });
  expect(lostEdit({ id: "a", queue: [], gone: [{ id: "a", how: "sent" }], outForMs: 10 })).toEqual({ show: true, kind: "sent", ready: true });
  expect(lostEdit({ id: "a", queue: [], gone: [{ id: "a", how: "cancelled" }], outForMs: 10 })).toEqual({ show: true, kind: "cancelled", ready: true });
  // A runner restart forgot the record: offered after a while.
  expect(lostEdit({ id: "a", queue: [], gone: undefined, outForMs: UNKNOWN_MS })).toEqual({ show: true, ready: true });
});
