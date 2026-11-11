// Tether's reports to the Home agent, as the Home chat's one-line summaries. The texts are the
// runner's (runner/src/modules/homeAgent/index.ts: turnEnded, needsPerson, flushWatched, finish).

import { expect, test } from "bun:test";
import { FROM_TETHER } from "./fromTether";
import { homeReport } from "./homeReport";

const turn = (head: string, tail = `Report 3 of 12. Keep it going with send_to_session if the task isn't done, or tell the person in one casual sentence.`) =>
  `${FROM_TETHER}${head}\n\nIts last reply:\n<<<\nMerged PR #191.\nAll good, here is a lot more text.\n>>>\n\n${tail}`;

test("a finished turn: the session's title, project and report count", () => {
  expect(homeReport(turn(`Session claude:abc ("Merge PR #191" in /home/u/foliation, Claude) finished a turn.`))).toEqual({
    kind: "turn",
    summary: "Report from “Merge PR #191” (foliation): finished a turn · 3 of 12",
    attention: false,
  });
});

test("the last report, a title with quotes, and a path with commas", () => {
  const r = homeReport(turn(`Session codex:1 ("Say "hi", twice" in /p/a, b/web, Codex) finished a turn.`, "That's report 12 of 12: you've stopped following this session."));
  expect(r?.summary).toBe("Report from “Say \"hi\", twice” (web): finished a turn · 12 of 12");
});

test("a failed turn needs attention", () => {
  expect(homeReport(turn(`Session claude:abc ("Fix tests" in /p/tether, Claude) finished a turn with an error: rate limited`))).toEqual({
    kind: "turn",
    summary: "Report from “Fix tests” (tether): failed: rate limited · 3 of 12",
    attention: true,
  });
});

test("a session it couldn't describe goes by its id", () => {
  expect(homeReport(turn(`Session claude:gone finished a turn.`))?.summary).toBe("Report from claude:gone: finished a turn · 3 of 12");
});

test("a session waiting for the person", () => {
  expect(homeReport(`${FROM_TETHER}Session claude:abc ("Deploy" in /p/site, Claude) is waiting for the person: Which region?. Only they can answer it, in that session. Tell them in one casual sentence.`)).toEqual({
    kind: "waiting",
    summary: "“Deploy” (site) is waiting for you: Which region?",
    attention: true,
  });
});

const watch = (...lines: string[]) =>
  [`${FROM_TETHER}Sessions you didn't start (watching all sessions; they aren't yours to drive):`, ...lines, `Tell the person in one casual sentence if one failed or needs them; otherwise reply with a few words at most. Use session_status for more.`].join("\n");

test("one watched session", () => {
  expect(homeReport(watch(`- claude:a "task a" (project, Claude): finished a turn. It said: did work a, and a lot more`))).toEqual({
    kind: "watch",
    summary: "“task a” (project) finished a turn (you didn't start it)",
    attention: false,
  });
  expect(homeReport(watch(`- claude:q "task q" (project, Claude): waiting for the person: Which color?`))?.summary).toBe("“task q” (project) is waiting for you (you didn't start it)");
});

test("several watched sessions: how many, and which need attention", () => {
  const r = homeReport(
    watch(
      `- claude:a "task a" (project, Claude): finished a turn. It said: did work a`,
      `- claude:b "task b" (project, Claude): failed: it broke`,
      `- claude:q "task q" (other, Codex): waiting for the person: Which color?`,
      `- codex:gone: finished a turn.`,
    ),
  );
  expect(r).toEqual({ kind: "watch", summary: "4 sessions you didn't start updated · 1 failed, 1 waiting for you", attention: true });
  expect(homeReport(watch(`- claude:a "a" (p, Claude): finished a turn.`, `- claude:b "b" (p, Claude): finished a turn.`))?.summary).toBe("2 sessions you didn't start updated");
});

test("a check-in: archived, kept, and not asked", () => {
  const body = [
    `${FROM_TETHER}Check-in finished: 5 sessions asked.`,
    `Archived (4):`,
    `- claude:a "task a" (/p): PR merged`,
    `- claude:b "task b" (/p): PR merged`,
    `- claude:c "task c" (/p): PR merged`,
    `- claude:d "task d" (/p): PR merged`,
    `Not archived (1):`,
    `- claude:e "task e" (/p): not done: tests still failing`,
    `Give the person a short summary: which were archived, and which weren't and why.`,
  ].join("\n");
  expect(homeReport(body)).toEqual({ kind: "checkIn", summary: "Check-in finished: 4 archived, 1 kept", attention: false });
  const skipped = [`${FROM_TETHER}Check-in finished: 1 session asked.`, `Archived (0): none`, `Not archived (1):`, `- x "y" (/p): no answer in time`, `Not asked (2):`, `- a "b" (/p): busy`, `- c "d" (/p): busy`].join("\n");
  expect(homeReport(skipped)?.summary).toBe("Check-in finished: 0 archived, 1 kept, 2 not asked");
});

test("anything else from Tether: its first line, clipped", () => {
  expect(homeReport(`${FROM_TETHER}Something new Tether says.\nMore detail here.`)).toEqual({ kind: "other", summary: "Something new Tether says.", attention: false });
  const long = homeReport("x".repeat(500))!;
  expect(long.kind).toBe("other");
  expect(long.summary.length).toBe(140);
  expect(long.summary.endsWith("…")).toBe(true);
});

test("with the marker already taken off (a stored message), and empty", () => {
  expect(homeReport(`Session claude:abc ("T" in /p/x, Claude) finished a turn.\n\nReport 1 of 12.`)?.summary).toBe("Report from “T” (x): finished a turn · 1 of 12");
  expect(homeReport(`${FROM_TETHER}`)).toBeUndefined();
  expect(homeReport("  \n ")).toBeUndefined();
});
