// One shared spec every Cache implementation must pass - the same shape as the
// store conformance kit. A cache that passes is swappable for any other. The
// suite asserts nothing about eviction, so a target must hand back a cache with
// room for ~8MB; bounded-capacity behavior is impl-specific and tested there.

import fc from 'fast-check';
import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Cache } from '../../src/index.js';

export interface CacheTarget {
  name: string;
  make: () => Promise<Cache> | Cache;
}

const RUNS = Number(process.env.FUZZ_RUNS ?? 40);

export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

export const same = (got: Uint8Array | null, want: Uint8Array): boolean =>
  got !== null &&
  got.length === want.length &&
  Buffer.compare(
    Buffer.from(got.buffer, got.byteOffset, got.length),
    Buffer.from(want.buffer, want.byteOffset, want.length)
  ) === 0;

// One pre-built multi-MB payload mixed in by weight: generating megabytes per
// run would dominate the suite, but the big-value path still gets exercised.
export const BIG = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => (i * 7) % 251);

// Hostile keys: separators, scheme/auth punctuation, traversal, unicode, spaces.
const HOSTILE_SEGMENTS = [
  '..',
  '.',
  '...',
  'a:b',
  'user@host',
  'C:\\win',
  'sp ace',
  'q"uote"',
  'star*',
  'quest?',
  'pipe|',
  'semi;colon',
  '<angle>',
  'per%2e%2ecent',
  'tilde~',
  'dollar$',
  'уникод',
  '日本語',
  'cafe\u0301',
  'caf\u00e9',
  'emoji🔥',
  'CON',
  'NUL.md',
  '-dash',
  'trailing.',
];

export const keyArb = fc
  .array(
    fc.oneof(
      fc.stringMatching(/^[a-zA-Z0-9_.-]{1,12}$/),
      fc.constantFrom(...HOSTILE_SEGMENTS),
      fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 })
    ),
    { minLength: 1, maxLength: 4 }
  )
  .map((segments) => segments.join('/'))
  // Control characters are not "printable keys" and NUL breaks every filesystem.
  .filter((key) => key.length > 0 && !Array.from(key).some((ch) => ch < ' ' || ch === '\u007f'));

export const payloadArb = fc.oneof(
  { weight: 8, arbitrary: fc.uint8Array({ maxLength: 512 }) },
  { weight: 1, arbitrary: fc.constant(new Uint8Array(0)) },
  { weight: 1, arbitrary: fc.constant(BIG) }
);

