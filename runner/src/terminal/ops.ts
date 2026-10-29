// The terminal ops browsers call (shared/protocol.ts), wired to TerminalControl. Without tmux they
// answer with an error that says so.

import type { OpRegistry } from "../core/ops";
import type { TerminalControl } from "./control";

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new Error(`${what} is required.`);
  return v;
};
const optStr = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

export const NO_TMUX = "Terminals need tmux on the runner's machine. Install it and restart the runner.";

export function registerTerminalOps(ops: OpRegistry, control: TerminalControl | undefined) {
  const need = () => {
    if (!control) throw new Error(NO_TMUX);
    return control;
  };
  ops.register("openTerminal", (a) =>
    need().open({ sessionId: optStr(a.sessionId), shellId: optStr(a.shellId), attachId: str(a.attachId, "attachId"), cols: num(a.cols, 80), rows: num(a.rows, 24), stop: a.stop === true }),
  );
  ops.register("closeTerminal", (a) => (control?.detach([str(a.attachId, "attachId")]), null));
  ops.register("terminalInput", (a) => {
    if (typeof a.data !== "string") throw new Error("data is required.");
    need().input(str(a.attachId, "attachId"), a.data);
    return null;
  });
  ops.register("terminalResize", (a) => (need().resize(str(a.attachId, "attachId"), num(a.cols, 80), num(a.rows, 24)), null));
  ops.register("endTerminal", async (a) => (await need().end(str(a.sessionId, "sessionId"), a.whenIdle === true), null));
  ops.register("listShells", async (a) => ({ shells: control ? await control.listShells(str(a.projectPath, "projectPath")) : [] }));
  ops.register("newShell", (a) => need().newShell(str(a.projectPath, "projectPath"), num(a.cols, 80), num(a.rows, 24)));
  ops.register("closeShell", async (a) => (await need().closeShell(str(a.shellId, "shellId")), null));
}
