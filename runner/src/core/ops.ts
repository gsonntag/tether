// Runner-side handlers for the rpc ops browsers call (shared/protocol.ts `Ops`).

import type { OpArgs, OpName, OpResult } from "../../../shared/protocol";

export type OpHandler<K extends OpName> = (args: OpArgs<K>) => Promise<OpResult<K>> | OpResult<K>;

export class OpRegistry {
  private handlers = new Map<OpName, OpHandler<any>>();

  register<K extends OpName>(op: K, handler: OpHandler<K>) {
    if (this.handlers.has(op)) throw new Error(`op ${op} is already registered`);
    this.handlers.set(op, handler);
  }

  async handle(op: string, args: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
    const h = this.handlers.get(op as OpName);
    if (!h) return { ok: false, error: `This runner doesn't know "${op}". Update and restart it.` };
    try {
      return { ok: true, data: (await h((args ?? {}) as never)) ?? null };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }
}
