// Federated search is the one place the router computes rather than routes: it
// merges N per-vault pages into one. The merged order must be the SAME total
// order a single store guarantees (score desc, updated desc, path asc) and it
// must be re-pageable - a cursor taken mid-page continues exactly where the page
// stopped, with nothing duplicated, skipped, or reordered.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_SEARCH_LIMIT,
  type SeedFile,
  type SearchResult,
  type VaultContainer,
} from '../../src/index.js';
import { createRouter, type Router } from '../../src/router/router.js';
import { world } from './harness.js';

const RUNS = Number(process.env.FUZZ_RUNS ?? 75) / 5;
const STAMPS = ['2026-01-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z', '2026-03-03T00:00:00.000Z'];
const VAULTS = ['alpha', 'beta', 'gamma'] as const;

interface Doc {
  vault: string;
  name: string;
  hits: number;
  stamp: string;
}

// A container that lists the same vaults in the opposite order. The merged order
// must not depend on it - without the path tiebreak a full tie would follow the
// fan-out order instead, and this is the only fixture that can see the difference.
const reverseList = (c: VaultContainer): VaultContainer => ({
  ...c,
  list: async (a) => (await c.list(a)).reverse(),
});

// Both routers share the same stores; only the order their vaults arrive in differs.
const build = async (docs: Doc[]): Promise<{ forward: Router; reversed: Router }> => {
  const seeds: Record<string, SeedFile[]> = { alpha: [], beta: [], gamma: [] };
  const clocks: Record<string, string[]> = { alpha: [], beta: [], gamma: [] };
  for (const d of [...docs].sort((a, b) => a.name.localeCompare(b.name))) {
    seeds[d.vault]?.push({ path: `${d.name}.md`, body: 'zz '.repeat(d.hits).trim() || 'quiet' });
    clocks[d.vault]?.push(d.stamp);
  }
  const w = await world(seeds, { over: { vaults: new Set(VAULTS) }, clocks });
  const opts = { defaultVault: 'alpha' };
  return {
    forward: createRouter(w.container, w.access, opts),
    reversed: createRouter(reverseList(w.container), w.access, opts),
  };
};

// The oracle: the contract's total order over the union, on the tagged paths.
const expected = (docs: Doc[]): string[] =>
  docs
    .filter((d) => d.hits > 0)
    .map((d) => ({ path: `@${d.vault}/${d.name}.md`, score: d.hits, updated: d.stamp }))
    .sort(
      (a, b) =>
        b.score - a.score || b.updated.localeCompare(a.updated) || a.path.localeCompare(b.path)
    )
    .map((d) => d.path);

const drain = async (r: Router, limit: number): Promise<string[]> => {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res: SearchResult = await r.search({ query: 'zz', limit, cursor });
    out.push(...res.results.map((h) => h.path));
    if (!res.nextCursor) return out;
    cursor = res.nextCursor;
  }
  throw new Error('search never stopped paging');
};

const docArb = fc.record({
  vault: fc.constantFrom(...VAULTS),
  name: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
  hits: fc.integer({ min: 0, max: 3 }),
  stamp: fc.constantFrom(...STAMPS),
});

describe('router federated search', () => {
  it('merges three vaults into the contract total order (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(docArb, { selector: (d) => `${d.vault}/${d.name}`, maxLength: 12 }),
        async (docs) => {
          const { forward, reversed } = await build(docs);
          for (const r of [forward, reversed]) {
            const res = await r.search({ query: 'zz', limit: MAX_SEARCH_LIMIT });
            expect(res.results.map((h) => h.path)).toEqual(expected(docs));
          }
        }
      ),
      { numRuns: Math.max(5, Math.round(RUNS)) }
    );
  });

  it('pages the merged set without duplicating, skipping or reordering (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(docArb, { selector: (d) => `${d.vault}/${d.name}`, maxLength: 12 }),
        fc.integer({ min: 1, max: 4 }),
        async (docs, limit) => {
          const { forward, reversed } = await build(docs);
          expect(await drain(forward, limit)).toEqual(expected(docs));
          expect(await drain(reversed, limit)).toEqual(expected(docs));
        }
      ),
      { numRuns: Math.max(5, Math.round(RUNS)) }
    );
  });

  it('continues from a mid-page cursor exactly where the page stopped', async () => {
    const docs: Doc[] = [
      { vault: 'alpha', name: 'a', hits: 3, stamp: STAMPS[1]! },
      { vault: 'beta', name: 'b', hits: 3, stamp: STAMPS[1]! }, // full tie with alpha/a
      { vault: 'gamma', name: 'c', hits: 2, stamp: STAMPS[2]! },
      { vault: 'alpha', name: 'd', hits: 2, stamp: STAMPS[0]! },
      { vault: 'beta', name: 'e', hits: 1, stamp: STAMPS[2]! },
    ];
    const { forward: r } = await build(docs);
    const all = await r.search({ query: 'zz', limit: 50 });
    const paths = all.results.map((h) => h.path);
    expect(paths).toEqual(expected(docs));
    expect(all.nextCursor).toBeUndefined();

    const first = await r.search({ query: 'zz', limit: 2 });
    expect(first.results.map((h) => h.path)).toEqual(paths.slice(0, 2));
    expect(first.nextCursor).toBeDefined();
    const second = await r.search({ query: 'zz', limit: 2, cursor: first.nextCursor });
    expect(second.results.map((h) => h.path)).toEqual(paths.slice(2, 4));
    const third = await r.search({ query: 'zz', limit: 2, cursor: second.nextCursor });
    expect(third.results.map((h) => h.path)).toEqual(paths.slice(4));
    expect(third.nextCursor).toBeUndefined();
  });

  it('is stable across repeated identical calls despite parallel fan-out', async () => {
    const docs: Doc[] = VAULTS.flatMap((vault) =>
      ['a', 'b', 'c'].map((name) => ({ vault, name, hits: 2, stamp: STAMPS[0]! }))
    );
    const { forward: r } = await build(docs);
    const runs = await Promise.all(
      Array.from({ length: 5 }, () => r.search({ query: 'zz', limit: 50 }))
    );
    for (const run of runs) expect(run.results.map((h) => h.path)).toEqual(expected(docs));
  });

  it('caps the merged page at the search limit', async () => {
    const many = (vault: string): Doc[] =>
      Array.from({ length: 40 }, (_, i) => ({
        vault,
        name: `n${String(i).padStart(2, '0')}`,
        hits: 1,
        stamp: STAMPS[0]!,
      }));
    const { forward: r } = await build([...many('alpha'), ...many('beta')]);
    const capped = await r.search({ query: 'zz', limit: 999 });
    expect(capped.results).toHaveLength(MAX_SEARCH_LIMIT);
    expect(capped.nextCursor).toBeDefined();
    const small = await r.search({ query: 'zz', limit: 3 });
    expect(small.results).toHaveLength(3);
  });

  it('applies a plain folder filter inside every vault', async () => {
    const w = await world(
      {
        alpha: [
          { path: 'notes/a.md', body: 'zz' },
          { path: 'other/b.md', body: 'zz' },
        ],
        beta: [{ path: 'notes/c.md', body: 'zz' }],
      },
      { over: { vaults: new Set(['alpha', 'beta']) } }
    );
    const r = createRouter(w.container, w.access, { defaultVault: 'alpha' });
    const res = await r.search({ query: 'zz', folder: 'notes' });
    expect(res.results.map((h) => h.path).sort()).toEqual([
      '@alpha/notes/a.md',
      '@beta/notes/c.md',
    ]);
  });
});
