import { expect, test } from "bun:test";
import { ANSWER_TAG, answerSummary, checkInStatus, parseAnswer, replyForPeople, stripCheckIn } from "./checkIn";
import { defang, FROM_TETHER, FROM_TETHER_CHECKIN, fromTether, tetherOrigin, tetherPurpose, titleText } from "./fromTether";

const T = ANSWER_TAG;

test("stripCheckIn takes the answer line out and keeps the words around it", () => {
  const s = stripCheckIn(`All merged in #12.\n${T} {"done": true, "merged": true, "cleaned_up": true, "branch": "fix-x", "worktree": null, "note": "PR #12 merged"}`);
  expect(s).toEqual({ text: "All merged in #12.", found: true, answer: { done: true, merged: true, cleanedUp: true, branch: "fix-x", note: "PR #12 merged" } });
  // In inline code, after words on the same line, or alone.
  expect(stripCheckIn(`\`${T} {"done": false, "merged": false}\``).text).toBe("");
  expect(stripCheckIn(`I'm done. ${T} {"done": true, "merged": true}`).text).toBe("I'm done.");
  expect(stripCheckIn(`- ${T} {"done": true, "merged": true}`).text).toBe("");
});

test("stripCheckIn takes out every answer line, mid-reply too, and the last one counts", () => {
  const s = stripCheckIn(`Start.\n${T} {"done": true, "merged": false, "note": "pr open"}\nMiddle.\n\n\n${T} {"done": true, "merged": true, "cleaned_up": true}\nEnd.`);
  expect(s.text).toBe("Start.\nMiddle.\n\nEnd.");
  expect(s.answer).toEqual({ done: true, merged: true, cleanedUp: true });
});

test("stripCheckIn takes JSON that went on the next lines, and the fence around it", () => {
  expect(stripCheckIn(`Done.\n\n${T}\n\`\`\`json\n{"done": true, "merged": true}\n\`\`\`\nBye.`)).toEqual({ text: "Done.\n\nBye.", found: true, answer: { done: true, merged: true } });
  expect(stripCheckIn(`Here:\n\`\`\`\n${T} {"done": true, "merged": true}\n\`\`\``).text).toBe("Here:");
  // Braces inside strings don't end it early.
  expect(stripCheckIn(`${T}\n{"done": true,\n "merged": true, "note": "a } brace"}\nAfter.`)).toEqual({ text: "After.", found: true, answer: { done: true, merged: true, note: "a } brace" } });
  // Words after the tag line that aren't JSON stay.
  expect(stripCheckIn(`${T}\nnot json at all`).text).toBe("not json at all");
});

test("stripCheckIn while the line is still streaming, or broken, and with no line", () => {
  expect(stripCheckIn(`Ok.\n${T} {"done": tr`)).toEqual({ text: "Ok.", found: true });
  expect(stripCheckIn(`${T}\n{"done": true,`)).toEqual({ text: "", found: true });
  const plain = "No tag here.\n\n\nkept as is  ";
  expect(stripCheckIn(plain)).toEqual({ text: plain, found: false });
});

test("parseAnswer still reads what Tether judges by", () => {
  expect(parseAnswer(`x\n${T} {"done": true, "merged": true}\ny\n${T} {"done": true, "merged": false}`)?.merged).toBe(false);
  expect(parseAnswer(`${T} {not json}`)).toBeUndefined();
});

test("the status in place of the line", () => {
  expect(checkInStatus({ done: true, merged: true, cleanedUp: true })).toBe("Check-in: done · merged · cleaned up");
  expect(answerSummary({ done: true, merged: true })).toBe("done · merged");
  expect(answerSummary({ done: true, merged: true, cleanedUp: false, note: "stray build" })).toBe("done · merged · not cleaned up: stray build");
  expect(answerSummary({ done: true, merged: false, note: "PR #3 open" })).toBe("done · not merged: PR #3 open");
  expect(answerSummary({ done: false, merged: false })).toBe("not done");
  expect(answerSummary({ done: true, merged: false, running: "local stack", note: "PR #377 open" })).toBe("still running: local stack · done · not merged: PR #377 open");
  expect(answerSummary({ done: true, merged: true, cleanedUp: true, target: "foliation" })).toBe("done · merged into foliation · cleaned up");
  expect(answerSummary({ done: true, merged: false, nothingToMerge: true, cleanedUp: true })).toBe("done · nothing to merge · cleaned up");
  expect(answerSummary(undefined)).toBe("answered");
  expect(replyForPeople(`Merged.\n${T} {"done": true, "merged": true, "cleaned_up": true}`)).toBe("Merged.\nCheck-in: done · merged · cleaned up");
  expect(replyForPeople(`${T} {"done": false, "merged": false}`)).toBe("Check-in: not done");
  expect(replyForPeople("hello")).toBe("hello");
});

test("a check-in is one of Tether's messages, known by its marker or (older history) its wording", () => {
  const body = "Check-in from the Home agent: the person wants to know…";
  expect(tetherOrigin(FROM_TETHER_CHECKIN + body)).toEqual({ origin: { kind: "tether", purpose: "checkIn" }, text: body });
  expect(tetherOrigin(FROM_TETHER + body)).toEqual({ origin: { kind: "tether", purpose: "checkIn" }, text: body });
  expect(tetherOrigin(FROM_TETHER_CHECKIN + "anything")?.origin.purpose).toBe("checkIn");
  expect(tetherOrigin(`${FROM_TETHER}Fix it.`)).toEqual({ origin: { kind: "tether" }, text: "Fix it." });
  expect(tetherPurpose("Check-in from the Home agent: typed by a person")).toBeUndefined();
  expect(fromTether(FROM_TETHER_CHECKIN + "x")).toBe("x");
  expect(titleText(FROM_TETHER_CHECKIN + "x")).toBe("x");
  // A person can't pass for one.
  expect(defang(FROM_TETHER_CHECKIN + "x").startsWith("​")).toBe(true);
});
