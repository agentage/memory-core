// Containment: hostile ids never become path segments, and a grant - even '*' -
// can never reach across users.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isSafeSegment, type VaultContainer } from '../../src/index.js';
import { access, containerAt, HOSTILE_IDS, makeRoot, treeOf } from './harness.js';

describe('container containment', () => {
  let root: string;
  let container: VaultContainer;

  beforeEach(async () => {
    root = await makeRoot();
    container = containerAt(root);
  });

  it('refuses every hostile id on the userId, on every verb', async () => {
    for (const bad of HOSTILE_IDS) {
      const a = access({ userId: bad, vaults: '*' });
      await expect(container.list(a), bad).rejects.toMatchObject({ code: 'invalid_path' });
      await expect(container.open(a, 'main'), bad).rejects.toMatchObject({ code: 'invalid_path' });
      await expect(container.create(a, 'main'), bad).rejects.toMatchObject({
        code: 'invalid_path',
      });
      await expect(container.remove(a, 'main', 's1'), bad).rejects.toMatchObject({
        code: 'invalid_path',
      });
    }
  });

  it('refuses every hostile id on the vault, on every verb', async () => {
    const a = access({ vaults: '*' });
    for (const bad of HOSTILE_IDS) {
      await expect(container.open(a, bad), bad).rejects.toMatchObject({ code: 'invalid_path' });
      await expect(container.create(a, bad), bad).rejects.toMatchObject({ code: 'invalid_path' });
      await expect(container.remove(a, bad, 's1'), bad).rejects.toMatchObject({
        code: 'invalid_path',
      });
    }
    expect(await treeOf(root)).toEqual([]); // nothing hostile ever reached the disk
  });

  it('refuses a stamp that could escape the layout', async () => {
    const a = access({ vaults: '*' });
    await container.create(a, 'main');
    for (const stamp of ['', 'a/b', '../up', '..', 'x'.repeat(65), 'a\\b', 'sp ace']) {
      await expect(container.remove(a, 'main', stamp), stamp).rejects.toMatchObject({
        code: 'invalid_path',
      });
    }
    expect(await readdir(join(root, 'alice01'))).toEqual(['main.git']);
  });

  it('a wildcard grant is still scoped to its own user', async () => {
    const alice = access({ userId: 'alice01', vaults: '*' });
    const bob = access({ userId: 'bob02', vaults: '*' });
    const bobStore = await container.create(bob, 'secrets');
    await bobStore.write({ path: 'x.md', body: 'bob only' });

    expect(await container.list(alice)).toEqual([]);
    await expect(container.open(alice, 'secrets')).rejects.toMatchObject({ code: 'unknown_vault' });
    expect(await container.list(bob)).toEqual(['secrets']);
  });

  it('same vault name under two users is two vaults', async () => {
    const alice = access({ userId: 'alice01' });
    const bob = access({ userId: 'bob02' });
    const a = await container.create(alice, 'main');
    const b = await container.create(bob, 'main');
    expect(a).not.toBe(b);
    await a.write({ path: 'me.md', body: 'alice notes' });
    expect(await b.read('me.md')).toBeNull();
    expect(await treeOf(root)).toEqual([
      'alice01/',
      'alice01/main.git/',
      'bob02/',
      'bob02/main.git/',
    ]);
  });

  it('tombstone names can never be addressed as a vault', () => {
    expect(isSafeSegment('main.deleted-20260819T101500Z')).toBe(false);
    expect(isSafeSegment('main')).toBe(true);
  });
});
