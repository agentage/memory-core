// The production wiring: bare-git stores over <root>/<userId>/<vault>.git, with
// ensureBareRepo as the provision hook. Proves the layout on real disk.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBareGitStore,
  createVaultContainer,
  ensureBareRepo,
  ObjectCache,
  REPO_SUFFIX,
  tombstoneRepoDir,
  userDir,
  vaultRepoDir,
  type Access,
  type VaultStore,
} from '../../src/index.js';
import { access, HOSTILE_IDS, makeRoot } from './harness.js';

describe('container over bare git repos', () => {
  it('lays out <root>/<userId>/<vault>.git, isolates users, tombstones on remove', async () => {
    const root = await makeRoot();
    const container = createVaultContainer({
      root,
      store: (dir) => createBareGitStore(dir),
      provision: ensureBareRepo,
      cache: new ObjectCache<VaultStore>({ max: 16 }),
    });
    const alice: Access = access({ vaults: '*' });
    const bob: Access = access({ userId: 'bob02', vaults: '*' });

    const aliceMain = await container.create(alice, 'main');
    await aliceMain.write({ path: 'me.md', body: 'alice notes' });
    await (await container.create(bob, 'main')).write({ path: 'me.md', body: 'bob notes' });
    expect(existsSync(join(root, 'alice01', 'main.git', 'HEAD'))).toBe(true);
    expect((await (await container.open(alice, 'main')).read('me.md'))!.body).toBe('alice notes');
    expect((await (await container.open(bob, 'main')).read('me.md'))!.body).toBe('bob notes');

    // provision alone yields a real, empty, addressable vault - no seed write needed
    await container.create(alice, 'fresh');
    expect(await (await container.open(alice, 'fresh')).version()).toBeNull();
    expect(await container.list(alice)).toEqual(['fresh', 'main']);

    expect(await container.remove(alice, 'main', '20260819T101500Z')).toBe(true);
    expect(await container.list(alice)).toEqual(['fresh']);
    expect(existsSync(join(root, 'alice01', 'main.deleted-20260819T101500Z.git', 'HEAD'))).toBe(
      true
    );
    const recreated = await container.create(alice, 'main');
    expect(await recreated.read('me.md')).toBeNull(); // the name is free, the history is not reused
    expect((await (await container.open(bob, 'main')).read('me.md'))!.body).toBe('bob notes');
  });

  // The same helpers the container uses, exported so a host addresses the layout
  // by name instead of re-deriving it - and never gets a path from a bad name.
  it('the layout helpers state that same layout, and refuse hostile segments', async () => {
    const root = await makeRoot();
    expect(REPO_SUFFIX).toBe('.git');
    expect(userDir(root, 'alice01')).toBe(join(root, 'alice01'));
    expect(vaultRepoDir(root, 'alice01', 'main')).toBe(join(root, 'alice01', 'main.git'));
    expect(tombstoneRepoDir(root, 'alice01', 'main', '20260819T101500Z')).toBe(
      join(root, 'alice01', 'main.deleted-20260819T101500Z.git')
    );

    // what the container writes IS what the helper computes
    const container = createVaultContainer({
      root,
      store: (dir) => createBareGitStore(dir),
      provision: ensureBareRepo,
      cache: new ObjectCache<VaultStore>({ max: 4 }),
    });
    const alice: Access = access({ vaults: '*' });
    await container.create(alice, 'main');
    expect(existsSync(join(vaultRepoDir(root, 'alice01', 'main'), 'HEAD'))).toBe(true);
    await container.remove(alice, 'main', 's1');
    expect(existsSync(join(tombstoneRepoDir(root, 'alice01', 'main', 's1'), 'HEAD'))).toBe(true);

    for (const bad of HOSTILE_IDS) {
      expect(() => userDir(root, bad), bad).toThrow(
        expect.objectContaining({ code: 'invalid_path' })
      );
      expect(() => vaultRepoDir(root, 'alice01', bad), bad).toThrow(
        expect.objectContaining({ code: 'invalid_path' })
      );
      expect(() => vaultRepoDir(root, bad, 'main'), bad).toThrow(
        expect.objectContaining({ code: 'invalid_path' })
      );
    }
    // stamps carry timestamps, so they allow dots and colons - but never a path
    for (const stamp of ['', 'a/b', '../up', '..', 'x'.repeat(65), 'a\\b', 'sp ace']) {
      expect(() => tombstoneRepoDir(root, 'alice01', 'main', stamp), stamp).toThrow(
        expect.objectContaining({ code: 'invalid_path' })
      );
    }
  });
});
