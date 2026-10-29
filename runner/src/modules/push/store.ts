// Each device's push subscription on this runner (push.json in the module's folder, mode 600).

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PushSub {
  /** the device's own id (it also says what it looks at: presence) */
  deviceId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string;
  addedAt: number;
}

const MAX = 50;

export class SubscriptionStore {
  private subs: PushSub[] = [];

  constructor(private file?: string) {
    if (!file) return;
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(v?.subs)) this.subs = v.subs;
    } catch {}
  }

  list(): PushSub[] {
    return [...this.subs];
  }

  get(endpoint: string) {
    return this.subs.find((s) => s.endpoint === endpoint);
  }

  /** One subscription per device: a new one replaces the device's old one. */
  add(s: Omit<PushSub, "addedAt">) {
    this.subs = [...this.subs.filter((x) => x.endpoint !== s.endpoint && x.deviceId !== s.deviceId), { ...s, addedAt: Date.now() }].slice(-MAX);
    this.save();
  }

  remove(endpoint: string) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.save();
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ subs: this.subs }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch {}
  }
}
