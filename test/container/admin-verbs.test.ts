// The two verbs that let a host own no root of its own: export one vault
// (bundle) and erase one account (destroyUser). Both answer to Access first -
// a refusal must never double as a hint that someone else's data is there.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBareGitStore,
  createVaultContainer,
  ensureBareRepo,
  ObjectCache,
  userDir,
  vaultRepoDir,
  type Access,
  type VaultContainer,
  type VaultStore,
} from '../../src/index.js';
import { access, containerAt, HOSTILE_IDS, makeRoot } from './harness.js';

const gitContainer = (
  root: string,
  cache = new ObjectCache<VaultStore>({ max: 16 })
): VaultContainer =>
  createVaultContainer({
    root,
    store: (dir) => createBareGitStore(dir),
    provision: ensureBareRepo,
    cache,
  });

describe('container.bundle', () => {
  it('bundles a granted vault into a clone-able bundle', async () => {
    const root = await makeRoot();
    const container = gitContainer(root);
    const a: Access = access({ vaults: '*' });
    await (await container.create(a, 'main')).write({ path: 'keep/me.md', body: 'portable' });

    const bundle = await container.bundle(a, 'main');
    expect(bundle).toBeInstanceOf(Buffer);
    const bundlePath = join(root, 'main.bundle');
    await writeFile(bundlePath, bundle!);
    const cloneDir = join(root, 'clone');
    await new Promise<void>((resolve, reject) =>
      execFile('git', ['clone', '-q', bundlePath, cloneDir], (e) => (e ? reject(e) : resolve()))
    );
    expect(await readFile(join(cloneDir, 'keep/me.md'), 'utf8')).toContain('portable');
  });

  it('null for an unknown, empty or tombstoned vault - and never another account', async () => {
    const root = await makeRoot();
    const container = gitContainer(root);
    const alice: Access = access({ vaults: '*' });
    const bob: Access = access({ userId: 'bob02', vaults: '*' });

    expect(await container.bundle(alice, 'ghost')).toBeNull(); // never provisioned
    await container.create(alice, 'fresh');
    expect(await container.bundle(alice, 'fresh')).toBeNull(); // provisioned, no commits

    await (await container.create(bob, 'main')).write({ path: 'x.md', body: 'bob only' });
    await (await container.create(alice, 'main')).write({ path: 'x.md', body: 'alice' });
    await container.remove(alice, 'main', 's1');
    expect(await container.bundle(alice, 'main')).toBeNull(); // a tombstone is not addressable
    expect(await container.bundle(bob, 'main')).toBeInstanceOf(Buffer); // bob is untouched
  });

  it('is gated exactly like open: forbidden outside the grant, invalid_path for a hostile name', async () => {
    const root = await makeRoot();
    const container = gitContainer(root);
    const wide: Access = access({ vaults: '*' });
    await (await container.create(wide, 'secret')).write({ path: 'x.md', body: 's' });

    await expect(container.bundle(access(), 'secret')).rejects.toMatchObject({ code: 'forbidden' });
    // the same NAME under another account is another vault - no bytes cross
    expect(await container.bundle(access({ userId: 'bob02', vaults: '*' }), 'secret')).toBeNull();
    for (const bad of HOSTILE_IDS) {
      await expect(container.bundle(wide, bad), bad).rejects.toMatchObject({
        code: 'invalid_path',
      });
      await expect(
        container.bundle(access({ userId: bad, vaults: '*' }), 'secret'),
        bad
      ).rejects.toMatchObject({ code: 'invalid_path' });
    }
  });
});

describe('container.destroyUser', () => {
  it('erases every vault the user owns, tombstones included, and disposes the live objects', async () => {
    const root = await makeRoot();
    const disposed: string[] = [];
    const cache = new ObjectCache<VaultStore>({ max: 8, dispose: (_s, key) => disposed.push(key) });
    const container = containerAt(root, { cache });
    const a = access({ vaults: '*' });
    await container.create(a, 'main');
    await container.create(a, 'work');
    await container.create(a, 'gone');
    await container.remove(a, 'gone', 's1'); // a tombstone must go too
    disposed.length = 0;

    expect(await container.destroyUser(a, 'alice01')).toBe(true);
    expect(disposed.sort()).toEqual(['alice01/main', 'alice01/work']);
    expect(cache.size).toBe(0);
    expect(existsSync(userDir(root, 'alice01'))).toBe(false);
    expect(await container.list(a)).toEqual([]);
    expect(await container.destroyUser(a, 'alice01')).toBe(false); // idempotent
  });

  it('erases only the caller own account, and only with canDelete', async () => {
    const root = await makeRoot();
    const container = containerAt(root);
    const bob = access({ userId: 'bob02', vaults: '*' });
    await container.create(bob, 'main');
    const alice = access({ vaults: '*' });
    await container.create(alice, 'main');

    await expect(container.destroyUser(alice, 'bob02')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(container.destroyUser(alice, 'nobody22')).rejects.toMatchObject({
      code: 'forbidden',
    }); // an account that does not exist reads the same as one that does
    await expect(
      container.destroyUser(access({ canDelete: false, vaults: '*' }), 'alice01')
    ).rejects.toMatchObject({ code: 'forbidden' });
    for (const bad of HOSTILE_IDS) {
      await expect(container.destroyUser(alice, bad), bad).rejects.toMatchObject({
        code: 'invalid_path',
      });
      await expect(
        container.destroyUser(access({ userId: bad, vaults: '*' }), bad),
        bad
      ).rejects.toMatchObject({ code: 'invalid_path' });
    }
    expect(existsSync(vaultRepoDir(root, 'bob02', 'main'))).toBe(true);
    expect(existsSync(vaultRepoDir(root, 'alice01', 'main'))).toBe(true);
  });

  it('an unreadable account dir is unavailable, not a silent erase', async () => {
    const root = await makeRoot();
    const container = containerAt(root);
    const a = access({ vaults: '*' });
    await container.create(a, 'main');
    await chmod(userDir(root, 'alice01'), 0o000);
    try {
      await expect(container.destroyUser(a, 'alice01')).rejects.toMatchObject({
        code: 'unavailable',
      });
    } finally {
      await chmod(userDir(root, 'alice01'), 0o755);
    }
    expect(existsSync(vaultRepoDir(root, 'alice01', 'main'))).toBe(true); // nothing was lost
  });
});
