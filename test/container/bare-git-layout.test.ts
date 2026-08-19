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
  type Access,
  type VaultStore,
} from '../../src/index.js';
import { access, makeRoot } from './harness.js';

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
});