export const cacheSuite = (t: CacheTarget): void => {
  describe(`${t.name}: cache contract`, () => {
    let cache: Cache;
    beforeEach(async () => {
      cache = await t.make();
    });

    describe('round-trip', () => {
      it('returns exact bytes for hostile keys and arbitrary payloads', async () => {
        await fc.assert(
          fc.asyncProperty(keyArb, payloadArb, async (key, value) => {
            const fresh = await t.make();
            await fresh.set(key, value);
            return same(await fresh.get(key), value);
          }),
          { numRuns: RUNS }
        );
      });

      it('round-trips an empty value as empty bytes, not as a miss', async () => {
        await cache.set('empty', new Uint8Array(0));
        const got = await cache.get('empty');
        expect(got).not.toBeNull();
        expect(got!.length).toBe(0);
      });

      it('round-trips a multi-MB payload byte for byte', async () => {
        await cache.set('big/blob', BIG);
        expect(same(await cache.get('big/blob'), BIG)).toBe(true);
      });

      it('round-trips a very long key', async () => {
        const key = `long/${'k'.repeat(400)}/tail`;
        await cache.set(key, bytes('ok'));
        expect(same(await cache.get(key), bytes('ok'))).toBe(true);
      });

      it('keeps composed and decomposed unicode keys distinct', async () => {
        await cache.set('caf\u00e9', bytes('composed'));
        await cache.set('cafe\u0301', bytes('decomposed'));
        expect(same(await cache.get('caf\u00e9'), bytes('composed'))).toBe(true);
        expect(same(await cache.get('cafe\u0301'), bytes('decomposed'))).toBe(true);
      });

      it('does not leak mutations of a returned buffer back into the cache', async () => {
        await cache.set('k', bytes('abc'));
        const first = await cache.get('k');
        first!.fill(0);
        expect(same(await cache.get('k'), bytes('abc'))).toBe(true);
      });
    });

    describe('miss + overwrite', () => {
      it('returns null for a key that was never set', async () => {
        expect(await cache.get('nope')).toBeNull();
      });

      it('returns null for a key that only shares a prefix with a stored key', async () => {
        await cache.set('a/b', bytes('v'));
        expect(await cache.get('a')).toBeNull();
        expect(await cache.get('a/b/c')).toBeNull();
      });

      it('overwrites in place, last write wins', async () => {
        await cache.set('k', bytes('one'));
        await cache.set('k', bytes('two-longer'));
        expect(same(await cache.get('k'), bytes('two-longer'))).toBe(true);
        await cache.set('k', bytes('3'));
        expect(same(await cache.get('k'), bytes('3'))).toBe(true);
      });
    });

    describe('delete(prefix)', () => {
      const seed = async (c: Cache): Promise<void> => {
        for (const key of ['a/1', 'a/2', 'a/deep/3', 'ab/1', 'b/1', 'a']) {
          await c.set(key, bytes(key));
        }
      };

      it('sweeps exactly the keys under the prefix', async () => {
        await seed(cache);
        await cache.delete('a/');
        expect(await cache.get('a/1')).toBeNull();
        expect(await cache.get('a/2')).toBeNull();
        expect(await cache.get('a/deep/3')).toBeNull();
        expect(same(await cache.get('ab/1'), bytes('ab/1'))).toBe(true);
        expect(same(await cache.get('b/1'), bytes('b/1'))).toBe(true);
        expect(same(await cache.get('a'), bytes('a'))).toBe(true);
      });

      it('is a string prefix, not a path prefix', async () => {
        await seed(cache);
        await cache.delete('a');
        expect(await cache.get('a')).toBeNull();
        expect(await cache.get('a/1')).toBeNull();
        expect(await cache.get('ab/1')).toBeNull();
        expect(same(await cache.get('b/1'), bytes('b/1'))).toBe(true);
      });

      it('sweeps everything on the empty prefix', async () => {
        await seed(cache);
        await cache.delete('');
        for (const key of ['a/1', 'a/2', 'a/deep/3', 'ab/1', 'b/1', 'a']) {
          expect(await cache.get(key)).toBeNull();
        }
      });

      it('is a silent no-op for a prefix that matches nothing', async () => {
        await seed(cache);
        await expect(cache.delete('zzz/')).resolves.toBeUndefined();
        expect(same(await cache.get('a/1'), bytes('a/1'))).toBe(true);
      });

      it('is a silent no-op on an untouched cache', async () => {
        await expect(cache.delete('anything')).resolves.toBeUndefined();
      });

      it('sweeps hostile keys too', async () => {
        for (const key of ['p:/../x', 'p:/@y', 'p:/日本', 'q:/keep'])
          await cache.set(key, bytes(key));
        await cache.delete('p:/');
        expect(await cache.get('p:/../x')).toBeNull();
        expect(await cache.get('p:/@y')).toBeNull();
        expect(await cache.get('p:/日本')).toBeNull();
        expect(same(await cache.get('q:/keep'), bytes('q:/keep'))).toBe(true);
      });

      it('lets the key be written again after a sweep', async () => {
        await cache.set('a/1', bytes('one'));
        await cache.delete('a/');
        await cache.set('a/1', bytes('two'));
        expect(same(await cache.get('a/1'), bytes('two'))).toBe(true);
      });
    });

    describe('concurrency', () => {
      it('never tears a value under parallel same-key set + get', async () => {
        const candidates = [
          bytes('a'.repeat(1)),
          bytes('b'.repeat(1000)),
          bytes('c'.repeat(50_000)),
          new Uint8Array(0),
        ];
        const reads: Promise<Uint8Array | null>[] = [];
        const writes: Promise<void>[] = [];
        for (const value of candidates) {
          reads.push(cache.get('hot'));
          writes.push(cache.set('hot', value));
          reads.push(cache.get('hot'));
        }
        await Promise.all(writes);
        const seen = await Promise.all(reads);
        // Any observed value must be one of the whole candidates - never a splice of two.
        for (const got of seen) {
          expect(got === null || candidates.some((c) => same(got, c))).toBe(true);
        }
        const final = await cache.get('hot');
        expect(candidates.some((c) => same(final, c))).toBe(true);
      });

      it('round-trips 60 distinct keys written in parallel', async () => {
        const keys = Array.from({ length: 60 }, (_, i) => `par/${i}:@x`);
        await Promise.all(keys.map((k) => cache.set(k, bytes(`v${k}`))));
        const got = await Promise.all(keys.map((k) => cache.get(k)));
        for (const [i, value] of got.entries()) {
          expect(same(value, bytes(`v${keys[i]}`))).toBe(true);
        }
      });

      it('survives a delete racing sets on the same prefix', async () => {
        const keys = Array.from({ length: 20 }, (_, i) => `race/${i}`);
        await Promise.all([
          ...keys.map((k) => cache.set(k, bytes(k))),
          cache.delete('race/'),
          ...keys.map((k) => cache.get(k)),
        ]);
        // Whatever survived must be intact: a raced sweep may drop values, never corrupt them.
        for (const k of keys) {
          const got = await cache.get(k);
          expect(got === null || same(got, bytes(k))).toBe(true);
        }
      });
    });
  });
};
