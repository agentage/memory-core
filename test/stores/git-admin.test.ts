import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundleRepo,
  createBareGitStore,
  destroyRepo,
  ensureBareRepo,
  listVaultDirs,
} from '../../src/index.js';

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

  it('ensureBareRepo makes an addressable empty vault, idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ensure-'));
    const dir = join(root, 'nested', 'v.git');
    await ensureBareRepo(dir);
    await ensureBareRepo(dir);
    expect(existsSync(join(dir, 'HEAD'))).toBe(true);
    expect(await createBareGitStore(dir).version()).toBeNull(); // exists, still empty
    expect(await listVaultDirs(join(root, 'nested'))).toEqual(['v']);
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
});
