// The request broker (SPEC §7): every permission prompt and question from any driver comes here.
//
//   driver ─► broker.decide(request) ─► [policy steps] ─► person ─► answer ─► driver
//
// Policy steps are an ordered list of functions that may allow or deny with a reason and a source
// (the judge, rules, "always allow" come back later as steps); the core ships with none.
//
// P1 has no approvals UI: a request nobody's policy decides is denied with a message saying so,
// and the driver's sink shows that in the transcript. P2 replaces `undecided` with asking a person.

import type { Request } from "../../../shared/transcript";
import type { Decision } from "./adapter";

export type PolicyVerdict = { verdict: "allow"; source: string; reason?: string } | { verdict: "deny"; source: string; reason: string } | { verdict: "undecided" };

export type PolicyStep = (r: Request) => PolicyVerdict | Promise<PolicyVerdict>;

export const NO_APPROVALS_YET =
  "Tether can't show approval prompts yet, so this was denied. To let Claude act, pick another permission mode (Accept edits or Bypass permissions) in the session header.";

/** A decision and who made it: a policy step's source, or "tether" when nobody could. */
export type BrokerResult = Decision & { source: string };

export class RequestBroker {
  constructor(private steps: PolicyStep[] = []) {}

  async decide(r: Request): Promise<BrokerResult> {
    for (const step of this.steps) {
      const v = await step(r);
      if (v.verdict === "allow") return { allow: true, source: v.source };
      if (v.verdict === "deny") return { allow: false, reason: v.reason, source: v.source };
    }
    return { allow: false, reason: NO_APPROVALS_YET, source: "tether" };
  }
}
