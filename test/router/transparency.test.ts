// The router adds addressing and NOTHING else: strip the `@vault/` tags off a
// response and what is left must be byte-for-byte what calling the store directly
// returns - same values, same cursors, same events, on every verb. That is the
// whole promise of the layer, and it is what makes a store swap invisible above it.

import { beforeEach, describe, expect, it } from 'vitest';
import type { SeedFile, StoreEvent, VaultStore } from '../../src/index.js';
import { createRouter, type Router } from '../../src/router/router.js';
import { world, type World } from './harness.js';

const NOTES: SeedFile[] = [
  { path: 'a.md', body: 'alpha zebra' },
  { path: 'dir/b.md', body: 'beta zebra #tag' },
  { path: 'dir/deep/c.md', body: 'gamma zebra zebra' },
];

const solo = (): Promise<World> => world({ main: NOTES }, { over: { vaults: new Set(['main']) } });

// Remove the addressing layer: `@main/x` -> `x`, `@main` -> the vault root ''.
const untag = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value).replaceAll('"@main/', '"').replaceAll('"@main"', '""')) as T;

describe('router results are the store results, modulo the @vault tag', () => {
  let w: World;
  let r: Router;
  let store: VaultStore;

  beforeEach(async () => {
    w = await solo();
    r = createRouter(w.container, w.access);
    store = await w.direct('main');
  });

  it('read matches, hit and miss, clamped and unclamped', async () => {
    expect(untag(await r.read('@main/a.md'))).toEqual(await store.read('a.md'));
    expect(untag(await r.read('@main/a.md', { clamp: false }))).toEqual(
      await store.read('a.md', { clamp: false })
    );
    expect(untag(await r.read('@main/dir/b.md'))).toEqual(await store.read('dir/b.md'));
    expect(await r.read('@main/missing.md')).toBeNull();
  });

  it('readMany matches the same N store reads, tag aside', async () => {
    const paths = ['a.md', 'missing.md', 'dir/b.md', 'dir/deep/c.md'];
    const refs = paths.map((p) => `@main/${p}`);
    expect(untag(await r.readMany(refs))).toEqual(
      await Promise.all(paths.map((p) => store.read(p)))
    );
    expect(untag(await r.readMany(refs, { clamp: false }))).toEqual(
      await Promise.all(paths.map((p) => store.read(p, { clamp: false })))
    );
  });

  it('list matches across folder, depth, tags and cursor paging', async () => {
    expect(untag(await r.list({ ref: '@main' }))).toEqual(await store.list({}));
    expect(untag(await r.list({ ref: '@main/dir' }))).toEqual(await store.list({ folder: 'dir' }));
    expect(untag(await r.list({ ref: '@main/dir', depth: 1 }))).toEqual(
      await store.list({ folder: 'dir', depth: 1 })
    );
    expect(untag(await r.list({ ref: '@main', tags: ['tag'] }))).toEqual(
      await store.list({ tags: ['tag'] })
    );
    const first = await store.list({ limit: 2 });
    expect(untag(await r.list({ ref: '@main', limit: 2 }))).toEqual(first);
    expect(untag(await r.list({ ref: '@main', limit: 2, cursor: first.nextCursor }))).toEqual(
      await store.list({ limit: 2, cursor: first.nextCursor })
    );
  });

  it('search matches, including the paging cursor', async () => {
    expect(untag(await r.search({ query: 'zebra', folder: '@main' }))).toEqual(
      await store.search({ query: 'zebra' })
    );
    expect(untag(await r.search({ query: 'nothinghere', folder: '@main' }))).toEqual(
      await store.search({ query: 'nothinghere' })
    );
    const first = await store.search({ query: 'zebra', limit: 1 });
    expect(untag(await r.search({ query: 'zebra', folder: '@main', limit: 1 }))).toEqual(first);
    expect(
      untag(await r.search({ query: 'zebra', folder: '@main', limit: 1, cursor: first.nextCursor }))
    ).toEqual(await store.search({ query: 'zebra', limit: 1, cursor: first.nextCursor }));
    expect(untag(await r.search({ query: 'zebra', folder: '@main/dir' }))).toEqual(
      await store.search({ query: 'zebra', folder: 'dir' })
    );
  });

  it('keeps the store cursor when a vault has more hits than one fan-out page', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      path: `n${String(i).padStart(2, '0')}.md`,
      body: 'zebra',
    }));
    const big = await world({ main: many }, { over: { vaults: new Set(['main']) } });
    const bigStore = await big.direct('main');
    const router = createRouter(big.container, big.access);
    const direct = await bigStore.search({ query: 'zebra', limit: 50 });
    expect(direct.nextCursor).toBeDefined();
    expect(untag(await router.search({ query: 'zebra', folder: '@main', limit: 50 }))).toEqual(
      direct
    );
  });

  it('mutating verbs match a directly-driven store, results and events alike', async () => {
    const other = await solo();
    const oracle = await other.direct('main');
    const seen: StoreEvent[] = [];
    const mine: StoreEvent[] = [];
    store.subscribe((e) => mine.push(e));
    oracle.subscribe((e) => seen.push(e));
    const author = { id: 'claude-desktop', name: 'Claude' };

    expect(untag(await r.write('@main/n.md', { body: 'note' }, author))).toEqual(
      await oracle.write({ path: 'n.md', body: 'note' }, author)
    );
    expect(untag(await r.write('@main/n.md', { body: 'note', frontmatter: { k: 1 } }))).toEqual(
      await oracle.write({ path: 'n.md', body: 'note', frontmatter: { k: 1 } })
    );
    expect(untag(await r.edit('@main/n.md', { mode: 'append', body: 'more' }, author))).toEqual(
      await oracle.edit({ path: 'n.md', mode: 'append', body: 'more' }, author)
    );
    expect(await r.edit('@main/missing.md', { mode: 'append', body: 'x' })).toEqual(
      await oracle.edit({ path: 'missing.md', mode: 'append', body: 'x' })
    );
    expect(await r.delete('@main/n.md')).toEqual(await oracle.delete('n.md'));
    expect(await r.delete('@main/n.md')).toEqual(await oracle.delete('n.md'));
    expect(mine).toEqual(seen); // events carry in-vault paths, never the tag
    expect(untag(await r.list({ ref: '@main' }))).toEqual(await oracle.list({}));
  });

  it('tags every emitted path even when one vault is granted', async () => {
    const written = await r.write('@main/fresh.md', { body: 'zebra' });
    expect(written.path).toBe('@main/fresh.md');
    expect((await r.read('@main/fresh.md'))?.path).toBe('@main/fresh.md');
    expect((await r.list({ ref: '@main/dir' })).entries.map((e) => e.path)).toEqual([
      '@main/dir/deep',
      '@main/dir/b.md',
    ]);
    const hits = await r.search({ query: 'zebra' });
    expect(hits.results.length).toBeGreaterThan(0);
    expect(hits.results.every((h) => h.path.startsWith('@main/'))).toBe(true);
    expect((await r.list({})).entries.map((e) => e.path)).toEqual(['@main']);
  });
});
