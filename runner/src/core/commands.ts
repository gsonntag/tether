// Typed commands the core answers itself (SPEC §9 Commands); the rest go to the harness as messages.
// Branches only on what the adapter says, never on the harness.

import { randomUUID } from "node:crypto";
import { needsTerminal, parseCommand, type HarnessCommand } from "../../../shared/commands";
import { modelLabel } from "../../../shared/labels";
import type { ModelList, Msg } from "../../../shared/transcript";
import type { Session } from "./session";
import type { SessionCore } from "./sessions";

export interface CommandHost {
  core: SessionCore;
  models(s: Session): Promise<ModelList>;
  setModel(id: string, model: string): Promise<void>;
  setEffort(id: string, effort: string): Promise<void>;
  /** a turn's worth of status change, so the queue moves on */
  status(s: Session, status: "running" | "idle"): void;
}

const said = (text: string, level: Msg["level"] = "info"): Msg => ({ id: `n-${randomUUID()}`, role: "notice", level, ts: Date.now(), parts: [{ type: "text", text }] });

export class Commands {
  constructor(private h: CommandHost) {}

  async list(id: string): Promise<HarnessCommand[]> {
    const s = await this.h.core.open(id);
    const a = this.h.core.adapter(s.summary.harness);
    if (!a.capabilities.commands || !a.listCommands) return [];
    return a.listCommands(s.summary.projectPath, s.driver);
  }

  /** Text that waits for the turn instead of steering it. */
  async isCommand(s: Session, text: string): Promise<boolean> {
    if (!this.h.core.adapter(s.summary.harness).capabilities.commands) return false;
    return this.routed(s, text) || !!(await s.driver?.isCommand?.(text));
  }

  /** What the core does with this text, if anything (no await: a send checks and claims the session at once). */
  private route(s: Session, text: string) {
    const c = parseCommand(text);
    const a = this.h.core.adapter(s.summary.harness);
    const route = c && a.capabilities.commands ? a.commandRoute?.(c.name, c.args) : undefined;
    return c && route ? { name: c.name, route } : undefined;
  }

  routed(s: Session, text: string) {
    return !!this.route(s, text);
  }

  /** Answers a text that's `routed`: nothing goes to the harness. */
  async run(s: Session, text: string) {
    const r = this.route(s, text);
    if (!r) return;
    const { name, route } = r;
    await this.h.core.load(s);
    this.h.status(s, "running");
    s.apply({ type: "msg", msg: { id: randomUUID(), role: "user", ts: Date.now(), localCommand: true, parts: [{ type: "text", text: text.trim() }] } });
    try {
      s.apply({ type: "msg", msg: "terminal" in route ? said(needsTerminal(name)) : await this.setting(s, route.setting, route.value) });
    } catch (e) {
      s.apply({ type: "msg", msg: said((e as Error)?.message ?? String(e), "error") });
    }
    this.h.status(s, "idle");
  }

  private async setting(s: Session, what: "model" | "effort" | "title", value?: string): Promise<Msg> {
    if (what === "title") {
      this.h.core.o.prefs.set(s.id, { title: value });
      this.h.core.o.prefs.flush();
      this.h.core.touch(s, { title: value });
      return said(`Renamed to ${value}`);
    }
    const list = await this.h.models(s);
    const same = (x?: string) => x?.toLowerCase() === value?.toLowerCase();
    if (what === "model") {
      if (!value) return said(`Model: ${modelLabel(s.state.model, list.models, s.state.modelResolved)}`);
      const hit = list.models.find((m) => same(m.id) || same(m.label) || same(m.resolved));
      if (!hit) return said(`No model ${value}.`, "warning");
      await this.h.setModel(s.id, hit.id);
      return said(`Model: ${hit.label}`);
    }
    const label = (id?: string) => list.efforts.find((e) => e.id === id)?.label ?? id ?? "Default";
    if (!value) return said(`Effort: ${label(s.state.effort)}`);
    const hit = list.efforts.find((e) => same(e.id) || same(e.label));
    if (!hit) return said(`No effort ${value}.`, "warning");
    await this.h.setEffort(s.id, hit.id);
    return said(`Effort: ${hit.label}`);
  }
}
