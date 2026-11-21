import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Msg } from "../../../shared/transcript";

// The message reaches the app's connection module, which reads the page's address when loaded.
(globalThis as any).location ??= { protocol: "http:", host: "localhost" };
(globalThis as any).document ??= { addEventListener() {}, visibilityState: "visible" };
(globalThis as any).window ??= { addEventListener() {} };
(globalThis as any).requestAnimationFrame ??= () => 0;
const { Message } = await import("./Message");

const user = (text: string, origin?: Msg["origin"]): Msg => ({ id: "u1", role: "user", ts: 1, ...(origin ? { origin } : {}), parts: [{ type: "text", text }] });
const html = (msg: Msg) => renderToStaticMarkup(<Message msg={msg} />);

test("an old Home agent check-in reads as an ordinary message from Tether, its reply as written", () => {
  const prompt = "Check-in from the Home agent: the person wants to know which sessions are finished.";
  // An old runner's origin may still say what it was for: ignored.
  const out = html(user(prompt, { kind: "tether", purpose: "checkIn" } as Msg["origin"]));
  expect(out).toContain("From Tether, on your behalf");
  expect(out).toContain("which sessions are finished");
  const reply = html({ id: "a1", role: "assistant", ts: 2, parts: [{ type: "text", text: 'Merged.\nTETHER-CHECK-IN: {"done": true}' }] });
  expect(reply).toContain("Merged.");
  expect(reply).toContain("TETHER-CHECK-IN:");
});

test("texted messages show as the person's, labelled with how they came, files as chips", async () => {
  const { FROM_DISCORD, FROM_IMESSAGE } = await import("../../../shared/fromTether");
  const im = html(user(`${FROM_IMESSAGE}start the fix`));
  expect(im).toContain("via iMessage");
  expect(im).toContain("start the fix");
  expect(im).not.toContain("[From iMessage]");
  const dc = html(user(`${FROM_DISCORD}look at this\n\nAttached files:\n- /home/me/.config/tether/attachments/x/1a2b3c4d-shot.pdf (application/pdf, 3 B)`, { kind: "discord" }));
  expect(dc).toContain("via Discord");
  expect(dc).toContain("look at this");
  expect(dc).not.toContain("[From Discord]");
  expect(dc).not.toContain("Attached files:");
  expect(dc).toContain("shot.pdf");
  expect(dc).toContain('class="t-msg user"');
});

test("an origin kind that only exists on Object.prototype isn't a messaging app", () => {
  const out = html(user("hi", { kind: "constructor" } as any));
  expect(out).not.toContain("via ");
  expect(out).not.toContain("undefined");
});
