// Lifecycle: what the container does to the disk (create/remove) and what it
// must never do (provision on a read path), plus the live-object contract it
// borrows from the composition root's cache.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryStore, ObjectCache, type VaultStore } from '../../src/index.js';
import { access, containerAt, makeRoot, mkdirp, treeOf } from './harness.js';

describe('container lifecycle', () => {
  it('open() and list() never create anything - the tree is untouched', async () => {
    const root = await makeRoot();
    const container = containerAt(root);
    const a = access({ vaults: '*' });
    await container.create(a, 'main');
    const before = await treeOf(root);

    await expect(container.open(a, 'ghost')).rejects.toMatchObject({ code: 'unknown_vault' });
    expect(await container.list(a)).toEqual(['main']);
    expect(await container.list(access({ userId: 'nobody22', vaults: '*' }))).toEqual([]);
    await expect(container.open(access(), 'work')).rejects.toMatchObject({
      code: 'unknown_vault',
    });

    expect(await treeOf(root)).toEqual(before);
    expect(JSON.stringify(await treeOf(root))).toBe(JSON.stringify(before));
  });

  it('create is idempotent: one repo, one live object, one provision', async () => {
    const root = await makeRoot();
    let provisions = 0;
    const container = containerAt(root, {
      provision: async (dir) => {
        provisions++;
        await mkdirp(dir);
      },
    });
    const a = access();
    const first = await container.create(a, 'main');
    expect(await container.create(a, 'main')).toBe(first);
    expect(provisions).toBe(1);
    expect(await readdir(join(root, 'alice01'))).toEqual(['main.git']);
    expect(await container.list(a)).toEqual(['main']);
  });

  it('the same vault resolves to the same live object; different vaults do not', async () => {
    const container = containerAt(await makeRoot());
    const alice = access({ vaults: '*' });
    const bob = access({ userId: 'bob02', vaults: '*' });
    const main = await container.create(alice, 'main');
    const work = await container.create(alice, 'work');
    const bobMain = await container.create(bob, 'main');

    expect(await container.open(alice, 'main')).toBe(main);
    expect(await container.open(alice, 'main')).toBe(main);
    expect(work).not.toBe(main);
    expect(bobMain).not.toBe(main);
  });

  it('stays bounded at the cache max, disposes what it evicts, and rebuilds it', async () => {
    const root = await makeRoot();
    const disposed: string[] = [];
    const cache = new ObjectCache<VaultStore>({ max: 2, dispose: (_s, key) => disposed.push(key) });
    const container = containerAt(root, { cache });
    const a = access({ vaults: '*' });

    const first = await container.create(a, 'v1');
    for (const v of ['v2', 'v3', 'v4']) await container.create(a, v);
    expect(cache.size).toBe(2);
    expect(disposed).toEqual(['alice01/v1', 'alice01/v2']);

    const again = await container.open(a, 'v1'); // evicted, not deleted - the slow path rebuilds
    expect(again).not.toBe(first);
    expect(cache.size).toBe(2);
    expect(await container.list(a)).toEqual(['v1', 'v2', 'v3', 'v4']);
  });

  it('remove tombstones the repo and disposes the live object', async () => {
    const root = await makeRoot();
    const disposed: string[] = [];
    const cache = new ObjectCache<VaultStore>({ max: 8, dispose: (_s, key) => disposed.push(key) });
    const container = containerAt(root, { cache });
    const a = access({ vaults: '*' });
    const store = await container.create(a, 'main');
    await store.write({ path: 'note.md', body: 'before' });

    expect(await container.remove(a, 'main', '20260819T101500Z')).toBe(true);
    expect(disposed).toEqual(['alice01/main']);
    expect(cache.size).toBe(0);
    expect(await container.list(a)).toEqual([]);
    await expect(container.open(a, 'main')).rejects.toMatchObject({ code: 'unknown_vault' });
    expect(await readdir(join(root, 'alice01'))).toEqual(['main.deleted-20260819T101500Z.git']);

    const fresh = await container.create(a, 'main');
    expect(fresh).not.toBe(store);
    expect(await fresh.read('note.md')).toBeNull();
    expect(await container.list(a)).toEqual(['main']);
  });

  it('remove of a vault that is not there is false, not an error', async () => {
    const container = containerAt(await makeRoot());
    expect(await container.remove(access({ vaults: '*' }), 'never-existed', 's1')).toBe(false);
  });

  it('the composition root owns the event tap and its cleanup', async () => {
    const root = await makeRoot();
    const seen: Array<[string, string]> = [];
    const offs = new Map<VaultStore, () => void>();
    const cache = new ObjectCache<VaultStore>({ max: 8, dispose: (s) => offs.get(s)?.() });
    const container = containerAt(root, {
      cache,
      store: (dir): VaultStore => {
        const s = createMemoryStore();
        offs.set(
          s,
          s.subscribe((e) => seen.push([dir.split('/').slice(-2).join('/'), e.type]))
        );
        return s;
      },
    });
    const a = access({ vaults: '*' });
    const one = await container.create(a, 'one');
    await one.write({ path: 'a.md', body: 'x' });
    await (await container.create(a, 'two')).write({ path: 'b.md', body: 'y' });
    await one.delete('a.md');
    expect(seen).toEqual([
      ['alice01/one.git', 'write'],
      ['alice01/two.git', 'write'],
      ['alice01/one.git', 'delete'],
    ]);

    await container.remove(a, 'one', 's1'); // dispose detaches the tap
    await one.write({ path: 'c.md', body: 'z' });
    expect(seen).toHaveLength(3);
  });
});
