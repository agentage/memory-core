// One granted vault = full transparency. The router is then a pass-through: no
// @ prefix is required going in, none is ever emitted coming out, and every verb
// returns exactly what calling the store directly returns - same values, same
// cursors, same events. A consumer that gains a second vault later changes its
// output; a single-vault consumer must not be able to tell the router is there.

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

describe('router single-vault transparency', () => {
  let w: World;
  let r: Router;
  let store: VaultStore;

  beforeEach(async () => {
    w = await solo();
    r = createRouter(w.container, w.access);
    store = await w.direct('main');
  });

  it('read is identical, hit and miss, clamped and unclamped', async () => {
    expect(await r.read('a.md')).toEqual(await store.read('a.md'));
    expect(await r.read('a.md', { clamp: false })).toEqual(
      await store.read('a.md', { clamp: false })
    );
    expect(await r.read('dir/b.md')).toEqual(await store.read('dir/b.md'));
    expect(await r.read('missing.md')).toEqual(await store.read('missing.md'));
  });

  it('list is identical across folder, depth, tags and cursor paging', async () => {
    expect(await r.list({})).toEqual(await store.list({}));
    expect(await r.list({ ref: 'dir' })).toEqual(await store.list({ folder: 'dir' }));
    expect(await r.list({ ref: 'dir', depth: 1 })).toEqual(
      await store.list({ folder: 'dir', depth: 1 })
    );
    expect(await r.list({ tags: ['tag'] })).toEqual(await store.list({ tags: ['tag'] }));
    const first = await store.list({ limit: 2 });
    expect(await r.list({ limit: 2 })).toEqual(first);
    expect(await r.list({ limit: 2, cursor: first.nextCursor })).toEqual(
      await store.list({ limit: 2, cursor: first.nextCursor })
    );
  });

  it('search is identical, including the paging cursor', async () => {
    expect(await r.search({ query: 'zebra' })).toEqual(await store.search({ query: 'zebra' }));
    expect(await r.search({ query: 'nothinghere' })).toEqual(
      await store.search({ query: 'nothinghere' })
    );
    const first = await store.search({ query: 'zebra', limit: 1 });
    expect(await r.search({ query: 'zebra', limit: 1 })).toEqual(first);
    expect(await r.search({ query: 'zebra', limit: 1, cursor: first.nextCursor })).toEqual(
      await store.search({ query: 'zebra', limit: 1, cursor: first.nextCursor })
    );
    expect(await r.search({ query: 'zebra', folder: 'dir' })).toEqual(
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
    expect(await router.search({ query: 'zebra', limit: 50 })).toEqual(direct);
  });

  it('accepts an explicit @vault ref for the one vault and still emits bare paths', async () => {
    expect(await r.read('@main/a.md')).toEqual(await store.read('a.md'));
    expect(await r.list({ ref: '@main/dir' })).toEqual(await store.list({ folder: 'dir' }));
    expect(await r.search({ query: 'zebra', folder: '@main/dir' })).toEqual(
      await store.search({ query: 'zebra', folder: 'dir' })
    );
    const written = await r.write('@main/tagged.md', { body: 'x' });
    expect(written.path).toBe('tagged.md');
  });

  it('mutating verbs match a directly-driven store, results and events alike', async () => {
    const other = await solo();
    const oracle = await other.direct('main');
    const seen: StoreEvent[] = [];
    const mine: StoreEvent[] = [];
    store.subscribe((e) => mine.push(e));
    oracle.subscribe((e) => seen.push(e));
    const author = { id: 'claude-desktop', name: 'Claude' };

    expect(await r.write('n.md', { body: 'note' }, author)).toEqual(
      await oracle.write({ path: 'n.md', body: 'note' }, author)
    );
    expect(await r.write('n.md', { body: 'note', frontmatter: { k: 1 } })).toEqual(
      await oracle.write({ path: 'n.md', body: 'note', frontmatter: { k: 1 } })
    );
    expect(await r.edit('n.md', { mode: 'append', body: 'more' }, author)).toEqual(
      await oracle.edit({ path: 'n.md', mode: 'append', body: 'more' }, author)
    );
    expect(await r.edit('missing.md', { mode: 'append', body: 'x' })).toEqual(
      await oracle.edit({ path: 'missing.md', mode: 'append', body: 'x' })
    );
    expect(await r.delete('n.md')).toEqual(await oracle.delete('n.md'));
    expect(await r.delete('n.md')).toEqual(await oracle.delete('n.md'));
    expect(mine).toEqual(seen);
    expect(await r.list({})).toEqual(await oracle.list({}));
  });

  it('emits no @ anywhere in a single-vault response', async () => {
    await r.write('fresh.md', { body: 'zebra' });
    const payload = JSON.stringify([
      await r.read('fresh.md'),
      await r.list({}),
      await r.list({ ref: 'dir' }),
      await r.search({ query: 'zebra' }),
    ]);
    expect(payload).not.toContain('@');
  });
});
