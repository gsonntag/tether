import { describe, expect, test } from "bun:test";
import { parseSessionId, sessionId } from "./ids";
import { afterSnapshot, checkSeq } from "./sync";
import { decodeChunk, encodeChunk, parseBrowserMessage, parseRunnerMessage } from "./wire";

describe("session ids", () => {
  test("round trip, with colons in the native id", () => {
    expect(sessionId("codex", "a:b")).toBe("codex:a:b");
    expect(parseSessionId("codex:a:b")).toEqual({ harness: "codex", nativeId: "a:b" });
  });
  test("reject unknown harnesses, inherited keys and empty parts", () => {
    for (const bad of ["pi:x", "claude:", ":x", "claude", "", "toString:x", "__proto__:x", "constructor:x"]) expect(parseSessionId(bad)).toBeNull();
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
  test("browser rpc frames are rebuilt, and args must be an object", () => {
    expect(parseBrowserMessage('{"t":"rpc","id":"1","runnerId":"b","op":"ping","extra":1}')).toEqual({ t: "rpc", id: "1", runnerId: "b", op: "ping", args: {} });
    expect(parseBrowserMessage('{"t":"rpc","id":"1","runnerId":"b","op":"ping","args":"x"}')).toBeNull();
    expect(parseBrowserMessage('{"t":"rpc","id":"1","runnerId":"b","op":"ping","args":[1]}')).toBeNull();
    expect(parseBrowserMessage(JSON.stringify({ t: "rpc", id: "x".repeat(600), runnerId: "b", op: "ping" }))).toBeNull();
  });
  test("hello needs the full runner shape; unknown harnesses are dropped", () => {
    const runner = { id: "u1", name: "box", hostname: "box.local", version: "0.2.0", protocol: 1, harnesses: [{ id: "claude", version: "2.1" }, { id: "pi", version: "1" }, { id: "toString", version: "1" }] };
    expect(parseRunnerMessage(JSON.stringify({ t: "hello", runner }))).toEqual({ t: "hello", runner: { ...runner, harnesses: [{ id: "claude", version: "2.1" }] } });
    expect((parseRunnerMessage(JSON.stringify({ t: "hello", runner: { ...runner, name: undefined } })) as any).runner.name).toBe("box.local");
    for (const bad of [{ id: "x" }, { ...runner, harnesses: "no" }, { ...runner, protocol: "1" }, { ...runner, hostname: 3 }, { ...runner, id: "" }, null])
      expect(parseRunnerMessage(JSON.stringify({ t: "hello", runner: bad }))).toBeNull();
  });
  test("runner frames", () => {
    expect(parseRunnerMessage('{"t":"result","id":"s1","ok":true}')?.t).toBe("result");
    expect(parseRunnerMessage('{"t":"event","sessionId":"claude:x","seq":3,"event":{"type":"reset","messages":[]}}')?.t).toBe("event");
    expect(parseRunnerMessage('{"t":"summary","summary":{"kind":"remove","seq":1,"ids":[]}}')?.t).toBe("summary");
    expect(parseRunnerMessage('{"t":"result","id":"s1","ok":false,"error":"x","junk":1}')).toEqual({ t: "result", id: "s1", ok: false, data: undefined, error: "x" });
    expect(parseRunnerMessage('{"t":"term","attachId":"a1","data":""}')?.t).toBe("term");
    for (const bad of ['{"t":"hello"}', '{"t":"result","id":"s1"}', '{"t":"event","sessionId":"x","seq":1,"event":{}}', '{"t":"summary","summary":{"kind":"bogus","seq":1}}', '{"t":"summary","summary":{"kind":"all","sessions":[]}}', '{"t":"term","attachId":"a"}', '{"t":"event","sessionId":"x","seq":1.5,"event":{}}', '{"t":"rpc"}', "{"])
      expect(parseRunnerMessage(bad)).toBeNull();
  });
  test("terminal chunks survive base64, including large and non-UTF-8 bytes", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    expect(decodeChunk(encodeChunk(bytes))).toEqual(bytes);
    expect(encodeChunk(new TextEncoder().encode("hi"))).toBe("aGk=");
  });
});
