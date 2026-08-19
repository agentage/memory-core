// TieredCache: the shared cache contract plus the tiering guarantees - promote on
// a cold hit, write through to both, sweep both, and never let a sick tier throw.

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileCache, MemoryCache, TieredCache, type Cache } from '../../src/index.js';
import { bytes, cacheSuite, same } from './cache-suite.js';

const makeDir = (): Promise<string> => mkdtemp(join(tmpdir(), 'store-core-tiered-'));

cacheSuite({
  name: 'TieredCache',
  make: async () =>
    new TieredCache(
      new MemoryCache({ maxBytes: 64 * 1024 * 1024 }),
      new FileCache({ dir: await makeDir() })
    ),
});

interface Counts {
  get: number;
  set: number;
  delete: number;
}

const counting = (inner: Cache): { cache: Cache; counts: Counts } => {
  const counts: Counts = { get: 0, set: 0, delete: 0 };
  const cache: Cache = {
    get: (key) => {
      counts.get += 1;
      return inner.get(key);
    },
    set: (key, value) => {
      counts.set += 1;
      return inner.set(key, value);
    },
    delete: (prefix) => {
      counts.delete += 1;
      return inner.delete(prefix);
    },
  };
  return { cache, counts };
};

const sick: Cache = {
  get: () => Promise.reject(new Error('tier is down')),
  set: () => Promise.reject(new Error('tier is down')),
  delete: () => Promise.reject(new Error('tier is down')),
};

describe('TieredCache: tiering', () => {
  let hot: MemoryCache;
  let cold: MemoryCache;
  let tiered: TieredCache;

  beforeEach(() => {
    hot = new MemoryCache({ maxBytes: 1024 });
    cold = new MemoryCache({ maxBytes: 1024 * 1024 });
    tiered = new TieredCache(hot, cold);
  });

  it('writes through to both tiers', async () => {
    await tiered.set('k', bytes('v'));
    expect(same(await hot.get('k'), bytes('v'))).toBe(true);
    expect(same(await cold.get('k'), bytes('v'))).toBe(true);
  });

  it('promotes into hot on a cold hit', async () => {
    await cold.set('k', bytes('cold value'));
    expect(await hot.get('k')).toBeNull();

    expect(same(await tiered.get('k'), bytes('cold value'))).toBe(true);
    expect(same(await hot.get('k'), bytes('cold value'))).toBe(true);
  });

  it('promotes an empty value as a hit, not as a miss', async () => {
    await cold.set('k', new Uint8Array(0));
    const got = await tiered.get('k');
    expect(got).not.toBeNull();
    expect(got!.length).toBe(0);
    expect(await hot.get('k')).not.toBeNull();
  });

  it('does not consult cold when hot hits', async () => {
    const wrapped = counting(cold);
    const t = new TieredCache(hot, wrapped.cache);
    await t.set('k', bytes('v'));
    wrapped.counts.get = 0;
    expect(same(await t.get('k'), bytes('v'))).toBe(true);
    expect(wrapped.counts.get).toBe(0);
  });

  it('serves from cold after hot evicts, then re-promotes', async () => {
    const tiny = new MemoryCache({ maxBytes: 40 });
    const t = new TieredCache(tiny, cold);
    await t.set('a', new Uint8Array(30));
    await t.set('b', new Uint8Array(30)); // evicts a from hot, cold still has it

    expect(await tiny.get('a')).toBeNull();
    expect(same(await t.get('a'), new Uint8Array(30))).toBe(true);
    expect(same(await tiny.get('a'), new Uint8Array(30))).toBe(true);
  });

  it('returns null when neither tier has the key', async () => {
    expect(await tiered.get('nope')).toBeNull();
  });

  it('sweeps both tiers on delete', async () => {
    await tiered.set('a/1', bytes('one'));
    await tiered.set('b/1', bytes('two'));
    await tiered.delete('a/');

    expect(await hot.get('a/1')).toBeNull();
    expect(await cold.get('a/1')).toBeNull();
    expect(same(await cold.get('b/1'), bytes('two'))).toBe(true);
  });

  it('works over a real disk cold tier', async () => {
    const disk = new FileCache({ dir: await makeDir() });
    const t = new TieredCache(new MemoryCache({ maxBytes: 40 }), disk);
    await t.set('big/1', new Uint8Array(4096));
    expect(same(await t.get('big/1'), new Uint8Array(4096))).toBe(true);
    expect(same(await disk.get('big/1'), new Uint8Array(4096))).toBe(true);
  });

  it('never throws when the hot tier is sick', async () => {
    const t = new TieredCache(sick, cold);
    await expect(t.set('k', bytes('v'))).resolves.toBeUndefined();
    expect(same(await t.get('k'), bytes('v'))).toBe(true); // cold still answers
    await expect(t.delete('')).resolves.toBeUndefined();
    expect(await cold.get('k')).toBeNull();
  });

  it('never throws when the cold tier is sick', async () => {
    const t = new TieredCache(hot, sick);
    await expect(t.set('k', bytes('v'))).resolves.toBeUndefined();
    expect(same(await t.get('k'), bytes('v'))).toBe(true); // hot still answers
    expect(await t.get('missing')).toBeNull();
    await expect(t.delete('')).resolves.toBeUndefined();
  });

  it('survives a sick promotion target', async () => {
    const t = new TieredCache(
      { get: () => Promise.resolve(null), set: sick.set, delete: () => Promise.resolve() },
      cold
    );
    await cold.set('k', bytes('v'));
    expect(same(await t.get('k'), bytes('v'))).toBe(true);
  });

  it('nests: a tiered cache is itself a valid tier', async () => {
    const inner = new TieredCache(hot, cold);
    const outer = new TieredCache(new MemoryCache({ maxBytes: 1024 }), inner);
    await outer.set('k', bytes('v'));
    expect(same(await cold.get('k'), bytes('v'))).toBe(true);
    expect(same(await outer.get('k'), bytes('v'))).toBe(true);
  });
});
