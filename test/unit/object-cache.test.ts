// ObjectCache is the engine's only shared-instance primitive, so its contract is
// pinned by oracle: identity (same key = same object), a hard count bound, and
// dispose firing exactly once for anything that leaves the cache.

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { ObjectCache } from '../../src/cache/object-cache.js';

interface Box {
  key: string;
}

const box = (key: string) => (): Box => ({ key });

const never = (key: string) => (): Box => {
  throw new Error(`unexpected create: ${key}`);
};

describe('ObjectCache: identity', () => {
  it('returns the same object for repeated gets of one key', () => {
    const cache = new ObjectCache<Box>({ max: 4 });
    const first = cache.get('a', box('a'));
    expect(cache.get('a', box('a'))).toBe(first);
    expect(cache.get('a', never('a'))).toBe(first);
  });

  it('gives different keys different objects', () => {
    const cache = new ObjectCache<Box>({ max: 4 });
    expect(cache.get('a', box('a'))).not.toBe(cache.get('b', box('b')));
  });

  it('calls create exactly once per resident key', () => {
    const create = vi.fn(box('a'));
    const cache = new ObjectCache<Box>({ max: 2 });
    for (let i = 0; i < 5; i++) cache.get('a', create);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('caches falsy values without re-creating them', () => {
    const create = vi.fn((): number => 0);
    const cache = new ObjectCache<number>({ max: 2 });
    expect(cache.get('zero', create)).toBe(0);
    expect(cache.get('zero', create)).toBe(0);
    expect(create).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
  });

  it('remembers nothing when create throws', () => {
    const cache = new ObjectCache<Box>({ max: 2 });
    expect(() => cache.get('a', never('a'))).toThrow(/unexpected create/);
    expect(cache.size).toBe(0);
  });

  it('rejects a max below 1', () => {
    expect(() => new ObjectCache<Box>({ max: 0 })).toThrow(RangeError);
    expect(() => new ObjectCache<Box>({ max: 1.5 })).toThrow(RangeError);
  });
});

describe('ObjectCache: LRU bound', () => {
  it('keeps size <= max and evicts the least recently used key (property)', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    const opArb = fc.record({
      kind: fc.constantFrom('get' as const, 'delete' as const),
      key: fc.constantFrom(...keys),
    });

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.array(opArb, { maxLength: 40 }),
        (max, ops) => {
          const disposed: string[] = [];
          const cache = new ObjectCache<Box>({ max, dispose: (_v, k) => disposed.push(k) });
          let order: string[] = []; // oracle: least recently used first

          for (const op of ops) {
            const before = disposed.length;
            const resident = order.includes(op.key);

            if (op.kind === 'get') {
              cache.get(op.key, box(op.key));
              order = order.filter((k) => k !== op.key);
              order.push(op.key);
              const evicted = !resident && order.length > max ? [order.shift()!] : [];
              expect(disposed.slice(before)).toEqual(evicted);
            } else {
              cache.delete(op.key);
              order = order.filter((k) => k !== op.key);
              expect(disposed.slice(before)).toEqual(resident ? [op.key] : []);
            }

            expect(cache.size).toBe(order.length);
            expect(cache.size).toBeLessThanOrEqual(max);
          }

          // residency oracle: every modelled key hits, so create is never called
          for (const k of order) expect(cache.get(k, never(k))).toEqual({ key: k });
        }
      ),
      { numRuns: Number(process.env.FUZZ_RUNS ?? 75) }
    );
  });

  it('refreshes recency on a hit', () => {
    const disposed: string[] = [];
    const cache = new ObjectCache<Box>({ max: 2, dispose: (_v, k) => disposed.push(k) });
    cache.get('a', box('a'));
    cache.get('b', box('b'));
    cache.get('a', box('a')); // 'a' is now the most recently used - 'b' is next out
    cache.get('c', box('c'));
    expect(disposed).toEqual(['b']);
    expect(cache.get('a', never('a'))).toBeDefined();
  });

  it('holds one object at max=1', () => {
    const disposed: string[] = [];
    const cache = new ObjectCache<Box>({ max: 1, dispose: (_v, k) => disposed.push(k) });
    for (const k of ['a', 'b', 'c']) {
      cache.get(k, box(k));
      expect(cache.size).toBe(1);
    }
    expect(disposed).toEqual(['a', 'b']);
  });

  it('tracks size across creates, evictions and deletes', () => {
    const cache = new ObjectCache<Box>({ max: 2 });
    expect(cache.size).toBe(0);
    cache.get('a', box('a'));
    expect(cache.size).toBe(1);
    cache.get('b', box('b'));
    cache.get('a', box('a'));
    expect(cache.size).toBe(2);
    cache.get('c', box('c'));
    expect(cache.size).toBe(2);
    cache.delete('c');
    expect(cache.size).toBe(1);
    cache.delete('nope');
    expect(cache.size).toBe(1);
  });

  it('creates a fresh object after eviction', () => {
    const cache = new ObjectCache<Box>({ max: 1 });
    const first = cache.get('a', box('a'));
    cache.get('b', box('b'));
    const create = vi.fn(box('a'));
    const second = cache.get('a', create);
    expect(create).toHaveBeenCalledTimes(1);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe('ObjectCache: dispose', () => {
  it('fires exactly once per eviction, with the value and key', () => {
    const dispose = vi.fn<(v: Box, k: string) => void>();
    const cache = new ObjectCache<Box>({ max: 1, dispose });
    const first = cache.get('a', box('a'));
    cache.get('b', box('b'));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(first, 'a');
  });

  it('fires exactly once per delete and never again', () => {
    const dispose = vi.fn<(v: Box, k: string) => void>();
    const cache = new ObjectCache<Box>({ max: 2, dispose });
    cache.get('a', box('a'));
    cache.delete('a');
    cache.delete('a');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('never fires for a live object', () => {
    const dispose = vi.fn<(v: Box, k: string) => void>();
    const cache = new ObjectCache<Box>({ max: 3, dispose });
    for (const k of ['a', 'b', 'c', 'a', 'b']) cache.get(k, box(k));
    expect(dispose).not.toHaveBeenCalled();
  });

  it('is a no-op on a missing key', () => {
    const dispose = vi.fn<(v: Box, k: string) => void>();
    const cache = new ObjectCache<Box>({ max: 2, dispose });
    cache.get('a', box('a'));
    cache.delete('missing');
    expect(dispose).not.toHaveBeenCalled();
    expect(cache.size).toBe(1);
    expect(cache.get('a', never('a'))).toBeDefined();
  });

  it('swallows a throwing dispose and keeps working', () => {
    const disposed: string[] = [];
    const cache = new ObjectCache<Box>({
      max: 1,
      dispose: (_v, k) => {
        disposed.push(k);
        throw new Error('dispose blew up');
      },
    });
    cache.get('a', box('a'));
    expect(() => cache.get('b', box('b'))).not.toThrow();
    expect(() => cache.delete('b')).not.toThrow();
    expect(disposed).toEqual(['a', 'b']);
    expect(cache.size).toBe(0);
    expect(cache.get('c', box('c'))).toEqual({ key: 'c' });
    expect(cache.size).toBe(1);
  });
});
