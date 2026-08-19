// In-process LRU cache bounded by total bytes (keys counted with values, since a
// million long keys cost real memory). Construct ONCE per process and share the
// instance: the budget is only a budget if every caller draws on the same pool -
// a per-request `new MemoryCache` is an unbounded leak wearing a bound's clothes.

import { Buffer } from 'node:buffer';
import type { Cache } from './cache.js';

export interface MemoryCacheOptions {
  maxBytes: number;
}

interface Entry {
  value: Uint8Array;
  cost: number;
}

export class MemoryCache implements Cache {
  readonly maxBytes: number;
  // Map iteration order IS the LRU order: oldest first, re-insert to promote.
  readonly #entries = new Map<string, Entry>();
  #bytes = 0;

  constructor(options: MemoryCacheOptions) {
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes));
  }

  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    // Copy via the Uint8Array ctor: Buffer#slice returns a VIEW, which would alias.
    return new Uint8Array(entry.value);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    const previous = this.#entries.get(key);
    if (previous) {
      // Drop first: a superseded value must never survive a failed overwrite.
      this.#entries.delete(key);
      this.#bytes -= previous.cost;
    }
    const cost = Buffer.byteLength(key, 'utf8') + value.byteLength;
    if (cost > this.maxBytes) return; // never flush the whole cache for a value that cannot fit
    // Oldest first, so the walk stops the moment the newcomer fits.
    for (const [victim, entry] of this.#entries) {
      if (this.#bytes + cost <= this.maxBytes) break;
      this.#entries.delete(victim);
      this.#bytes -= entry.cost;
    }
    this.#entries.set(key, { value: new Uint8Array(value), cost });
    this.#bytes += cost;
  }

  async delete(prefix: string): Promise<void> {
    for (const [key, entry] of this.#entries) {
      if (!key.startsWith(prefix)) continue;
      this.#entries.delete(key);
      this.#bytes -= entry.cost;
    }
  }
}
