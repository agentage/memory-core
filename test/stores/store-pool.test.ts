import { execFile } from 'node:child_process';
import { mkdtemp, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleRepo,
  checkRootWritable,
  createBareGitStore,
  createMemoryStore,
  createStorePool,
  destroyRepo,
  listVaultDirs,
  provisionIfEmpty,
  type StoreEvent,
} from '../../src/index.js';

describe('store pool (tenant-blind, storage-blind)', () => {
  it('one live instance per key; keys are opaque', () => {
    let creates = 0;
    const pool = createStorePool({
      create: () => {
        creates++;
        return createMemoryStore();
      },
    });
    const a1 = pool.get('anything at all / even spaces');
    const a2 = pool.get('anything at all / even spaces');
    expect(a1).toBe(a2);
    expect(creates).toBe(1);
  });

  it('LRU-evicts beyond maxOpen and rebuilds lazily', async () => {
    let creates = 0;
    const pool = createStorePool({
      create: () => {
        creates++;
        return createMemoryStore();
      },
      maxOpen: 2,
    });
    pool.get('a');
    pool.get('b');
    pool.get('a'); // refresh a - b is now oldest
    pool.get('c'); // evicts b
    expect(pool.keys()).toEqual(['a', 'c']);
    pool.get('b'); // rebuilt
    expect(creates).toBe(4);
  });

  it('tags every pooled event with its key (the multi-vault audit tap)', async () => {
    const seen: Array<[string, string]> = [];
    const pool = createStorePool({
      create: () => createMemoryStore(),
      onEvent: (key, e: StoreEvent) => seen.push([key, e.type]),
    });
    await pool.get('vault-one').write({ path: 'a.md', body: 'x' });
    await pool.get('vault-two').write({ path: 'b.md', body: 'y' });
    await pool.get('vault-one').delete('a.md');
    expect(seen).toEqual([
      ['vault-one', 'write'],
      ['vault-two', 'write'],
      ['vault-one', 'delete'],
    ]);
    pool.close();
    await pool.get('vault-three'); // resolving after close still works; tap is rebuilt per get
  });

  it('works over git stores with a host-owned layout (rootDir as a function)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pool-git-'));
    const pool = createStorePool({
      // The HOST decides the layout and any tenant semantics - not the pool.
      create: (key) => createBareGitStore(join(root, `${key.replace(/[^a-zA-Z0-9-]/g, '_')}.git`)),
    });
    await pool.get('tenantA:main').write({ path: 'n.md', body: 'isolated' });
    expect(await pool.get('tenantB:main').read('n.md')).toBeNull();
    expect((await pool.get('tenantA:main').read('n.md'))!.body).toBe('isolated');
  });

  it('provisionIfEmpty seeds once, on any store kind', async () => {
    const seed = [{ path: 'welcome.md', body: 'hello' }];
    const mem = createMemoryStore();
    expect(await provisionIfEmpty(mem, seed)).toEqual({ created: true });
    expect(await provisionIfEmpty(mem, seed)).toEqual({ created: false });
    const root = await mkdtemp(join(tmpdir(), 'prov-'));
    const git = createBareGitStore(join(root, 'v.git'));
    expect(await provisionIfEmpty(git, seed)).toEqual({ created: true });
    expect(await provisionIfEmpty(git, seed)).toEqual({ created: false });
    expect((await git.read('welcome.md'))!.body).toBe('hello');
  });
});

describe('git-admin (per-vault, user-blind)', () => {
  it('lists vault dirs, bundles a live repo, null-bundles an empty one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admin-'));
    const full = createBareGitStore(join(root, 'full.git'));
    await full.write({ path: 'a.md', body: 'content' });
    createBareGitStore(join(root, 'evt.git')); // never written - no repo on disk
    await mkdir(join(root, 'empty.git'), { recursive: true });
    expect(await listVaultDirs(root)).toEqual(['empty.git'.slice(0, -4), 'full']);
    const bundle = await bundleRepo(join(root, 'full.git'));
    expect(bundle).toBeInstanceOf(Buffer);
    expect(bundle!.length).toBeGreaterThan(0);
    expect(await bundleRepo(join(root, 'empty.git'))).toBeNull();
  });

  it('bundle round-trips: a clone from the bundle contains the notes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bundle-'));
    const store = createBareGitStore(join(root, 'v.git'));
    await store.write({ path: 'keep/me.md', body: 'portable' });
    const bundle = (await bundleRepo(join(root, 'v.git')))!;
    const bundlePath = join(root, 'v.bundle');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(bundlePath, bundle);
    const cloneDir = join(root, 'clone');
    await new Promise<void>((resolve, reject) =>
      execFile('git', ['clone', '-q', bundlePath, cloneDir], (e) => (e ? reject(e) : resolve()))
    );
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(join(cloneDir, 'keep/me.md'), 'utf8')).toContain('portable');
  });

  it('destroyRepo is containment-checked - never deletes outside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'destroy-'));
    const store = createBareGitStore(join(root, 'gone.git'));
    await store.write({ path: 'x.md', body: 'x' });
    expect(await destroyRepo(join(root, 'gone.git'), { within: root })).toBe(true);
    expect(await destroyRepo(join(root, 'gone.git'), { within: root })).toBe(false); // idempotent
    await expect(destroyRepo(root, { within: root })).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(destroyRepo(join(root, '..', 'sibling'), { within: root })).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(destroyRepo('/etc', { within: root })).rejects.toMatchObject({
      code: 'invalid_path',
    });
  });

  it('checkRootWritable reports reachable/writable honestly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'health-'));
    expect(await checkRootWritable(root)).toEqual({ reachable: true, writable: true });
    expect(await checkRootWritable(join(root, 'missing'))).toEqual({
      reachable: false,
      writable: false,
    });
    const ro = join(root, 'ro');
    await mkdir(ro);
    await chmod(ro, 0o555);
    expect(await checkRootWritable(ro)).toEqual({ reachable: true, writable: false });
    await chmod(ro, 0o755);
  });
});
