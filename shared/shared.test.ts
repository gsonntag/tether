import { describe, expect, test } from "bun:test";
import { parseSessionId, sessionId } from "./ids";
import { afterSnapshot, checkSeq } from "./sync";
import { decodeChunk, encodeChunk, parseBrowserMessage, parseRunnerMessage } from "./wire";

describe("session ids", () => {
  test("round trip, with colons in the native id", () => {
    expect(sessionId("codex", "a:b")).toBe("codex:a:b");
    expect(parseSessionId("codex:a:b")).toEqual({ harness: "codex", nativeId: "a:b" });
  });
  test("reject unknown harnesses and empty parts", () => {
    for (const bad of ["pi:x", "claude:", ":x", "claude", ""]) expect(parseSessionId(bad)).toBeNull();
  });
});

describe("seq", () => {
  test("next applies, old is stale, a jump is a gap", () => {
    expect(checkSeq(4, 5)).toBe("apply");
    expect(checkSeq(4, 4)).toBe("stale");
    expect(checkSeq(4, 2)).toBe("stale");
    expect(checkSeq(4, 6)).toBe("gap");
  });
  test("events buffered during a subscribe fold onto the snapshot", () => {
    const e = (seq: number) => ({ seq });
    expect(afterSnapshot(3, [e(2), e(5), e(3), e(4)])).toEqual([e(4), e(5)]);
    expect(afterSnapshot(3, [])).toEqual([]);
    expect(afterSnapshot(3, [e(4), e(6)])).toBe("gap");
  });
});

describe("wire", () => {
  test("browser frames", () => {
    expect(parseBrowserMessage('{"t":"ping"}')).toEqual({ t: "ping" });
    const rpc = { t: "rpc", id: "1", runnerId: "box", op: "ping", args: {} };
    expect(parseBrowserMessage(JSON.stringify(rpc))).toEqual(rpc as any);
    expect(parseBrowserMessage(new TextEncoder().encode(JSON.stringify(rpc)))).toEqual(rpc as any);
    for (const bad of ["", "nope", "[]", "null", '{"t":"rpc","id":"1","op":"ping"}', '{"t":"rpc","id":1,"runnerId":"b","op":"x"}', '{"t":"hello"}'])
      expect(parseBrowserMessage(bad)).toBeNull();
  });
  test("runner frames", () => {
    expect(parseRunnerMessage('{"t":"hello","runner":{"id":"box"}}')?.t).toBe("hello");
    expect(parseRunnerMessage('{"t":"result","id":"s1","ok":true}')?.t).toBe("result");
    expect(parseRunnerMessage('{"t":"event","sessionId":"claude:x","seq":3,"event":{"type":"reset","messages":[]}}')?.t).toBe("event");
    expect(parseRunnerMessage('{"t":"term","attachId":"a1","data":""}')?.t).toBe("term");
    for (const bad of ['{"t":"hello"}', '{"t":"result","id":"s1"}', '{"t":"event","sessionId":"x","seq":1.5,"event":{}}', '{"t":"rpc"}', "{"])
      expect(parseRunnerMessage(bad)).toBeNull();
  });
  test("terminal chunks survive base64, including large and non-UTF-8 bytes", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    expect(decodeChunk(encodeChunk(bytes))).toEqual(bytes);
    expect(encodeChunk(new TextEncoder().encode("hi"))).toBe("aGk=");
  });
});
