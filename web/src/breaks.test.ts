import { expect, test } from "bun:test";
import { hardBreaks } from "./breaks";

test("single newlines become hard breaks, outside code only", () => {
  expect(hardBreaks("1\n2\n3")).toBe("1  \n2  \n3");
  expect(hardBreaks("para one\n\npara two")).toBe("para one\n\npara two");
  expect(hardBreaks("```ts\nconst a = 1;\nconst b = 2;\n```\nafter")).toBe("```ts\nconst a = 1;\nconst b = 2;\n```\nafter");
  expect(hardBreaks("text\n```\ncode\n```")).toBe("text\n```\ncode\n```");
});
