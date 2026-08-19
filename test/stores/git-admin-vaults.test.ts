// The tenant lifecycle surface over <root>/<userId>/<vault>.git: existence that
// never provisions, listings a tombstone drops out of, and sweeps that can only
// ever touch one user's dir. Ported from the proven web/store-core behaviour.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBareGitStore,
  deleteUser,
  deleteVault,
  listVaults,
  vaultExists,
} from '../../src/index.js';

// What a caller actually passes: `new Date().toISOString()`.
const STAMP = '2026-08-19T12:00:00.000Z';

const newRoot = (): Promise<string> => mkdtemp(join(tmpdir(), 'vault-admin-'));

const seed = async (root: string, userId: string, vault: string): Promise<void> => {
  const store = createBareGitStore(join(root, userId, `${vault}.git`));
  await store.write({ path: 'a.md', body: `${userId}/${vault}` });
};

describe('vault admin: existence and listing', () => {
  it('vaultExists answers from disk and NEVER provisions', async () => {
    const root = await newRoot();
    expect(await vaultExists(root, 'alice', 'work')).toBe(false);
    expect(existsSync(join(root, 'alice'))).toBe(false); // no lazy materialization

    await seed(root, 'alice', 'work');
    expect(await vaultExists(root, 'alice', 'work')).toBe(true);
    expect(await vaultExists(root, 'alice', 'absent')).toBe(false);
    // Unsafe ids answer false rather than probing anywhere.
    expect(await vaultExists(root, '../bob', 'work')).toBe(false);
    expect(await vaultExists(root, 'alice', '../../etc')).toBe(false);
  });

  it('listVaults is sorted, allowlist-filtered, and empty for a stranger', async () => {
    const root = await newRoot();
    await seed(root, 'alice', 'work');
    await seed(root, 'alice', 'archive');
    await mkdir(join(root, 'alice', 'not a slug.git'), { recursive: true });
    await mkdir(join(root, 'alice', 'loose-dir'), { recursive: true });

    expect(await listVaults(root, 'alice')).toEqual(['archive', 'work']);
    expect(await listVaults(root, 'ghost')).toEqual([]);
    expect(await listVaults(root, '../bob')).toEqual([]);
  });
});

describe('vault admin: deletion', () => {
  it('deleteVault tombstones - invisible to both listings, bytes still on disk', async () => {
    const root = await newRoot();
    await seed(root, 'alice', 'work');
    await seed(root, 'alice', 'keep');

    expect(await deleteVault(root, 'alice', 'work', STAMP)).toEqual({ deleted: true });
    expect(await vaultExists(root, 'alice', 'work')).toBe(false);
    expect(await listVaults(root, 'alice')).toEqual(['keep']);

    // Recoverable: the repo is intact under its tombstone name, a rename away.
    const tomb = `work.deleted-${STAMP}.git`;
    expect(await readdir(join(root, 'alice'))).toContain(tomb);
    expect(existsSync(join(root, 'alice', tomb, 'refs'))).toBe(true);

    expect(await deleteVault(root, 'alice', 'work', STAMP)).toEqual({ deleted: false });
    // The freed name is immediately re-creatable.
    await seed(root, 'alice', 'work');
    expect(await listVaults(root, 'alice')).toEqual(['keep', 'work']);
  });

  it('deleteVault refuses ids and stamps that could leave the user dir', async () => {
    const root = await newRoot();
    await seed(root, 'alice', 'work');
    for (const call of [
      (): Promise<unknown> => deleteVault(root, '../bob', 'work', STAMP),
      (): Promise<unknown> => deleteVault(root, 'alice', '../work', STAMP),
      (): Promise<unknown> => deleteVault(root, 'alice', 'work', '../../escape'),
      (): Promise<unknown> => deleteVault(root, 'alice', 'work', 'a/b'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'invalid_path' });
    }
    expect(await vaultExists(root, 'alice', 'work')).toBe(true);
  });

  it('deleteUser sweeps only that user, is idempotent, and refuses ../bob', async () => {
    const root = await newRoot();
    await seed(root, 'alice', 'work');
    await seed(root, 'alice', 'personal');
    await seed(root, 'bob', 'work');
    await deleteVault(root, 'alice', 'personal', STAMP); // tombstones are swept too

    expect(await deleteUser(root, 'alice')).toEqual({ deleted: true });
    expect(existsSync(join(root, 'alice'))).toBe(false);
    expect(existsSync(join(root, 'bob'))).toBe(true);
    expect(await listVaults(root, 'bob')).toEqual(['work']);

    expect(await deleteUser(root, 'alice')).toEqual({ deleted: false }); // idempotent

    await expect(deleteUser(root, '../bob')).rejects.toThrow(/invalid userId/);
    await expect(deleteUser(root, '../bob')).rejects.toMatchObject({ code: 'invalid_path' });
    expect(existsSync(join(root, 'bob'))).toBe(true);
  });
});
