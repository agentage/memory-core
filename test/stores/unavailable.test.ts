// "Not there" and "could not answer" are different facts - one is a 404, the
// other a 503. These drive the runner into each infrastructure failure class
// (missing binary, killed spawn, unreadable repo) and assert it never degrades
// to null/empty, while every legitimate not-found still reads as null/false.

import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBareGitStore, StoreError, storeErrorCode } from '../../src/index.js';
import { createGitRunner } from '../../src/stores/bare-git/git-run.js';

const newRepo = async (prefix: string): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), prefix)), 'vault.git');

// PATH is the one value the hermetic runner inherits - emptying it is exactly
// what a container without git installed looks like.
const withPath = async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
  const saved = process.env.PATH;
  process.env.PATH = path;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
  }
};

const stubGitDir = async (script: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'stub-git-'));
  await writeFile(join(dir, 'git'), script, 'utf8');
  await chmod(join(dir, 'git'), 0o755);
  return dir;
};

// chmod is a no-op for root, so the EACCES case can only run unprivileged.
const asRoot = process.getuid?.() === 0;

describe('unavailable: infrastructure failure never reads as not-found', () => {
  it('a missing git binary throws unavailable on every verb, cause preserved', async () => {
    const repo = await newRepo('no-binary-');
    const store = createBareGitStore(repo);
    await store.write({ path: 'a.md', body: 'seeded' });

    await withPath(join(tmpdir(), 'no-git-here'), async () => {
      const err = await store.read('a.md').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StoreError);
      expect(storeErrorCode(err)).toBe('unavailable');
      expect((err as StoreError).message).toMatch(/unavailable/);
      expect(((err as StoreError).cause as NodeJS.ErrnoException).code).toBe('ENOENT');

      await expect(store.write({ path: 'b.md', body: 'x' })).rejects.toMatchObject({
        code: 'unavailable',
      });
      await expect(store.list({})).rejects.toMatchObject({ code: 'unavailable' });
      await expect(store.search({ query: 'seeded' })).rejects.toMatchObject({
        code: 'unavailable',
      });
      await expect(store.describe()).rejects.toMatchObject({ code: 'unavailable' });
    });

    expect((await store.read('a.md'))!.body).toBe('seeded'); // binary back = answers again
  });

  it('a spawn killed by the timeout is unavailable, and tryRun does not swallow it', async () => {
    const repo = await newRepo('timeout-');
    await createBareGitStore(repo).write({ path: 'a.md', body: 'x' });
    // A builtin read on the still-open stdin pipe hangs with no child of its own
    // (nothing to linger on the stdout pipe) and needs nothing else on PATH.
    const stub = await stubGitDir('#!/bin/sh\nread hang\n');

    await withPath(stub, async () => {
      const runner = createGitRunner(repo);
      const err = await runner
        .run(['ls-tree', 'HEAD'], { timeoutMs: 200 })
        .catch((e: unknown) => e);
      expect(storeErrorCode(err)).toBe('unavailable');
      await expect(runner.tryRun(['ls-tree', 'HEAD'], { timeoutMs: 200 })).rejects.toMatchObject({
        code: 'unavailable',
      });
    });
  });

  it('a spawn killed by the byte cap is unavailable, not an empty result', async () => {
    const repo = await newRepo('bytecap-');
    const store = createBareGitStore(repo);
    await store.write({ path: 'a.md', body: 'x' });
    await store.write({ path: 'notes/b.md', body: 'y' });

    const runner = createGitRunner(repo);
    const version = (await runner.readVersion())!;
    const err = await runner
      .run(['ls-tree', '-r', '--name-only', version], { maxBufferBytes: 2 })
      .catch((e: unknown) => e);
    expect(storeErrorCode(err)).toBe('unavailable');
    await expect(runner.batchRead(version, ['a.md'])).resolves.toBeInstanceOf(Map); // cap is per-call
  });

  it.runIf(!asRoot)('an unreadable repo dir is unavailable, not an empty vault', async () => {
    const repo = await newRepo('eacces-');
    const store = createBareGitStore(repo);
    await store.write({ path: 'a.md', body: 'secret' });

    await chmod(repo, 0o000);
    try {
      await expect(store.version()).rejects.toMatchObject({ code: 'unavailable' });
      await expect(store.read('a.md')).rejects.toMatchObject({ code: 'unavailable' });
      // The batch reader too: cat-file reports misses in-band, so a non-zero exit
      // is the repo being unreadable, never a missing doc.
      await expect(createGitRunner(repo).batchRead('HEAD', ['a.md'])).rejects.toMatchObject({
        code: 'unavailable',
      });
    } finally {
      await chmod(repo, 0o700);
    }
    expect((await store.read('a.md'))!.body).toBe('secret');
  });

  it('a repo that cannot be created is unavailable, not a bad request', async () => {
    const repo = await newRepo('no-init-');
    const store = createBareGitStore(repo);
    await withPath(join(tmpdir(), 'no-git-here'), async () => {
      const err = await store.write({ path: 'a.md', body: 'x' }).catch((e: unknown) => e);
      expect(storeErrorCode(err)).toBe('unavailable');
    });
  });
});

describe('unavailable: the not-found paths still answer null/false', () => {
  it('an empty vault is a null version and zero facts, never an error', async () => {
    const store = createBareGitStore(await newRepo('empty-'));
    expect(await store.version()).toBeNull();
    expect(await store.read('nope.md')).toBeNull();
    expect(await store.delete('nope.md')).toBe(false);
    expect(await store.edit({ path: 'nope.md', body: 'x', mode: 'replace' })).toBeNull();
    expect(await store.describe()).toMatchObject({ files: 0, version: null });
    expect((await store.list({})).files).toBe(0);
  });

  it('a live vault still says no for a missing doc and a search with no match', async () => {
    const store = createBareGitStore(await newRepo('present-'));
    await store.write({ path: 'a.md', body: 'hello world' });
    expect(await store.read('missing.md')).toBeNull();
    expect(await store.delete('missing.md')).toBe(false);
    expect(await store.edit({ path: 'missing.md', body: 'x', mode: 'replace' })).toBeNull();
    // git grep exits 1 with no match - a git answer, not a failure to run.
    expect((await store.search({ query: 'zzz-absent-token' })).results).toEqual([]);
    expect((await store.search({ query: 'hello' })).results).toHaveLength(1);
  });

  it('a missing object keeps reading as not-found, not as unavailable', async () => {
    const repo = await newRepo('missing-obj-');
    const store = createBareGitStore(repo);
    await store.write({ path: 'a.md', body: 'x' });
    const runner = createGitRunner(repo);
    expect(await runner.batchRead('HEAD', ['ghost.md'])).toEqual(new Map());
    expect(await runner.tryRun(['ls-tree', '-r', '--name-only', '0'.repeat(40)])).toBeNull();
  });
});
