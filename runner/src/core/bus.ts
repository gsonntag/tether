// A typed in-process event bus. Listeners run synchronously in subscription order; one that
// throws is reported and never stops the others or the emitter.

export type Listener<T> = (payload: T) => void;

export class EventBus<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<any>>>();

  constructor(private onListenerError: (event: keyof Events, err: unknown) => void = (e, err) => console.error(`listener for ${String(e)} failed:`, err)) {}

  /** Returns the unsubscribe function. */
  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => void set.delete(fn);
  }

  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(event, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        this.onListenerError(event, err);
      }
    }
  }
}
