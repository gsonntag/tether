import { expect, test } from "bun:test";
import { spawnPty } from "./pty";

test("a shell in a PTY takes input, resizes and reports its exit", async () => {
  let out = "";
  const dec = new TextDecoder();
  const pty = spawnPty(["sh"], { cols: 80, rows: 24, env: { ...process.env, PS1: "$ " }, onData: (b) => (out += dec.decode(b, { stream: true })) });
  const until = async (re: RegExp) => {
    for (let i = 0; i < 500 && !re.test(out); i++) await Bun.sleep(10);
    expect(out).toMatch(re);
  };
  pty.write("stty size\n");
  await until(/24 80/);
  pty.resize(100, 30);
  pty.write("stty size\n");
  await until(/30 100/);
  pty.write("exit 7\n");
  expect(await pty.exited).toBe(7);
});

test("close ends the process", async () => {
  const pty = spawnPty(["sleep", "30"], { onData: () => {} });
  pty.close();
  expect(await pty.exited).toBeNull();
});
