import { describe, expect, test } from "bun:test";
import {
  attachmentBlock,
  cleanMime,
  displayName,
  formatSize,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  mimeFromName,
  safeName,
  sizeProblem,
  splitAttachments,
  withAttachments,
  type Attachment,
} from "./shared/attachments";
import { userParts } from "./shared/bash";
import { displayText } from "./shared/skill";

const png: Attachment = { path: "/h/.config/tether/attachments/claude-code_s1/0a1b2c3d-shot.png", name: "shot.png", mimeType: "image/png", size: 1_258_291 };
const pdf: Attachment = { path: "/h/.config/tether/attachments/claude-code_s1/deadbeef-report.pdf", name: "report.pdf", mimeType: "application/pdf", size: 348_160 };

describe("safeName", () => {
  test.each([
    ["../../etc/passwd", "passwd"],
    ["..\\..\\boot.ini", "boot.ini"],
    ["/abs/path/photo.png", "photo.png"],
    ["..", "file"],
    [".", "file"],
    ["", "file"],
    [".bashrc", "bashrc"],
    ["my report (final).pdf", "my_report_final_.pdf"],
    ["a\u0000b\nc.txt", "abc.txt"],
    ["$(rm -rf ~).sh", "rm_-rf_.sh"],
    ["Ünïcödé 写真.jpg", "Ünïcödé_写真.jpg"],
  ])("%j → %j", (input, out) => expect(safeName(input)).toBe(out));

  test("never a path, never hidden, never empty", () => {
    for (const s of ["../x", "a/b/../../c", "....", "/", "\\", "-rf", "~", "...."]) {
      const n = safeName(s);
      expect(n).not.toContain("/");
      expect(n).not.toContain("\\");
      expect(n.startsWith(".")).toBe(false);
      expect(n.startsWith("-")).toBe(false);
      expect(n.length).toBeGreaterThan(0);
    }
  });

  test("long names are cut, keeping the extension", () => {
    const n = safeName("x".repeat(300) + ".tar");
    expect(n.length).toBe(100);
    expect(n.endsWith(".tar")).toBe(true);
  });
});

describe("types and sizes", () => {
  test("type from the name", () => {
    expect(mimeFromName("a.PNG")).toBe("image/png");
    expect(mimeFromName("a.jpeg")).toBe("image/jpeg");
    expect(mimeFromName("main.rs")).toBe("text/plain");
    expect(mimeFromName("data.bin")).toBe("application/octet-stream");
  });
  test("a declared type wins unless it's junk or generic", () => {
    expect(cleanMime("image/webp", "x")).toBe("image/webp");
    expect(cleanMime("", "x.pdf")).toBe("application/pdf");
    expect(cleanMime("application/octet-stream", "x.csv")).toBe("text/csv");
    expect(cleanMime("text/html; charset=utf-8", "x.txt")).toBe("text/plain");
  });
  test("caps: images 10 MB, other files 25 MB, nothing empty", () => {
    expect(sizeProblem(MAX_IMAGE_BYTES, "image/png")).toBeUndefined();
    expect(sizeProblem(MAX_IMAGE_BYTES + 1, "image/png")).toContain("images can be up to 10.0 MB");
    expect(sizeProblem(MAX_IMAGE_BYTES + 1, "application/pdf")).toBeUndefined();
    expect(sizeProblem(MAX_FILE_BYTES + 1, "application/zip")).toContain("files can be up to 25.0 MB");
    expect(sizeProblem(0, "text/plain")).toBe("The file is empty.");
  });
  test("sizes read like people write them", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(348_160)).toBe("340 KB");
    expect(formatSize(1_258_291)).toBe("1.2 MB");
  });
});

describe("the attachments block", () => {
  test("round trip", () => {
    const text = withAttachments("What's in these?", [png, pdf]);
    expect(text).toBe(
      "What's in these?\n\nAttached files (open them with your file-reading tool):\n" +
        `- ${png.path} (image/png, 1.2 MB)\n- ${pdf.path} (application/pdf, 340 KB)`,
    );
    const back = splitAttachments(text);
    expect(back.text).toBe("What's in these?");
    expect(back.files.map((f) => [f.path, f.name, f.mimeType])).toEqual([
      [png.path, "shot.png", "image/png"],
      [pdf.path, "report.pdf", "application/pdf"],
    ]);
  });

  test("files only", () => {
    expect(withAttachments("  ", [png])).toBe(attachmentBlock([png]));
    expect(splitAttachments(attachmentBlock([png]))).toEqual({ text: "", files: [{ ...png, size: splitAttachments(attachmentBlock([png])).files[0]!.size }] });
  });

  test("joined pending messages: every block, each path once, text kept in order", () => {
    const joined = [withAttachments("first", [png]), "second", withAttachments("third", [pdf, png])].join("\n\n");
    const { text, files } = splitAttachments(joined);
    expect(text).toBe("first\n\nsecond\n\nthird");
    expect(files.map((f) => f.name)).toEqual(["shot.png", "report.pdf"]);
  });

  test("a header with no valid lines is just text", () => {
    const t = "Attached files (open them with your file-reading tool):\nnothing here";
    expect(splitAttachments(t)).toEqual({ text: t, files: [] });
  });

  test("bash output after the block ends it", () => {
    const t = withAttachments("look", [png]) + "\n\n<bash-input>ls</bash-input>";
    expect(splitAttachments(t).files).toHaveLength(1);
    expect(splitAttachments(t).text).toBe("look\n\n<bash-input>ls</bash-input>");
  });

  test("display name drops the storage id", () => {
    expect(displayName("/x/0a1b2c3d-my-file.txt")).toBe("my-file.txt");
    expect(displayName("/x/notanid-file.txt")).toBe("notanid-file.txt");
  });
});

describe("transcript and titles", () => {
  test("user messages show the files as file parts", () => {
    const parts = userParts(withAttachments("look", [png, pdf]), "u1");
    expect(parts[0]).toEqual({ type: "text", text: "look" });
    expect(parts.slice(1).map((p) => p.type)).toEqual(["file", "file"]);
  });
  test("a message of only files has only file parts", () => {
    expect(userParts(attachmentBlock([pdf]), "u1").map((p) => p.type)).toEqual(["file"]);
  });
  test("titles name the files, not their paths", () => {
    expect(displayText(withAttachments("look", [png]))).toBe("look [shot.png]");
    expect(displayText(attachmentBlock([png, pdf]))).toBe("shot.png, report.pdf");
  });
});
