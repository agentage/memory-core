// MemoryCache: the shared cache contract plus the two guarantees only a bounded
// in-process cache can make - LRU eviction order and a byte budget that is never
// exceeded, re-checked after every single operation.

import fc from 'fast-check';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../../src/index.js';
import { bytes, cacheSuite, same } from './cache-suite.js';

cacheSuite({ name: 'MemoryCache', make: () => new MemoryCache({ maxBytes: 64 * 1024 * 1024 }) });

const RUNS = Number(process.env.FUZZ_RUNS ?? 40);
const cost = (key: string, len: number): number => Buffer.byteLength(key, 'utf8') + len;

describe('MemoryCache: budget + eviction', () => {
  it('evicts the least recently used entry when an insert overflows', async () => {
    const cache = new MemoryCache({ maxBytes: cost('a', 10) * 3 });
    for (const key of ['a', 'b', 'c']) await cache.set(key, new Uint8Array(10));
    await cache.get('a'); // a becomes most recent, b is now the LRU victim
    await cache.set('d', new Uint8Array(10));

    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('a')).not.toBeNull();
    expect(await cache.get('c')).not.toBeNull();
    expect(await cache.get('d')).not.toBeNull();
    expect(cache.bytes).toBe(cost('a', 10) * 3);
  });

  it('evicts as many entries as one insert needs', async () => {
    const cache = new MemoryCache({ maxBytes: cost('a', 10) * 3 });
    for (const key of ['a', 'b', 'c']) await cache.set(key, new Uint8Array(10));
    await cache.set('d', new Uint8Array(32));

    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toBeNull();
    expect(await cache.get('c')).toBeNull();
    expect(same(await cache.get('d'), new Uint8Array(32))).toBe(true);
    expect(cache.bytes).toBeLessThanOrEqual(33);
  });

  it('counts key bytes as well as value bytes', async () => {
    const cache = new MemoryCache({ maxBytes: 1000 });
    await cache.set('日本語', new Uint8Array(4)); // 9 utf8 key bytes, not 3 chars
    expect(cache.bytes).toBe(13);
  });

  it('refuses a value larger than the whole budget without evicting anything', async () => {
    const cache = new MemoryCache({ maxBytes: 100 });
    await cache.set('keep', new Uint8Array(10));
    await cache.set('huge', new Uint8Array(500));

    expect(await cache.get('huge')).toBeNull();
    expect(same(await cache.get('keep'), new Uint8Array(10))).toBe(true);
    expect(cache.bytes).toBe(cost('keep', 10));
  });

  it('drops the stale entry when an overwrite cannot fit', async () => {
    const cache = new MemoryCache({ maxBytes: 100 });
    await cache.set('k', bytes('old'));
    await cache.set('k', new Uint8Array(500));
    expect(await cache.get('k')).toBeNull(); // never serve the superseded value
    expect(cache.bytes).toBe(0);
  });

  it('re-accounts an overwrite instead of double counting', async () => {
    const cache = new MemoryCache({ maxBytes: 1000 });
    await cache.set('k', new Uint8Array(100));
    await cache.set('k', new Uint8Array(20));
    expect(cache.bytes).toBe(cost('k', 20));
    expect(cache.size).toBe(1);
  });

  it('frees bytes on a prefix sweep', async () => {
    const cache = new MemoryCache({ maxBytes: 1000 });
    await cache.set('a/1', new Uint8Array(10));
    await cache.set('b/1', new Uint8Array(10));
    await cache.delete('a/');
    expect(cache.bytes).toBe(cost('b/1', 10));
    expect(cache.size).toBe(1);
  });

  it('stores nothing at all with a zero budget and never throws', async () => {
    const cache = new MemoryCache({ maxBytes: 0 });
    await expect(cache.set('k', bytes('v'))).resolves.toBeUndefined();
    expect(await cache.get('k')).toBeNull();
    expect(cache.bytes).toBe(0);
  });

  it('copies on write so a later mutation of the caller buffer cannot change it', async () => {
    const cache = new MemoryCache({ maxBytes: 1000 });
    const value = bytes('abc');
    await cache.set('k', value);
    value.fill(0);
    expect(same(await cache.get('k'), bytes('abc'))).toBe(true);
  });

  it('never exceeds the byte budget, checked after every op', async () => {
    const maxBytes = 4096;
    const opArb = fc.oneof(
      fc.record({
        kind: fc.constant('set' as const),
        key: fc.stringMatching(/^[a-z]{1,40}\/[a-z0-9]{1,6}$/),
        len: fc.integer({ min: 0, max: 2048 }),
      }),
      fc.record({
        kind: fc.constant('get' as const),
        key: fc.stringMatching(/^[a-z]{1,40}\/[a-z0-9]{1,6}$/),
        len: fc.constant(0),
      }),
      fc.record({
        kind: fc.constant('delete' as const),
        key: fc.stringMatching(/^[a-z]{1,4}$/),
        len: fc.constant(0),
      })
    );

    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 60 }), async (ops) => {
        const cache = new MemoryCache({ maxBytes });
        const seen = new Set<string>();
        for (const op of ops) {
          if (op.kind === 'set') {
            seen.add(op.key);
            await cache.set(op.key, new Uint8Array(op.len));
          } else if (op.kind === 'get') {
            await cache.get(op.key);
          } else {
            await cache.delete(op.key);
          }
          if (cache.bytes > maxBytes || cache.bytes < 0) return false;
          if ((cache.size === 0) !== (cache.bytes === 0)) return false;
          // Accounting oracle: the tracked total must equal what is actually reachable.
          let live = 0;
          for (const key of seen) {
            const got = await cache.get(key);
            if (got) live += cost(key, got.length);
          }
          if (live !== cache.bytes) return false;
        }
        return true;
      }),
      { numRuns: RUNS }
    );
  });
});
