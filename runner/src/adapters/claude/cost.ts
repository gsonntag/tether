// Native results are cumulative estimates and resume restores prior (possibly plan) spend.
// Count only the increase over the harness's pre-send baseline, never that restored history.
import { randomUUID } from "node:crypto";

export interface ClaudeCostReport { id: string; usd?: number; estimated: boolean; complete: boolean }
const amount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

export class ClaudeCostCounter {
  private id = randomUUID();
  private last?: number;
  constructor(private baseline: number | undefined) {}
  reset() { this.id = randomUUID(); this.baseline = 0; this.last = undefined; }
  report(total: unknown, crash = false): ClaudeCostReport {
    const base = { id: this.id, estimated: true, complete: false };
    if (crash || !amount(total) || !amount(this.baseline)) return base;
    if (total < this.baseline || (this.last !== undefined && total < this.last)) {
      this.baseline = undefined;
      return base;
    }
    this.last = total;
    return { ...base, usd: total - this.baseline, complete: true };
  }
}
