import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Msg } from "../../../shared/transcript";
import { ANSWER_TAG } from "../../../shared/checkIn";
import { FROM_TETHER, FROM_TETHER_CHECKIN } from "../../../shared/fromTether";

// The message reaches the app's connection module, which reads the page's address when loaded.
(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;
const { Message } = await import("./Message");

const prompt = "Check-in from the Home agent: the person wants to know which sessions are finished.\n\nGive one or two sentences.";
const user = (text: string, origin?: Msg["origin"]): Msg => ({ id: "u1", role: "user", ts: 1, ...(origin ? { origin } : {}), parts: [{ type: "text", text }] });
const html = (msg: Msg) => renderToStaticMarkup(<Message msg={msg} />);

test("the Home agent's check-in is one quiet line, by its origin, its marker, or its wording in older history", () => {
  for (const m of [user(prompt, { kind: "tether", purpose: "checkIn" }), user(FROM_TETHER_CHECKIN + prompt), user(FROM_TETHER + prompt), user(prompt, { kind: "tether" })]) {
    const out = html(m);
    expect(out).toContain("t-home-report-line");
    expect(out).toContain("Home agent check-in");
    expect(out).toContain('title="Show the full check-in"');
    // Folded: the prompt itself isn't shown until it's opened.
    expect(out).not.toContain("which sessions are finished");
    expect(out).not.toContain("t-bubble");
  }
  // Something else from Tether, or a person typing the same words, isn't one.
  expect(html(user("Fix it.", { kind: "tether" }))).not.toContain("Home agent check-in");
  expect(html(user(prompt))).not.toContain("Home agent check-in");
});

test("a check-in answer shows without its machine line, a status in its place", () => {
  const reply = (text: string): Msg => ({ id: "a1", role: "assistant", ts: 2, parts: [{ type: "text", text }] });
  const done = html(reply(`Merged in #12 and removed the worktree.\n${ANSWER_TAG} {"done": true, "merged": true, "cleaned_up": true, "note": "PR #12 merged"}`));
  expect(done).toContain("Merged in #12 and removed the worktree.");
  expect(done).not.toContain(ANSWER_TAG);
  expect(done).not.toContain("cleaned_up");
  expect(done).toContain('class="t-checkin-status settled">Check-in: done · merged · cleaned up<');
  const open = html(reply(`Not yet.\n${ANSWER_TAG} {"done": true, "merged": false, "note": "PR #3 open"}\nAlso:\n${ANSWER_TAG} {"done": true, "merged": false, "note": "PR #3 open"}`));
  expect(open).not.toContain(ANSWER_TAG);
  expect(open).toContain('class="t-checkin-status">Check-in: done · not merged: PR #3 open<');
  // Other replies are as they were.
  expect(html(reply("All good."))).not.toContain("t-checkin-status");
});
