import { expect, test } from "bun:test";
import { cleanMime, formatSize, safeName, sizeProblem, splitAttachments, withAttachments } from "./attachments";
import { parseBrowserMessage } from "./wire";

test("a message with attachments lists them, and splits back into text and files", () => {
  const files = [
    { path: "/home/me/.config/tether/attachments/claude_x/1a2b3c4d-photo.png", name: "photo.png", mimeType: "image/png", size: 1258291 },
    { path: "/home/me/.config/tether/attachments/claude_x/0f0f0f0f-notes.txt", name: "notes.txt", mimeType: "text/plain", size: 12 },
  ];
  const text = withAttachments("Look at these", files);
  expect(text).toBe(
    "Look at these\n\nAttached files:\n- /home/me/.config/tether/attachments/claude_x/1a2b3c4d-photo.png (image/png, 1.2 MB)\n- /home/me/.config/tether/attachments/claude_x/0f0f0f0f-notes.txt (text/plain, 12 B)",
  );
  const back = splitAttachments(text);
  expect(back.text).toBe("Look at these");
  expect(back.files.map((f) => [f.name, f.mimeType])).toEqual([
    ["photo.png", "image/png"],
    ["notes.txt", "text/plain"],
  ]);
  expect(withAttachments("only text", [])).toBe("only text");
  expect(splitAttachments("Attached files:\nnot a list").files).toEqual([]);
  expect(splitAttachments(withAttachments("", files)).text).toBe("");
});

test("names are made safe; types come from the name when the browser gives none", () => {
  expect(safeName("../../etc/passwd")).toBe("passwd");
  expect(safeName("my photo (1).HEIC")).toBe("my_photo_1_.HEIC");
  expect(safeName("")).toBe("file");
  expect(cleanMime("", "a.ts")).toBe("text/plain");
  expect(cleanMime("image/png", "x")).toBe("image/png");
  expect(sizeProblem(0, "image/png")).toBe("The file is empty.");
  expect(sizeProblem(11 * 1024 * 1024, "image/png")).toContain("images can be up to 10.0 MB");
  expect(formatSize(1536)).toBe("1.5 KB");
});

test("presence frames", () => {
  expect(parseBrowserMessage(JSON.stringify({ t: "presence", deviceId: "d1", runnerId: "r", sessionId: "claude:x" }))).toEqual({ t: "presence", deviceId: "d1", runnerId: "r", sessionId: "claude:x" });
  expect(parseBrowserMessage(JSON.stringify({ t: "presence", deviceId: "d1" }))).toEqual({ t: "presence", deviceId: "d1" });
  expect(parseBrowserMessage(JSON.stringify({ t: "presence", deviceId: "d1", sessionId: "only half" }))).toEqual({ t: "presence", deviceId: "d1" });
  expect(parseBrowserMessage(JSON.stringify({ t: "presence" }))).toBeNull();
});
