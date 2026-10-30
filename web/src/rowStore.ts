// Rows' own state, kept outside the rows (sessionContext.ts useRowState).

export class RowStore {
  private map = new Map<string, unknown>();
  get<T>(key: string, initial: T): T {
    return this.map.has(key) ? (this.map.get(key) as T) : initial;
  }
  set(key: string, v: unknown) {
    this.map.set(key, v);
  }
}
