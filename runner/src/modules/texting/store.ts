// Texting's settings and the router's state (texting.json in the module's folder, mode 600). The
// Photon project's id and secret and the phone may instead come from the runner's environment
// (runner.env): TETHER_PHOTON_PROJECT_ID, TETHER_PHOTON_PROJECT_SECRET, TETHER_TEXT_PHONE. Those win.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TextingStatus } from "../../../../shared/protocol";
import { registerSecret } from "../../credentials";
import { emptyState, type RouterState } from "./router";

export interface TextingSettings {
  enabled?: boolean;
  phone?: string;
  projectId?: string;
  projectSecret?: string;
}

/** What the link needs; undefined when something is missing. */
export interface LinkConfig {
  phone: string;
  projectId: string;
  projectSecret: string;
}

type Env = Record<string, string | undefined>;

/** "+1 (310) 555-1234" → "+13105551234"; undefined when it isn't a phone number. */
export function normalPhone(v: string): string | undefined {
  const digits = v.replace(/[\s().-]/g, "");
  if (!/^\+?\d{7,15}$/.test(digits)) return undefined;
  return digits.startsWith("+") ? digits : digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export class TextingStore {
  settings: TextingSettings = {};
  router: RouterState = emptyState();

  constructor(
    private file?: string,
    private env: Env = process.env,
  ) {
    if (file) {
      try {
        const v = JSON.parse(readFileSync(file, "utf8"));
        if (v?.settings && typeof v.settings === "object") this.settings = v.settings;
        if (Array.isArray(v?.router?.slots) && Array.isArray(v?.router?.sent)) this.router = v.router;
      } catch {}
    }
    for (const k of [this.settings.projectSecret, this.env.TETHER_PHOTON_PROJECT_SECRET]) if (k) registerSecret(k);
  }

  private envPhone = () => this.env.TETHER_TEXT_PHONE?.trim() || undefined;
  private envKeys = () => !!(this.env.TETHER_PHOTON_PROJECT_ID?.trim() && this.env.TETHER_PHOTON_PROJECT_SECRET?.trim());

  /** Everything the link needs, if texting is on and set. */
  config(): LinkConfig | undefined {
    if (!this.enabled()) return undefined;
    const phone = normalPhone(this.envPhone() ?? this.settings.phone ?? "");
    const [projectId, projectSecret] = this.envKeys()
      ? [this.env.TETHER_PHOTON_PROJECT_ID!.trim(), this.env.TETHER_PHOTON_PROJECT_SECRET!.trim()]
      : [this.settings.projectId, this.settings.projectSecret];
    return phone && projectId && projectSecret ? { phone, projectId, projectSecret } : undefined;
  }

  /** On unless turned off; set in runner.env counts as wanting it. */
  enabled(): boolean {
    return this.settings.enabled ?? (this.envKeys() && !!this.envPhone());
  }

  status(link: { connected: boolean; lastError?: string }): TextingStatus {
    const phone = normalPhone(this.envPhone() ?? this.settings.phone ?? "");
    return {
      enabled: this.enabled(),
      phoneLast4: phone?.slice(-4),
      keysSet: this.envKeys() || !!(this.settings.projectId && this.settings.projectSecret),
      fromEnv: { phone: !!this.envPhone(), keys: this.envKeys() },
      connected: link.connected,
      lastError: link.lastError,
    };
  }

  /** An empty string clears a field. Throws on a phone that isn't one. */
  update(a: { enabled?: unknown; phone?: unknown; projectId?: unknown; projectSecret?: unknown }) {
    const next = { ...this.settings };
    if (typeof a.enabled === "boolean") next.enabled = a.enabled;
    if (typeof a.phone === "string") {
      const p = a.phone.trim() ? normalPhone(a.phone) : "";
      if (p === undefined) throw new Error("That isn't a phone number. Use the full number, like +13105551234.");
      next.phone = p || undefined;
    }
    for (const k of ["projectId", "projectSecret"] as const) {
      const v = a[k];
      if (typeof v !== "string") continue;
      if (v.length > 500) throw new Error("That key is too long.");
      next[k] = v.trim() || undefined;
    }
    if (next.projectSecret) registerSecret(next.projectSecret);
    this.settings = next;
    this.save();
  }

  save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ settings: this.settings, router: this.router }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch {}
  }
}
