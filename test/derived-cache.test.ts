import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDerivedCache, type DerivedView } from '../src/contract/derived.js';
import type { VaultStore } from '../src/contract/vault-store.js';
import { createBareGitStore, createMemoryStore } from '../src/index.js';
import { createStatsView } from '../src/stores/bare-git/stats-view.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

describe('derived cache', () => {
  let store: VaultStore;
  let dir: string;
  let computes: number;

  const countView = (
    policy: DerivedView<number>['policy'],
    patch?: DerivedView<number>['patch']
  ): DerivedView<number> => ({
    name: 'file-count',
    policy,
    compute: async (reader) => {
      computes++;
      return (await reader.list({})).files;
    },
    patch,
  });

  beforeEach(async () => {
    store = createMemoryStore();
    dir = await mkdtemp(join(tmpdir(), 'derived-'));
    computes = 0;
    await store.write({ path: 'a.md', body: 'one' });
  });

  it('computes once and serves from cache while the version holds', async () => {
    const cache = createDerivedCache(store, dir);
    const view = countView({ recompute: 'on-stale' });
    expect(await cache.get(view)).toBe(1);
    expect(await cache.get(view)).toBe(1);
    expect(computes).toBe(1);
  });

  it('recomputes after the version moves', async () => {
    const cache = createDerivedCache(store, dir);
    const view = countView({ recompute: 'on-stale' });
    await cache.get(view);
    await store.write({ path: 'b.md', body: 'two' });
    expect(await cache.get(view)).toBe(2);
    expect(computes).toBe(2);
  });

  it('on-change + patch stays fresh from events without recompute', async () => {
    const cache = createDerivedCache(store, dir);
    const view = countView({ recompute: 'on-change' }, (prev, e) =>
      e.type === 'delete'
        ? prev - e.paths.length
        : e.type === 'write'
          ? prev + e.paths.length
          : prev
    );
    expect(await cache.get(view)).toBe(1);
    await store.write({ path: 'b.md', body: 'two' });
    await tick(); // patch is fire-and-forget
    expect(await cache.get(view)).toBe(2);
    expect(computes).toBe(1); // never recomputed - patched
  });

  it('ttl expires an entry even when the version is unchanged', async () => {
    const cache = createDerivedCache(store, dir);
    const view = countView({ recompute: 'on-stale', ttlMs: 5 });
    await cache.get(view);
    await tick();
    await cache.get(view);
    expect(computes).toBe(2);
  });

  it('manual policy serves stale until recompute() is called', async () => {
    const cache = createDerivedCache(store, dir);
    const view = countView({ recompute: 'manual' });
    expect(await cache.get(view)).toBe(1);
    await store.write({ path: 'b.md', body: 'two' });
    expect(await cache.get(view)).toBe(1); // deliberately stale
    expect(await cache.recompute(view)).toBe(2);
    expect(await cache.get(view)).toBe(2);
  });

  it('persists across cache instances (no recompute when fresh)', async () => {
    const first = createDerivedCache(store, dir);
    await first.get(countView({ recompute: 'on-stale' }));
    first.close();
    const second = createDerivedCache(store, dir);
    expect(await second.get(countView({ recompute: 'on-stale' }))).toBe(1);
    expect(computes).toBe(1);
  });

  it('is disposable: deleting the cache dir just causes a rebuild', async () => {
    const cache = createDerivedCache(store, dir);
    await cache.get(countView({ recompute: 'on-stale' }));
    await cache.invalidate();
    expect(await cache.get(countView({ recompute: 'on-stale' }))).toBe(1);
    expect(computes).toBe(2);
  });

  it('discards a corrupt or tampered cache file instead of trusting it', async () => {
    await writeFile(join(dir, 'file-count.json'), 'not json {{{', 'utf8');
    const cache = createDerivedCache(store, dir);
    expect(await cache.get(countView({ recompute: 'on-stale' }))).toBe(1);
    expect(computes).toBe(1);
  });

  it('rejects unsafe view names', async () => {
    const cache = createDerivedCache(store, dir);
    const bad = { ...countView({ recompute: 'manual' }), name: '../escape' };
    await expect(cache.get(bad)).rejects.toThrow(/invalid view name/);
  });
});

describe('bare-git stats view', () => {
  it('reports true byte sizes and refreshes after external changes', async () => {
    const base = await mkdtemp(join(tmpdir(), 'stats-'));
    const repo = join(base, 'v.git');
    const store = createBareGitStore(repo);
    const cache = createDerivedCache(store, join(base, '.cache'));
    const view = createStatsView(repo);

    expect(await cache.get(view)).toMatchObject({ files: 0, empty: true });
    await store.write({ path: 'notes/a.md', body: '12345' });
    await store.write({ path: 'b.md', body: '123' });
    const stats = await cache.get(view);
    expect(stats).toMatchObject({ files: 2, folders: 1, sizeBytes: 8, empty: false });

    await store.delete('b.md');
    expect(await cache.get(view)).toMatchObject({ files: 1, sizeBytes: 5 });
    await rm(base, { recursive: true, force: true });
  });
});
