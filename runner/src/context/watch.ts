// Watches the import sources and calls back (debounced) when one changes. Files are watched
// through their directory, since editors and harnesses replace files rather than write in place.
// Changes Tether made itself (`isOwn`) don't count, so exports never trigger an import. A slow
// poll backs the watchers up (missed events, sources that appear later).

import { watch, statSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";

export class Watcher {
  private watchers = new Map<string, FSWatcher>();
  /** dir → file names of interest (undefined: everything in it) */
  private filters = new Map<string, Set<string> | undefined>();
  private timer?: ReturnType<typeof setTimeout>;
  private poller?: ReturnType<typeof setInterval>;

  constructor(
    private onChange: () => void,
    private opts: { debounceMs?: number; pollMs?: number; isOwn?: (path: string) => boolean } = {},
  ) {}

  /** Watches these paths (dirs or files) in addition to what is already watched. */
  add(targets: string[]) {
    for (const t of targets) {
      const isDir = statSync(t, { throwIfNoEntry: false })?.isDirectory();
      const dir = isDir ? t : dirname(t);
      if (isDir) this.filters.set(dir, undefined);
      else if (this.filters.has(dir)) this.filters.get(dir)?.add(basename(t));
      else this.filters.set(dir, new Set([basename(t)]));
      if (this.watchers.has(dir)) continue;
      try {
        const w = watch(dir, { persistent: false }, (_ev, name) => this.event(dir, name ? String(name) : undefined));
        w.on("error", () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch {}
    }
    if (!this.poller && this.opts.pollMs) this.poller = setInterval(() => this.onChange(), this.opts.pollMs);
  }

  /** Exposed for tests: what a filesystem event does. */
  event(dir: string, name: string | undefined) {
    if (!this.filters.has(dir)) return;
    const filter = this.filters.get(dir);
    if (name && filter && !filter.has(name)) return;
    if (name?.endsWith(".tether-tmp")) return; // our own atomic writes, mid-flight
    if (name && this.opts.isOwn?.(join(dir, name))) return;
    this.schedule();
  }

  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onChange(), this.opts.debounceMs ?? 5_000);
  }

  get watching(): string[] {
    return [...this.watchers.keys()];
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.poller);
    this.poller = undefined;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}
