// Several granted vaults, one addressable surface: `@vault/` routes in, every
// emitted path carries it back out, list with no ref is the vault directory, and
// search with no folder fans out. The router adds exactly this - refusals come
// from its own permission gate (forbidden), from the store (restricted,
// invalid_path), or are the one message it owns (unknown_vault).

import { beforeEach, describe, expect, it } from 'vitest';
import { StoreError } from '../../src/index.js';
import { createRouter, unknownVaultMessage, type Router } from '../../src/router/router.js';
import { world, type World } from './harness.js';

// The exact text the CLI regex-matches (memory-core parity) - byte-frozen.
const GOLDEN = 'Unknown vault "@ghost". Use memory__list with no folder to see available vaults.';

const seeds = {
  main: [{ path: 'a.md', body: 'main zebra' }],
  work: [
    { path: 'p.md', body: 'work zebra' },
    { path: 'dir/q.md', body: 'nested zebra' },
  ],
  secret: [{ path: 'a.md', body: 'not granted' }],
};

const granted = new Set(['main', 'work', 'ghost']); // ghost is granted but never provisioned

describe('router federation', () => {
  let w: World;
  let r: Router;

  beforeEach(async () => {
    w = await world(seeds, { over: { vaults: granted } });
    r = createRouter(w.container, w.access);
  });

  it('routes every verb by @vault and tags every returned path', async () => {
    const written = await r.write('@work/new.md', { body: 'w' });
    expect(written.path).toBe('@work/new.md');
    const edited = await r.edit('@work/new.md', { mode: 'append', body: 'more' });
    expect(edited?.path).toBe('@work/new.md');
    expect((await r.read('@work/new.md'))?.path).toBe('@work/new.md');
    expect(await r.read('@main/new.md')).toBeNull(); // no cross-vault leak
    expect(await r.delete('@work/new.md')).toBe(true);
    expect(await r.read('@work/new.md')).toBeNull();
  });

  it('fans search out across the granted vaults, tagging each hit', async () => {
    const res = await r.search({ query: 'zebra' });
    expect(res.results.map((h) => h.path).sort()).toEqual([
      '@main/a.md',
      '@work/dir/q.md',
      '@work/p.md',
    ]);
  });

  it('scopes search to one vault with an @folder', async () => {
    const res = await r.search({ query: 'zebra', folder: '@work' });
    expect(res.results.map((h) => h.path).sort()).toEqual(['@work/dir/q.md', '@work/p.md']);
    const deeper = await r.search({ query: 'zebra', folder: '@work/dir' });
    expect(deeper.results.map((h) => h.path)).toEqual(['@work/dir/q.md']);
  });

  it('shows every vault as a top-level @folder at the root', async () => {
    const res = await r.list({});
    expect(res.folder).toBe('');
    expect(res.entries.map((e) => e.path)).toEqual(['@main', '@work']); // ghost is not provisioned
    expect(res.entries.every((e) => e.type === 'folder')).toBe(true);
    expect(res.files).toBe(3);
    const work = res.entries.find((e) => e.path === '@work');
    expect(work).toMatchObject({ type: 'folder', files: 2 });
    expect(work?.type === 'folder' ? work.entries?.map((e) => e.path).sort() : undefined).toEqual([
      '@work/dir',
      '@work/p.md',
    ]);
  });

  it('lists the vaults alone at depth 1', async () => {
    const res = await r.list({ depth: 1 });
    expect(res.entries).toEqual([
      { type: 'folder', path: '@main', files: 1, entries: undefined },
      { type: 'folder', path: '@work', files: 2, entries: undefined },
    ]);
  });

  it('prefixes list entries under an @vault folder', async () => {
    const scoped = await r.list({ ref: '@work/dir' });
    expect(scoped.folder).toBe('@work/dir');
    expect(scoped.entries.map((e) => e.path)).toEqual(['@work/dir/q.md']);
    const vaultRoot = await r.list({ ref: '@work' });
    expect(vaultRoot.folder).toBe('@work');
    expect(vaultRoot.entries.map((e) => e.path).sort()).toEqual(['@work/dir', '@work/p.md']);
  });

  it('refuses an unprefixed ref - there is no default vault', async () => {
    await expect(r.read('a.md')).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(r.write('a.md', { body: 'x' })).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(r.list({ ref: 'dir' })).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(r.search({ query: 'zebra', folder: 'dir' })).rejects.toMatchObject({
      code: 'invalid_path',
    });
  });

  it('refuses a granted-but-absent vault with the frozen CLI message', async () => {
    const err = await r.read('@ghost/x.md').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect(err).toMatchObject({ code: 'unknown_vault' });
    expect((err as StoreError).message).toBe(GOLDEN);
    expect(unknownVaultMessage('ghost')).toBe(GOLDEN);
    // the shape the cli parses out of the message
    expect(/Unknown vault "@([^"]+)"\./.exec((err as StoreError).message)?.[1]).toBe('ghost');
    await expect(r.write('@ghost/x.md', { body: 'x' })).rejects.toMatchObject({
      code: 'unknown_vault',
      message: GOLDEN,
    });
    await expect(r.list({ ref: '@ghost' })).rejects.toMatchObject({ message: GOLDEN });
    expect(w.opened).toEqual([]); // refused before the vault was opened
  });

  it('refuses a vault outside the grant itself, without a container call', async () => {
    const err = await r.read('@secret/a.md').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'forbidden', message: 'no access to vault: secret' });
    expect(w.calls).toEqual([]);
  });

  it('passes store refusals through untouched', async () => {
    await expect(
      r.write('@work/k.md', { body: `api_key: sk-${'a'.repeat(24)}` })
    ).rejects.toMatchObject({ code: 'restricted' });
    await expect(r.write('@work/../escape.md', { body: 'x' })).rejects.toMatchObject({
      code: 'invalid_path',
    });
  });

  it('answers the discovery verbs emptily when the connection has no vault', async () => {
    const empty = await world({}, { over: { vaults: new Set<string>() } });
    const none = createRouter(empty.container, empty.access);
    expect(await none.list({})).toEqual({ folder: '', entries: [], truncated: false, files: 0 });
    expect(await none.search({ query: 'x' })).toEqual({ results: [] });
    await expect(none.read('@main/a.md')).rejects.toMatchObject({ code: 'forbidden' });
  });
});
