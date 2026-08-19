// Shared live objects keyed by an OPAQUE string, bounded by object COUNT (never
// bytes) - the host decides what an object is and what a key means. Construct
// ONCE per process and keep it: a per-call instance caches nothing. Values are
// rebuildable by construction, so eviction loses nothing durable; `dispose` is
// best-effort cleanup (close a handle, stop a timer), never a correctness hook.

export interface ObjectCacheOptions<T> {
  max: number; // live objects, >= 1
  dispose?: (value: T, key: string) => void;
}

export class ObjectCache<T> {
  readonly #max: number;
  readonly #dispose: ((value: T, key: string) => void) | undefined;
  // Map preserves insertion order - re-set on access makes it an LRU.
  readonly #live = new Map<string, T>();

  constructor(opts: ObjectCacheOptions<T>) {
    if (!Number.isInteger(opts.max) || opts.max < 1)
      throw new RangeError(`ObjectCache max must be an integer >= 1, got ${opts.max}`);
    this.#max = opts.max;
    this.#dispose = opts.dispose;
  }

  get size(): number {
    return this.#live.size;
  }

  get(key: string, create: () => T): T {
    if (this.#live.has(key)) {
      const hit = this.#live.get(key) as T;
      this.#live.delete(key);
      this.#live.set(key, hit); // refresh LRU position
      return hit;
    }
    const value = create(); // a throwing create remembers nothing
    this.#live.set(key, value);
    if (this.#live.size > this.#max) this.#drop(this.#live.keys().next().value!);
    return value;
  }

  delete(key: string): void {
    if (this.#live.has(key)) this.#drop(key);
  }

  #drop(key: string): void {
    const value = this.#live.get(key) as T;
    this.#live.delete(key);
    try {
      this.#dispose?.(value, key);
    } catch {
      // cleanup is best-effort - a throwing dispose must not corrupt the cache
    }
  }
}
