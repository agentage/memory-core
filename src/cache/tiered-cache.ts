// Two caches as one: a small fast tier in front of a large slow one. Reads fall
// through and promote, writes go to both, sweeps hit both. A sick tier is a miss,
// never an exception - the whole point of a cache is that losing it costs latency,
// not correctness. Construct ONCE per process, like the tiers it wraps.

import type { Cache } from './cache.js';

const quiet = async (run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch {
    /* best-effort by contract: a tier that cannot write is a tier that will miss */
  }
};

export class TieredCache implements Cache {
  readonly #hot: Cache;
  readonly #cold: Cache;

  constructor(hot: Cache, cold: Cache) {
    this.#hot = hot;
    this.#cold = cold;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const hot = await this.#tryGet(this.#hot, key);
    if (hot !== null) return hot; // an empty value is a hit, not a miss
    const cold = await this.#tryGet(this.#cold, key);
    if (cold === null) return null;
    await quiet(() => this.#hot.set(key, cold)); // promote: the next read is hot
    return cold;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await Promise.all([
      quiet(() => this.#hot.set(key, value)),
      quiet(() => this.#cold.set(key, value)),
    ]);
  }

  async delete(prefix: string): Promise<void> {
    await Promise.all([
      quiet(() => this.#hot.delete(prefix)),
      quiet(() => this.#cold.delete(prefix)),
    ]);
  }

  async #tryGet(tier: Cache, key: string): Promise<Uint8Array | null> {
    try {
      return await tier.get(key);
    } catch {
      return null;
    }
  }
}
